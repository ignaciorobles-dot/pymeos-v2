-- search_path fijo: sin esto, quien pueda crear un esquema temporal podria
-- hacer que la funcion llame a otra tabla con el mismo nombre.
alter function public.movimientos_son_inmutables() set search_path = public, pg_temp;

-- Las funciones de trigger quedan publicadas como /rest/v1/rpc/... por estar en
-- el esquema public. Nadie tiene por que poder llamarlas a mano.
revoke execute on function public.movimientos_son_inmutables() from anon, authenticated;
revoke execute on function public.aplicar_movimiento_a_stock() from anon, authenticated;
revoke execute on function public.crear_stock_en_todas_las_sucursales() from anon, authenticated;
revoke execute on function public.crear_stock_para_sucursal_nueva() from anon, authenticated;
revoke execute on function public.exigir_un_dueno_activo() from anon, authenticated;
revoke execute on function public.sincronizar_usuario_desde_auth() from anon, authenticated;

-- mi_rol(), tiene_rol() y mi_sucursal() si tienen que seguir siendo ejecutables:
-- las politicas RLS corren con el rol de quien consulta y las necesitan.
revoke execute on function public.mi_rol() from anon;
revoke execute on function public.tiene_rol(text[]) from anon;
revoke execute on function public.mi_sucursal() from anon;
