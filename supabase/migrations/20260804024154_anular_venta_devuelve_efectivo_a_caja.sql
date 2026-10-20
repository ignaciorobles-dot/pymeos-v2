-- Anular una venta cobrada en efectivo devuelve plata de verdad. Si eso no sale
-- del cajon, el arqueo del dia va a dar de mas y nadie va a saber por que.
create or replace function public.anular_venta(p_venta_id uuid, p_motivo text)
returns void
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_usuario uuid := auth.uid();
  v_venta public.ventas%rowtype;
  v_linea public.venta_lineas%rowtype;
  v_deuda numeric(12,2);
  v_efectivo numeric(12,2);
  v_turno uuid;
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

  -- Lo que se habia cobrado en mano se devuelve en mano.
  select coalesce(sum(p.monto), 0) into v_efectivo
    from public.pagos p
    join public.medios_pago mp on mp.id = p.medio_pago_id
   where p.venta_id = p_venta_id and mp.afecta_caja;

  if v_efectivo > 0 then
    v_turno := public.turno_abierto_id(v_venta.sucursal_id);
    if v_turno is null then
      raise exception 'Esa venta se cobro en efectivo: hay que devolver % y la caja esta cerrada. Abri la caja para anularla.', v_efectivo;
    end if;
    insert into public.movimientos_caja (turno_id, sucursal_id, tipo, monto, motivo, usuario_id, referencia_id)
    values (v_turno, v_venta.sucursal_id, 'anulacion', -v_efectivo,
            'Anulacion ticket ' || v_venta.numero, v_usuario, p_venta_id);
  end if;

  update public.ventas
     set estado = 'anulada', anulada_at = now(), anulada_por = v_usuario,
         motivo_anulacion = btrim(p_motivo)
   where id = p_venta_id;
end;
$$;
