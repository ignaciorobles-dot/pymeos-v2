-- Sin esto, un dueño puede bajarse el rol o desactivarse y dejar el negocio sin
-- nadie que pueda administrar usuarios ni sucursales: no habría forma de volver
-- atrás desde la aplicación. Tiene que quedar siempre al menos un dueño activo.
create or replace function public.exigir_un_dueno_activo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  dejaba_de_ser_dueno boolean;
begin
  dejaba_de_ser_dueno :=
    (tg_op = 'DELETE' and old.rol = 'dueno' and old.activo)
    or (tg_op = 'UPDATE' and old.rol = 'dueno' and old.activo
        and (new.rol <> 'dueno' or not new.activo));

  if dejaba_de_ser_dueno
     and not exists (
       select 1 from public.usuarios
       where rol = 'dueno' and activo and user_id <> old.user_id
     )
  then
    raise exception 'Tiene que quedar al menos un dueño activo. Nombrá otro dueño antes de hacer este cambio.'
      using errcode = 'check_violation';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists exigir_un_dueno_activo on public.usuarios;
create trigger exigir_un_dueno_activo
  before update or delete on public.usuarios
  for each row execute function public.exigir_un_dueno_activo();
