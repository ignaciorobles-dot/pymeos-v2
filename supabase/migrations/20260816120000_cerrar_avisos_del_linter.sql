-- Repaso de los avisos que devuelve el linter de Supabase. Son cuatro cosas
-- distintas y ninguna cambia lo que hace el sistema: cambian quien puede
-- llamar a que, y cuanto tarda en responder cuando haya datos de verdad.
--
-- 1) Funciones de trigger que quedaron expuestas como RPC
--
-- Toda funcion de public queda publicada en /rest/v1/rpc a menos que se le
-- saque el execute. Las migraciones viejas lo hacian; la de proveedores y
-- cheques se olvido de tres. Llamarlas por RPC hoy da error, porque una
-- funcion de trigger sin NEW no corre, pero no tienen por que estar
-- publicadas: lo que no se usa desde afuera no se ofrece desde afuera.

revoke execute on function public.aplicar_movimiento_proveedor()   from public, anon, authenticated;
revoke execute on function public.movimientos_proveedor_inmutables() from public, anon, authenticated;
revoke execute on function public.cheque_movimientos_inmutables()  from public, anon, authenticated;

-- 2) La limpieza de pedidos vencidos no es una funcion publica
--
-- soltar_pedidos_online_vencidos libera el stock que reservan los pedidos que
-- nadie confirmo. Es tarea de mantenimiento: la corre el servidor cada tanto,
-- no la corre un visitante de la tienda. Hoy cualquiera podia dispararla desde
-- el navegador sin estar logueado.

revoke execute on function public.soltar_pedidos_online_vencidos() from public, anon, authenticated;

-- 3) search_path fijo en las tres funciones que no lo tenian
--
-- Una funcion sin search_path fijo resuelve los nombres con el del que la
-- llama. En una funcion security definer eso permite que le pongan adelante un
-- esquema propio y le cambien que codigo corre. Estas tres no son definer, asi
-- que el riesgo es teorico, pero el criterio tiene que ser uno solo para todas.

alter function public.unaccent_simple(text)          set search_path = pg_catalog, public;
alter function public.slug_de(text)                  set search_path = pg_catalog, public;
alter function public.tipo_comprobante(text, text)   set search_path = pg_catalog, public;

-- 4) stock_disponible pasa a leerse con los permisos de quien pregunta
--
-- La vista se creo como security definer, o sea que lee como su duena y saltea
-- las policies. No hay filtracion hoy porque solo authenticated tiene select
-- sobre ella, pero es una excepcion sin motivo: las cinco tablas que junta
-- (stock, envios, envio_lineas, pedidos_online, pedido_online_lineas) le dan
-- select a authenticated y todas piden lo mismo, mi_rol() is not null.
--
-- La tienda publica no se ve afectada: entra por tienda_catalogo, que es
-- security definer y sigue leyendo como duena.

alter view public.stock_disponible set (security_invoker = true);

-- 5) Indices que faltan en las claves foraneas
--
-- Postgres indexa la primary key sola, no las foraneas. Sin indice, cada vez
-- que se borra o se actualiza la fila apuntada hay que recorrer la tabla
-- entera para ver quien la referencia, y toda consulta que filtre por esa
-- columna hace lo mismo. Con la base vacia no se nota; con dos anios de ventas
-- adentro es la diferencia entre una pantalla que abre y una que se cuelga.
--
-- Se agregan las 42 que faltaban, agrupadas por tabla.

create index if not exists categorias_escala_talle_id_idx        on public.categorias (escala_talle_id);

create index if not exists cheques_cliente_id_idx                on public.cheques (cliente_id);
create index if not exists cheques_sucursal_id_idx               on public.cheques (sucursal_id);
create index if not exists cheques_usuario_id_idx                on public.cheques (usuario_id);
create index if not exists cheques_venta_id_idx                  on public.cheques (venta_id);
create index if not exists cheque_movimientos_sucursal_id_idx    on public.cheque_movimientos (sucursal_id);
create index if not exists cheque_movimientos_usuario_id_idx     on public.cheque_movimientos (usuario_id);

create index if not exists compras_usuario_id_idx                on public.compras (usuario_id);
create index if not exists compras_anulada_por_idx               on public.compras (anulada_por);

create index if not exists comprobantes_usuario_id_idx           on public.comprobantes (usuario_id);

create index if not exists config_tienda_sucursal_id_idx         on public.config_tienda (sucursal_id);

create index if not exists consultas_creado_por_idx              on public.consultas (creado_por);
create index if not exists consultas_resuelta_por_idx            on public.consultas (resuelta_por);
create index if not exists consulta_mensajes_usuario_id_idx      on public.consulta_mensajes (usuario_id);

create index if not exists envios_usuario_id_idx                 on public.envios (usuario_id);
create index if not exists envios_repartidor_id_idx              on public.envios (repartidor_id);
create index if not exists envios_cancelado_por_idx              on public.envios (cancelado_por);

create index if not exists gastos_usuario_id_idx                 on public.gastos (usuario_id);
create index if not exists gastos_anulado_por_idx                on public.gastos (anulado_por);
create index if not exists gastos_movimiento_caja_id_idx         on public.gastos (movimiento_caja_id);

create index if not exists movimientos_caja_sucursal_id_idx      on public.movimientos_caja (sucursal_id);
create index if not exists movimientos_caja_usuario_id_idx       on public.movimientos_caja (usuario_id);

create index if not exists movimientos_cuenta_sucursal_id_idx    on public.movimientos_cuenta (sucursal_id);
create index if not exists movimientos_cuenta_usuario_id_idx     on public.movimientos_cuenta (usuario_id);
create index if not exists movimientos_cuenta_venta_id_idx       on public.movimientos_cuenta (venta_id);
create index if not exists movimientos_cuenta_medio_pago_id_idx  on public.movimientos_cuenta (medio_pago_id);

create index if not exists movimientos_proveedor_compra_id_idx      on public.movimientos_proveedor (compra_id);
create index if not exists movimientos_proveedor_sucursal_id_idx    on public.movimientos_proveedor (sucursal_id);
create index if not exists movimientos_proveedor_usuario_id_idx     on public.movimientos_proveedor (usuario_id);
create index if not exists movimientos_proveedor_medio_pago_id_idx  on public.movimientos_proveedor (medio_pago_id);

create index if not exists movimientos_stock_usuario_id_idx      on public.movimientos_stock (usuario_id);

create index if not exists pagos_medio_pago_id_idx               on public.pagos (medio_pago_id);

create index if not exists pedidos_online_venta_id_idx           on public.pedidos_online (venta_id);
create index if not exists pedidos_online_envio_id_idx           on public.pedidos_online (envio_id);
create index if not exists pedidos_online_cancelado_por_idx      on public.pedidos_online (cancelado_por);

create index if not exists pedidos_proveedor_compra_id_idx       on public.pedidos_proveedor (compra_id);
create index if not exists pedidos_proveedor_usuario_id_idx      on public.pedidos_proveedor (usuario_id);
create index if not exists pedidos_proveedor_cancelado_por_idx   on public.pedidos_proveedor (cancelado_por);

create index if not exists turnos_caja_abierto_por_idx           on public.turnos_caja (abierto_por);
create index if not exists turnos_caja_cerrado_por_idx           on public.turnos_caja (cerrado_por);

create index if not exists ventas_anulada_por_idx                on public.ventas (anulada_por);
create index if not exists ventas_venta_origen_id_idx            on public.ventas (venta_origen_id);
