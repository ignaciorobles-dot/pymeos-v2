-- Que no vuelva a pasar: toda funcion futura creada por este rol nace sin
-- EXECUTE para PUBLIC. Olvidarse de dar un permiso rompe visible; olvidarse
-- de sacarlo, no.
alter default privileges in schema public revoke execute on functions from public;
