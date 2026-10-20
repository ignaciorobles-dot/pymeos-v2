update public.usuarios u
set email = a.email,
    confirmado = (a.email_confirmed_at is not null)
from auth.users a
where a.id = u.user_id;
