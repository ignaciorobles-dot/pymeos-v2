alter table public.productos enable row level security;
alter table public.variantes enable row level security;
alter table public.stock enable row level security;
alter table public.movimientos_stock enable row level security;

-- Catalogo: lo lee cualquier usuario activo, lo edita solo el dueno.
-- Ocultar el boton no es seguridad: un vendedor con la sesion abierta puede
-- llamar a la base directamente, y aca es donde se lo frena.
drop policy if exists productos_select_usuarios_activos on public.productos;
create policy productos_select_usuarios_activos on public.productos
  for select to authenticated using (public.mi_rol() is not null);

drop policy if exists productos_escribe_dueno on public.productos;
create policy productos_escribe_dueno on public.productos
  for all to authenticated
  using (public.tiene_rol(array['dueno']))
  with check (public.tiene_rol(array['dueno']));

drop policy if exists variantes_select_usuarios_activos on public.variantes;
create policy variantes_select_usuarios_activos on public.variantes
  for select to authenticated using (public.mi_rol() is not null);

drop policy if exists variantes_escribe_dueno on public.variantes;
create policy variantes_escribe_dueno on public.variantes
  for all to authenticated
  using (public.tiene_rol(array['dueno']))
  with check (public.tiene_rol(array['dueno']));

-- Stock: solo lectura desde la app. No hay politica de escritura a proposito.
-- La unica via para cambiar una cantidad es insertar un movimiento; el trigger
-- que lo aplica corre como dueno de la funcion y no pasa por RLS.
drop policy if exists stock_select_usuarios_activos on public.stock;
create policy stock_select_usuarios_activos on public.stock
  for select to authenticated using (public.mi_rol() is not null);

-- Movimientos: los lee cualquier usuario activo y los inserta cualquier usuario
-- activo, sobre cualquier sucursal activa.
--
-- No se compara contra usuarios.sucursal_id a proposito (regla del equipo: la sucursal sale del equipo, no del usuario):
-- manda el equipo, no la persona. Un vendedor que cubre un turno en la otra
-- sucursal tiene que poder vender ahi sin que nadie edite su ficha.
-- La sucursal la decide la maquina, y cambiarla pide la contrasena del dueno.
drop policy if exists movimientos_select_usuarios_activos on public.movimientos_stock;
create policy movimientos_select_usuarios_activos on public.movimientos_stock
  for select to authenticated using (public.mi_rol() is not null);

drop policy if exists movimientos_inserta_usuario_activo on public.movimientos_stock;
create policy movimientos_inserta_usuario_activo on public.movimientos_stock
  for insert to authenticated
  with check (
    public.mi_rol() is not null
    and usuario_id = (select auth.uid())
    and exists (
      select 1 from public.sucursales s
      where s.id = sucursal_id and s.activa
    )
  );
