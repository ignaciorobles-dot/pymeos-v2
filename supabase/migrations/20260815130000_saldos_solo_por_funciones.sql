-- El saldo de un cliente y el saldo de un proveedor son plata: salen de lo que
-- se fio, de lo que se compro y de lo que se pago, y cada movimiento queda
-- registrado en movimientos_cuenta y en movimientos_proveedor.
--
-- Hasta ahora las dos tablas tenian el update dado sobre la tabla entera, asi
-- que cualquier usuario autenticado podia poner un saldo en cero desde la
-- consola del navegador sin dejar rastro. Eso contradice la regla de que la
-- plata solo la mueven las funciones security definer, que corren como duenas
-- de la tabla y no dependen de estos permisos.
--
-- Un revoke por columna no alcanza cuando el permiso esta dado sobre la tabla
-- entera: hay que sacar el update completo y devolverlo columna por columna.
--
-- Quedan afuera tambien id y created_at: reescribir la identidad o la fecha de
-- alta no es editar los datos de alguien, es romper el historial que lo
-- referencia.

revoke update on public.clientes from authenticated;
grant update (nombre, telefono, email, direccion, notas, documento,
              tipo_documento, condicion_iva, activo)
  on public.clientes to authenticated;

revoke update on public.proveedores from authenticated;
grant update (nombre, cuit, condicion_iva, telefono, email, direccion, notas, activo)
  on public.proveedores to authenticated;
