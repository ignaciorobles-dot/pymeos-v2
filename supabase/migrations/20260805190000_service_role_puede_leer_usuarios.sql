-- La Edge Function `invitar-empleado` entra a la base con el rol `service_role`,
-- que es el único que puede crear usuarios de Auth. Para decidir si quien pide
-- la invitación es dueño, necesita leer `public.usuarios`; para validar la
-- sucursal elegida, leer `public.sucursales`; y para dejar el perfil de la
-- persona invitada, insertar en `public.usuarios`.
--
-- Esos permisos nunca se le habían dado. Las tablas de P1 se crearon otorgando
-- privilegios solo a `authenticated`, y recién en el catálogo (P2) empezamos a
-- nombrar a `service_role`. Resultado: la función fallaba con "permission denied
-- for table usuarios", y como el código de entonces descartaba ese error,
-- terminaba mostrando "Solo un dueño puede invitar empleados" a un dueño real.
--
-- Se da lo mínimo y nada más. En particular NO se le abren a `service_role` las
-- tablas de plata (ventas, pagos, movimientos_*, turnos_caja): la regla sigue
-- siendo que ahí no escribe nadie salvo las funciones `security definer`.
grant select, insert on public.usuarios to service_role;
grant select on public.sucursales to service_role;
