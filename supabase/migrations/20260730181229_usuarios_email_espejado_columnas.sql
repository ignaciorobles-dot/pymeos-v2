-- El mail de cada persona vive en auth.users, que el navegador no puede leer.
-- Sin espejarlo, la pantalla de Empleados no puede mostrar a quién se invitó.
-- public.usuarios nunca es la fuente de verdad del mail: solo su reflejo.
alter table public.usuarios
  add column if not exists email text,
  add column if not exists confirmado boolean not null default false;

comment on column public.usuarios.email is
  'Espejo de auth.users.email. Lo mantiene el trigger sincronizar_usuario_desde_auth. No editar a mano.';
comment on column public.usuarios.confirmado is
  'true cuando la persona ya aceptó la invitación y eligió su contraseña.';
