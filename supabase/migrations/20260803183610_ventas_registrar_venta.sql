-- Registrar una venta es UNA operacion, no siete inserts desde el navegador.
-- Si se pudiera armar por partes, existiria la venta a la que le faltan los pagos,
-- o la que descuento stock y no quedo guardada. Aca o pasa todo o no pasa nada.
create or replace function public.registrar_venta(
  p_sucursal_id uuid,
  p_lineas jsonb,
  p_pagos jsonb,
  p_cliente_id uuid default null,
  p_descuento numeric default 0,
  p_nota text default null,
  p_venta_origen_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_usuario uuid := auth.uid();
  v_venta_id uuid;
  v_numero bigint;
  v_subtotal numeric(12,2) := 0;
  v_recargo_total numeric(12,2) := 0;
  v_base_pagos numeric(12,2) := 0;
  v_total numeric(12,2);
  v_a_cobrar numeric(12,2);
  v_linea jsonb;
  v_pago jsonb;
  v_precio numeric(12,2);
  v_costo numeric(12,2);
  v_cantidad integer;
  v_variante uuid;
  v_medio public.medios_pago%rowtype;
  v_monto_base numeric(12,2);
  v_recargo numeric(12,2);
  v_deuda numeric(12,2) := 0;
begin
  if public.mi_rol() is null then
    raise exception 'Necesitas un usuario activo para vender.';
  end if;
  if not exists (select 1 from public.sucursales where id = p_sucursal_id and activa) then
    raise exception 'La sucursal no existe o esta desactivada.';
  end if;
  if p_lineas is null or jsonb_array_length(p_lineas) = 0 then
    raise exception 'Una venta sin productos no es una venta.';
  end if;
  if coalesce(p_descuento, 0) < 0 then
    raise exception 'El descuento no puede ser negativo.';
  end if;

  -- El numero de ticket se toma bajo lock por sucursal: dos cajas cobrando
  -- al mismo tiempo en el mismo local no pueden sacar el mismo numero.
  perform pg_advisory_xact_lock(hashtext('venta:' || p_sucursal_id::text));
  select coalesce(max(numero), 0) + 1 into v_numero
    from public.ventas where sucursal_id = p_sucursal_id;

  insert into public.ventas (id, numero, sucursal_id, usuario_id, cliente_id,
                             subtotal, descuento, recargo, total, venta_origen_id, nota)
  values (gen_random_uuid(), v_numero, p_sucursal_id, v_usuario, p_cliente_id,
          0, coalesce(p_descuento, 0), 0, 0, p_venta_origen_id, nullif(btrim(coalesce(p_nota,'')), ''))
  returning id into v_venta_id;

  for v_linea in select * from jsonb_array_elements(p_lineas) loop
    v_variante := (v_linea->>'variante_id')::uuid;
    v_cantidad := (v_linea->>'cantidad')::integer;

    if v_cantidad = 0 then
      raise exception 'Una linea con cantidad 0 no significa nada.';
    end if;

    if v_cantidad > 0 then
      -- El precio y el costo salen de la base, no de lo que mande el navegador.
      select precio, costo into v_precio, v_costo
        from public.variantes where id = v_variante and activa;
      if not found then
        raise exception 'El producto no existe o esta desactivado.';
      end if;
    else
      -- Devolucion: vale lo que valia en el ticket original, no lo que vale hoy.
      -- Sin venta de origen no se puede recibir mercaderia: seria regalar plata.
      if p_venta_origen_id is null then
        raise exception 'Para recibir un producto hay que indicar la venta original.';
      end if;
      select l.precio_unitario, l.costo_unitario into v_precio, v_costo
        from public.venta_lineas l
       where l.venta_id = p_venta_origen_id and l.variante_id = v_variante and l.cantidad > 0
       limit 1;
      if not found then
        raise exception 'Ese producto no figura en la venta original.';
      end if;
    end if;

    insert into public.venta_lineas (venta_id, variante_id, cantidad, precio_unitario, costo_unitario)
    values (v_venta_id, v_variante, v_cantidad, v_precio, v_costo);

    v_subtotal := v_subtotal + (v_cantidad * v_precio);

    -- El stock se mueve por el libro mayor. La tabla stock no se escribe nunca.
    insert into public.movimientos_stock (variante_id, sucursal_id, cantidad, motivo, referencia_id, usuario_id)
    values (v_variante, p_sucursal_id, -v_cantidad,
            case when v_cantidad > 0 then 'venta' else 'devolucion' end,
            v_venta_id, v_usuario);
  end loop;

  v_a_cobrar := v_subtotal - coalesce(p_descuento, 0);

  for v_pago in select * from jsonb_array_elements(coalesce(p_pagos, '[]'::jsonb)) loop
    select * into v_medio from public.medios_pago
      where id = (v_pago->>'medio_pago_id')::uuid and activo;
    if not found then
      raise exception 'Ese medio de pago no existe o esta desactivado.';
    end if;

    v_monto_base := round((v_pago->>'monto')::numeric, 2);
    if v_monto_base = 0 then
      raise exception 'Un pago de 0 no es un pago.';
    end if;
    v_recargo := round(v_monto_base * v_medio.recargo_porcentaje / 100, 2);

    if v_medio.es_cuenta_corriente then
      if p_cliente_id is null then
        raise exception 'Para fiar hay que elegir el cliente. Fiarle a nadie es perder la mercaderia.';
      end if;
      v_deuda := v_deuda + v_monto_base + v_recargo;
    end if;

    insert into public.pagos (venta_id, medio_pago_id, monto, recargo)
    values (v_venta_id, v_medio.id, v_monto_base + v_recargo, v_recargo);

    v_base_pagos := v_base_pagos + v_monto_base;
    v_recargo_total := v_recargo_total + v_recargo;
  end loop;

  -- Una venta a la que le falta plata es una venta que nadie va a poder cuadrar.
  if v_base_pagos <> v_a_cobrar then
    raise exception 'Los pagos suman % y la venta es de %. Tienen que coincidir.',
      v_base_pagos, v_a_cobrar;
  end if;

  v_total := v_a_cobrar + v_recargo_total;

  update public.ventas
     set subtotal = v_subtotal, recargo = v_recargo_total, total = v_total
   where id = v_venta_id;

  if v_deuda <> 0 then
    insert into public.movimientos_cuenta (cliente_id, sucursal_id, tipo, monto, venta_id, usuario_id, nota)
    values (p_cliente_id, p_sucursal_id, 'venta', v_deuda, v_venta_id, v_usuario,
            'Ticket ' || v_numero);
  end if;

  return v_venta_id;
end;
$$;

comment on function public.registrar_venta is
  'Unica forma de crear una venta. Congela precio y costo, mueve el stock, cobra y fia, todo en una transaccion.';
