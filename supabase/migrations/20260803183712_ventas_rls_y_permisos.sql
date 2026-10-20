alter table public.clientes           enable row level security;
alter table public.medios_pago        enable row level security;
alter table public.ventas             enable row level security;
alter table public.venta_lineas       enable row level security;
alter table public.pagos              enable row level security;
alter table public.movimientos_cuenta enable row level security;

-- Leer: cualquier usuario activo del sistema.
create policy clientes_select_usuarios_activos    on public.clientes           for select using (public.mi_rol() is not null);
create policy medios_select_usuarios_activos      on public.medios_pago        for select using (public.mi_rol() is not null);
create policy ventas_select_usuarios_activos      on public.ventas             for select using (public.mi_rol() is not null);
create policy venta_lineas_select_usuarios_activos on public.venta_lineas      for select using (public.mi_rol() is not null);
create policy pagos_select_usuarios_activos       on public.pagos              for select using (public.mi_rol() is not null);
create policy mov_cuenta_select_usuarios_activos  on public.movimientos_cuenta for select using (public.mi_rol() is not null);

-- Un cliente nuevo lo carga cualquiera en el mostrador: si hay que pedir permiso
-- para anotar a quien te esta comprando, se anota en un papel y se pierde.
create policy clientes_alta_usuarios_activos on public.clientes for insert
  with check (public.mi_rol() is not null);
create policy clientes_edita_usuarios_activos on public.clientes for update
  using (public.mi_rol() is not null) with check (public.mi_rol() is not null);

-- Los medios de pago y sus recargos los toca el dueno: ahi se define cuanto cobra el local.
create policy medios_escribe_dueno on public.medios_pago for all
  using (public.tiene_rol(array['dueno'])) with check (public.tiene_rol(array['dueno']));

-- RLS sin GRANT no sirve: las tablas creadas por migracion no heredan permisos.
grant select on public.clientes, public.medios_pago, public.ventas,
                public.venta_lineas, public.pagos, public.movimientos_cuenta
  to authenticated;

grant insert on public.clientes to authenticated;
-- saldo queda afuera a proposito: no existe el permiso de escribirlo para nadie.
grant update (nombre, telefono, documento, email, direccion, notas, activo)
  on public.clientes to authenticated;

grant insert, update, delete on public.medios_pago to authenticated;

-- ventas, venta_lineas, pagos y movimientos_cuenta NO reciben permiso de escritura.
-- La unica puerta son las funciones de abajo. No es que la pantalla no lo haga:
-- es que no se puede, ni con la clave publica y un cliente HTTP.
revoke all on function public.registrar_venta(uuid, jsonb, jsonb, uuid, numeric, text, uuid)   from anon;
revoke all on function public.anular_venta(uuid, text)                                          from anon;
revoke all on function public.registrar_pago_cuenta(uuid, uuid, numeric, uuid, text)            from anon;
revoke all on function public.ajustar_cuenta(uuid, uuid, numeric, text)                         from anon;
grant execute on function public.registrar_venta(uuid, jsonb, jsonb, uuid, numeric, text, uuid) to authenticated;
grant execute on function public.anular_venta(uuid, text)                                       to authenticated;
grant execute on function public.registrar_pago_cuenta(uuid, uuid, numeric, uuid, text)         to authenticated;
grant execute on function public.ajustar_cuenta(uuid, uuid, numeric, text)                      to authenticated;
