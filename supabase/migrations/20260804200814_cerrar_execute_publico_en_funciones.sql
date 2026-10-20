-- Postgres le da EXECUTE a PUBLIC en toda funcion nueva. Eso significa que
-- `anon` (sin haber iniciado sesion) podia llamar a registrar_venta,
-- anular_venta, ajustar_cuenta y registrar_pago_cuenta por /rest/v1/rpc.
-- Las funciones de caja ya venian cerradas; estas cuatro no. Se cierran.
revoke execute on function public.registrar_venta(uuid, jsonb, jsonb, uuid, numeric, text, uuid) from public, anon;
revoke execute on function public.anular_venta(uuid, text) from public, anon;
revoke execute on function public.ajustar_cuenta(uuid, uuid, numeric, text) from public, anon;
revoke execute on function public.registrar_pago_cuenta(uuid, uuid, numeric, uuid, text) from public, anon;

grant execute on function public.registrar_venta(uuid, jsonb, jsonb, uuid, numeric, text, uuid) to authenticated;
grant execute on function public.anular_venta(uuid, text) to authenticated;
grant execute on function public.ajustar_cuenta(uuid, uuid, numeric, text) to authenticated;
grant execute on function public.registrar_pago_cuenta(uuid, uuid, numeric, uuid, text) to authenticated;

-- Funciones de trigger: no las llama nadie a mano, las llama Postgres.
-- Nadie necesita EXECUTE sobre ellas.
revoke execute on function public.aplicar_movimiento_a_stock() from public, anon, authenticated;
revoke execute on function public.aplicar_movimiento_cuenta() from public, anon, authenticated;
revoke execute on function public.crear_stock_en_todas_las_sucursales() from public, anon, authenticated;
revoke execute on function public.crear_stock_para_sucursal_nueva() from public, anon, authenticated;
revoke execute on function public.exigir_caja_abierta_en_pago() from public, anon, authenticated;
revoke execute on function public.exigir_un_dueno_activo() from public, anon, authenticated;
revoke execute on function public.sincronizar_usuario_desde_auth() from public, anon, authenticated;
revoke execute on function public.movimientos_son_inmutables() from public, anon, authenticated;
revoke execute on function public.movimientos_caja_inmutables() from public, anon, authenticated;
revoke execute on function public.movimientos_cuenta_inmutables() from public, anon, authenticated;
revoke execute on function public.ventas_total_coherente() from public, anon, authenticated;
revoke execute on function public.usuarios_siempre_un_dueno() from public, anon, authenticated;
revoke execute on function public.usuarios_sin_auto_ascenso() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
