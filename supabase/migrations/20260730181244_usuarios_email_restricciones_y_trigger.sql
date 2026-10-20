alter table public.usuarios alter column email set not null;

-- Dos personas no pueden compartir mail: cada una entra con su propio usuario.
create unique index if not exists usuarios_email_unico on public.usuarios (lower(email));

create or replace function public.sincronizar_usuario_desde_auth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.usuarios
  set email = new.email,
      confirmado = (new.email_confirmed_at is not null)
  where user_id = new.id;
  return new;
end;
$$;

drop trigger if exists sincronizar_usuario_desde_auth on auth.users;
create trigger sincronizar_usuario_desde_auth
  after update of email, email_confirmed_at on auth.users
  for each row execute function public.sincronizar_usuario_desde_auth();
