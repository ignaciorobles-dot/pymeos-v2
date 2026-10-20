-- Cuando alguien viene a pagar lo que debe, entra plata al local: P4 (caja)
-- va a necesitar saber con que la pago.
alter table public.movimientos_cuenta
  add column medio_pago_id uuid references public.medios_pago(id);

-- Anular no es borrar. Devuelve el stock, revierte la deuda y deja la venta
-- a la vista con el motivo.
create or replace function public.anular_venta(p_venta_id uuid, p_motivo text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_usuario uuid := auth.uid();
  v_venta public.ventas%rowtype;
  v_linea public.venta_lineas%rowtype;
  v_deuda numeric(12,2);
begin
  if not public.tiene_rol(array['dueno']) then
    raise exception 'Solo un dueno puede anular una venta.';
  end if;
  if btrim(coalesce(p_motivo, '')) = '' then
    raise exception 'Hay que decir por que se anula. Una anulacion sin motivo no se puede auditar.';
  end if;

  select * into v_venta from public.ventas where id = p_venta_id for update;
  if not found then
    raise exception 'Esa venta no existe.';
  end if;
  if v_venta.estado = 'anulada' then
    raise exception 'Esa venta ya estaba anulada.';
  end if;
  if exists (select 1 from public.ventas
              where venta_origen_id = p_venta_id and estado = 'completada') then
    raise exception 'No se puede anular: ya se hizo un cambio contra esta venta. Anula primero el cambio.';
  end if;

  -- Vuelve exactamente lo que salio, en la sucursal donde salio.
  for v_linea in select * from public.venta_lineas where venta_id = p_venta_id loop
    insert into public.movimientos_stock (variante_id, sucursal_id, cantidad, motivo, referencia_id, usuario_id, nota)
    values (v_linea.variante_id, v_venta.sucursal_id, v_linea.cantidad,
            case when v_linea.cantidad > 0 then 'devolucion' else 'venta' end,
            p_venta_id, v_usuario, 'Anulacion ticket ' || v_venta.numero);
  end loop;

  -- La deuda no se borra: se cancela con un movimiento en contra, que queda a la vista.
  select coalesce(sum(monto), 0) into v_deuda
    from public.movimientos_cuenta where venta_id = p_venta_id;
  if v_deuda <> 0 then
    insert into public.movimientos_cuenta (cliente_id, sucursal_id, tipo, monto, venta_id, usuario_id, nota)
    values (v_venta.cliente_id, v_venta.sucursal_id, 'anulacion', -v_deuda, p_venta_id, v_usuario,
            'Anulacion ticket ' || v_venta.numero);
  end if;

  update public.ventas
     set estado = 'anulada', anulada_at = now(), anulada_por = v_usuario,
         motivo_anulacion = btrim(p_motivo)
   where id = p_venta_id;
end;
$$;

comment on function public.anular_venta is
  'Anula una venta devolviendo stock y revirtiendo la deuda. Solo dueno. La venta sigue existiendo.';

-- El cliente viene a pagar lo que debe.
create or replace function public.registrar_pago_cuenta(
  p_cliente_id uuid,
  p_sucursal_id uuid,
  p_monto numeric,
  p_medio_pago_id uuid default null,
  p_nota text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_usuario uuid := auth.uid();
  v_id uuid;
begin
  if public.mi_rol() is null then
    raise exception 'Necesitas un usuario activo para cobrar.';
  end if;
  if not exists (select 1 from public.sucursales where id = p_sucursal_id and activa) then
    raise exception 'La sucursal no existe o esta desactivada.';
  end if;
  if coalesce(p_monto, 0) <= 0 then
    raise exception 'El pago tiene que ser mayor a cero.';
  end if;
  if not exists (select 1 from public.clientes where id = p_cliente_id and activo) then
    raise exception 'Ese cliente no existe o esta desactivado.';
  end if;

  insert into public.movimientos_cuenta (cliente_id, sucursal_id, tipo, monto, usuario_id, medio_pago_id, nota)
  values (p_cliente_id, p_sucursal_id, 'pago', -round(p_monto, 2), v_usuario, p_medio_pago_id,
          nullif(btrim(coalesce(p_nota, '')), ''))
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.registrar_pago_cuenta is
  'Cobra a cuenta corriente. Baja el saldo con un movimiento, nunca escribiendo clientes.saldo.';

-- Correccion manual de un saldo (se cargo mal una deuda vieja, por ejemplo).
create or replace function public.ajustar_cuenta(
  p_cliente_id uuid,
  p_sucursal_id uuid,
  p_monto numeric,
  p_nota text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.tiene_rol(array['dueno']) then
    raise exception 'Solo un dueno puede ajustar una cuenta corriente a mano.';
  end if;
  if coalesce(p_monto, 0) = 0 then
    raise exception 'Un ajuste de 0 no corrige nada.';
  end if;
  if btrim(coalesce(p_nota, '')) = '' then
    raise exception 'Un ajuste sin explicacion no sirve para discutir con el cliente.';
  end if;

  insert into public.movimientos_cuenta (cliente_id, sucursal_id, tipo, monto, usuario_id, nota)
  values (p_cliente_id, p_sucursal_id, 'ajuste', round(p_monto, 2), auth.uid(), btrim(p_nota))
  returning id into v_id;

  return v_id;
end;
$$;
