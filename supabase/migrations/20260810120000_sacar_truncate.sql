-- Sacarle TRUNCATE (y los otros permisos de estructura) a las claves publicas.
--
-- Esto no lo introdujo ninguna migracion de este sistema: viene de la
-- configuracion por defecto de Supabase, que a toda tabla nueva de `public` le
-- da permisos completos a `anon` y `authenticated`. Nosotros veniamos ajustando
-- select/insert/update/delete tabla por tabla, pero quedaban tres permisos que
-- nunca miramos.
--
-- El que importa es TRUNCATE, y por que importa:
--
--   Las politicas de RLS filtran filas. Se aplican a select, insert, update y
--   delete, que son operaciones sobre filas. TRUNCATE no es una operacion sobre
--   filas: vacia la tabla entera de un saque, y por eso NO pasa por RLS. Con
--   ese permiso, cualquiera que tenga la clave publica —que esta a la vista en
--   el navegador de cualquiera que abra el sistema— podia vaciar `ventas`,
--   `pagos`, `movimientos_caja` o el catalogo completo, aunque las politicas le
--   prohiban borrar una sola fila.
--
-- Los otros dos van en el mismo viaje porque tampoco tienen razon de existir:
--
--   * REFERENCES deja crear claves foraneas apuntando a la tabla, y una clave
--     foranea ajena puede trabar un borrado legitimo nuestro.
--   * TRIGGER deja colgar disparadores en la tabla, o sea codigo que corre solo
--     cada vez que alguien guarda algo.
--
-- Ninguna de las tres las usa la aplicacion: son cosas de diseno de base, y el
-- diseno de la base pasa por estas migraciones, no por el navegador.

revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

-- Lo de arriba arregla las tablas que ya existen. Esto evita que la proxima
-- tabla nazca con el mismo problema: sin esta parte, la correccion se vence
-- sola en la migracion que viene.
alter default privileges in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;

-- Nota para el que venga: no se puede hacer lo mismo para `supabase_admin`
-- (Postgres contesta "permission denied to change default privileges"). Es el
-- rol interno de Supabase y no es el que crea nuestras tablas, asi que no hace
-- falta; queda escrito para que nadie lo intente de nuevo pensando que falta.
