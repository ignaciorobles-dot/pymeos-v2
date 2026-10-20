-- P1 — Sucursales, usuarios y control de acceso por rol
-- Implementa CONTRATO-P0-P1.md (v3).

create table public.sucursales (
  id            uuid primary key default gen_random_uuid(),
  nombre        text not null,
  alias         text not null unique,
  direccion     text not null,
  lat           double precision,
  lng           double precision,
  cuit          text,
  condicion_iva text,
  punto_venta   integer unique,
  activa        boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint sucursales_alias_no_vacio
    check (length(btrim(alias)) > 0),
  constraint sucursales_condicion_iva_valida
    check (condicion_iva is null or condicion_iva in (
      'Responsable Inscripto', 'Monotributista', 'Exento', 'Consumidor Final'
    )),
  constraint sucursales_punto_venta_positivo
    check (punto_venta is null or punto_venta > 0)
);

comment on table public.sucursales is
  'Locales del negocio. No se borran: se marcan activa = false.';
comment on column public.sucursales.nombre is
  'Nombre comercial. No es unico ni identificador: puede cambiar.';
comment on column public.sucursales.alias is
  'Identificador corto y estable para la interfaz. Unico.';
comment on column public.sucursales.punto_venta is
  'Punto de venta ante ARCA. Unico por sucursal. Sin esto no se puede facturar.';

create table public.usuarios (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  nombre      text not null,
  rol         text not null,
  sucursal_id uuid references public.sucursales(id),
  activo      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint usuarios_rol_valido
    check (rol in ('dueno', 'vendedor', 'contador')),
  constraint usuarios_vendedor_con_sucursal
    check (rol <> 'vendedor' or sucursal_id is not null),
  constraint usuarios_global_sin_sucursal
    check (rol not in ('dueno', 'contador') or sucursal_id is null)
);

comment on table public.usuarios is
  'Quien puede entrar al sistema y con que rol. Dar de baja es activo = false.';
comment on column public.usuarios.sucursal_id is
  'Sucursal asignada. NULL = ve todas las sucursales.';

create index usuarios_sucursal_id_idx on public.usuarios (sucursal_id);

create or replace function public.mi_rol()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.rol
  from public.usuarios u
  where u.user_id = (select auth.uid())
    and u.activo
$$;

create or replace function public.mi_sucursal()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.sucursal_id
  from public.usuarios u
  where u.user_id = (select auth.uid())
    and u.activo
$$;

create or replace function public.tiene_rol(roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.usuarios u
    where u.user_id = (select auth.uid())
      and u.activo
      and u.rol = any(roles)
  )
$$;

comment on function public.mi_rol() is
  'Rol del usuario actual. NULL si no esta registrado o esta inactivo.';
comment on function public.mi_sucursal() is
  'Sucursal del usuario actual. NULL si ve todas.';
comment on function public.tiene_rol(text[]) is
  'True si el rol del usuario actual esta en la lista.';

revoke execute on function public.mi_rol()          from public, anon;
revoke execute on function public.mi_sucursal()     from public, anon;
revoke execute on function public.tiene_rol(text[]) from public, anon;

grant execute on function public.mi_rol()          to authenticated;
grant execute on function public.mi_sucursal()     to authenticated;
grant execute on function public.tiene_rol(text[]) to authenticated;

create or replace function public.usuarios_sin_auto_ascenso()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.user_id = (select auth.uid())
     and (new.rol is distinct from old.rol
          or new.activo is distinct from old.activo) then
    raise exception 'Un usuario no puede cambiar su propio rol ni su propio estado';
  end if;
  return new;
end;
$$;

create trigger usuarios_sin_auto_ascenso
  before update on public.usuarios
  for each row
  execute function public.usuarios_sin_auto_ascenso();

create or replace function public.usuarios_siempre_un_dueno()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.usuarios where rol = 'dueno' and activo
  ) then
    raise exception 'El sistema no puede quedarse sin ningun dueno activo';
  end if;
  return null;
end;
$$;

create constraint trigger usuarios_siempre_un_dueno
  after update or delete on public.usuarios
  deferrable initially deferred
  for each row
  execute function public.usuarios_siempre_un_dueno();

alter table public.sucursales enable row level security;
alter table public.usuarios   enable row level security;

create policy sucursales_select_usuarios_activos
  on public.sucursales for select
  to authenticated
  using (public.mi_rol() is not null);

create policy sucursales_escribe_dueno
  on public.sucursales for all
  to authenticated
  using (public.tiene_rol(array['dueno']))
  with check (public.tiene_rol(array['dueno']));

create policy usuarios_select_propio_o_dueno
  on public.usuarios for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or public.tiene_rol(array['dueno'])
  );

create policy usuarios_escribe_dueno
  on public.usuarios for all
  to authenticated
  using (public.tiene_rol(array['dueno']))
  with check (public.tiene_rol(array['dueno']));

revoke all on public.sucursales from anon;
revoke all on public.usuarios   from anon;

grant select, insert, update, delete on public.sucursales to authenticated;
grant select, insert, update, delete on public.usuarios   to authenticated;

insert into public.sucursales (nombre, alias, direccion) values
  ('Sucursal Centro', 'Sucursal 1', 'Calle Demo 123, Ciudad Demo'),
  ('Sucursal Norte', 'Sucursal 2', 'Av. Ejemplo 456, Ciudad Demo');
