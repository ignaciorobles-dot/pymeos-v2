-- Arregla dos permisos que existian a medias.
--
-- Las dos tablas ya tenian su politica de RLS escrita y correcta:
--
--   clientes     -> clientes_edita_usuarios_activos (update, cualquier usuario activo)
--   proveedores  -> proveedores_escribe_dueno       (all, dueno o contador)
--
-- Lo que faltaba es el permiso de la capa de abajo. RLS decide QUE FILAS puede
-- tocar alguien que ya tiene permiso sobre la tabla; el GRANT decide si tiene
-- permiso sobre la tabla. Sin el grant, la politica nunca llega a evaluarse y
-- Postgres contesta "permission denied for table proveedores", que no se parece
-- en nada a un problema de rol y manda a buscar el error al lugar equivocado.
--
-- La diferencia se nota asi: RLS que rechaza devuelve cero filas, un grant que
-- falta devuelve un error. Si aparece la palabra "denied", es grant.
--
-- Que estaba roto en la practica:
--
--   * Dar de alta un proveedor desde la pantalla de Compras fallaba siempre,
--     incluso siendo dueno.
--   * Editar los datos de un cliente fallaba siempre.
--
-- No se agrega ninguna politica nueva: el permiso de verdad ya estaba decidido
-- y sigue siendo el mismo. Esto solo abre la puerta que la politica custodia.

grant insert, update on public.clientes    to authenticated;
grant insert, update on public.proveedores to authenticated;

-- El delete no se otorga a proposito. En este sistema nada se borra: los
-- clientes y los proveedores se desactivan con su bandera `activo`, asi las
-- ventas y las compras viejas siguen teniendo a quien apuntar.
