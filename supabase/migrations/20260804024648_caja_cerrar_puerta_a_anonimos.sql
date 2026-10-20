-- Postgres le da execute a PUBLIC por defecto: sin este revoke, cualquiera con
-- la clave publicable podia llamar a estas funciones sin estar logueado.
revoke execute on function public.turno_abierto_id(uuid) from public, anon;
revoke execute on function public.saldo_esperado_caja(uuid) from public, anon;
revoke execute on function public.abrir_caja(uuid, numeric) from public, anon;
revoke execute on function public.registrar_movimiento_caja(uuid, text, numeric, text) from public, anon;
revoke execute on function public.cerrar_caja(uuid, numeric, text) from public, anon;

-- Y ademas: leer la caja tambien es leer plata. Solo usuarios del sistema.
create or replace function public.movimientos_del_turno(p_turno_id uuid)
returns table (
  momento  timestamptz,
  tipo     text,
  detalle  text,
  monto    numeric,
  quien    text
)
language sql
stable
security definer
set search_path to 'public','pg_temp'
as $$
  with w as (
    select id, sucursal_id, monto_apertura, abierto_at as desde,
           coalesce(cerrado_at, now()) as hasta, abierto_por
      from public.turnos_caja
     where id = p_turno_id and public.mi_rol() is not null
  )
  select w.desde, 'apertura', 'Apertura de caja', w.monto_apertura,
         coalesce(u.nombre, '—')
    from w left join public.usuarios u on u.user_id = w.abierto_por

  union all

  select p.created_at, 'venta', 'Ticket #' || v.numero, p.monto,
         coalesce(u.nombre, '—')
    from public.pagos p
    join public.ventas v on v.id = p.venta_id
    join public.medios_pago mp on mp.id = p.medio_pago_id
    left join public.usuarios u on u.user_id = v.usuario_id
    join w on w.sucursal_id = v.sucursal_id
   where mp.afecta_caja
     and p.created_at >= w.desde and p.created_at < w.hasta

  union all

  select mc.created_at, 'cobro', 'Cobro a ' || coalesce(c.nombre, 'cliente'), -mc.monto,
         coalesce(u.nombre, '—')
    from public.movimientos_cuenta mc
    join public.medios_pago mp on mp.id = mc.medio_pago_id
    left join public.clientes c on c.id = mc.cliente_id
    left join public.usuarios u on u.user_id = mc.usuario_id
    join w on w.sucursal_id = mc.sucursal_id
   where mp.afecta_caja and mc.tipo = 'pago'
     and mc.created_at >= w.desde and mc.created_at < w.hasta

  union all

  select m.created_at, m.tipo, m.motivo, m.monto, coalesce(u.nombre, '—')
    from public.movimientos_caja m
    join w on w.id = m.turno_id
    left join public.usuarios u on u.user_id = m.usuario_id

  order by 1;
$$;

revoke execute on function public.movimientos_del_turno(uuid) from public, anon;
grant execute on function public.movimientos_del_turno(uuid) to authenticated;

-- El trigger nuevo tambien queria su search_path fijo.
create or replace function public.movimientos_caja_inmutables()
returns trigger language plpgsql
set search_path to 'public','pg_temp'
as $$
begin
  raise exception 'Un movimiento de caja no se edita ni se borra. Se corrige con otro movimiento.';
end; $$;
