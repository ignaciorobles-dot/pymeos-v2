-- Las politicas RLS no alcanzan: primero hay que tener permiso sobre la tabla.
-- Las tablas creadas por migracion no lo heredan, asi que sin esto la app veria
-- "permission denied for table productos" aunque la politica la dejara pasar.
grant select, insert, update, delete on public.productos to authenticated;
grant select, insert, update, delete on public.variantes to authenticated;

-- Stock: solo lectura para todos. La unica via para cambiar una cantidad es un
-- movimiento; el trigger que lo aplica corre como dueno de la funcion.
grant select on public.stock to authenticated;

-- Movimientos: se leen y se agregan. Nunca se editan ni se borran (hay trigger
-- que lo impide, pero tampoco se da el permiso).
grant select, insert on public.movimientos_stock to authenticated;

-- service_role: lo usan la Edge Function y los procesos del servidor.
grant select, insert, update, delete on public.productos to service_role;
grant select, insert, update, delete on public.variantes to service_role;
grant select, insert, update, delete on public.stock to service_role;
grant select, insert on public.movimientos_stock to service_role;
