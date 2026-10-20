-- ============================================================================
-- Borra los datos de demo que cargó `demo_zapatillas.sql`.
--
-- ⚠️ No es un `delete` común, y por una buena razón: los movimientos de stock
-- son inmutables por diseño (trigger `movimientos_inmutables`, que bloquea
-- UPDATE y DELETE). Eso es lo que hace que dentro de seis meses un número que
-- no cierra se pueda reconstruir día por día. Para sacar datos de prueba hay
-- que desactivar el trigger un momento y volver a activarlo.
--
-- NO CORRER si el negocio ya empezó a operar: si hubo ventas reales sobre
-- estas variantes, el borrado falla (los FK son `on delete restrict`, a
-- propósito) y hay que descatalogar en vez de borrar — ver el final.
-- ============================================================================

begin;

-- 1. Los movimientos de stock de la carga demo
alter table public.movimientos_stock disable trigger movimientos_inmutables;

delete from public.movimientos_stock ms
using public.variantes v, public.productos p
where ms.variante_id = v.id
  and v.producto_id = p.id
  and p.descripcion = 'DEMO — datos de ejemplo';

alter table public.movimientos_stock enable trigger movimientos_inmutables;

-- 2. Las filas de stock (las creó el trigger al nacer cada variante)
delete from public.stock st
using public.variantes v, public.productos p
where st.variante_id = v.id
  and v.producto_id = p.id
  and p.descripcion = 'DEMO — datos de ejemplo';

-- 3. Variantes y productos
delete from public.variantes v
using public.productos p
where v.producto_id = p.id
  and p.descripcion = 'DEMO — datos de ejemplo';

delete from public.productos
where descripcion = 'DEMO — datos de ejemplo';

commit;

-- Control: las tres tienen que dar 0.
select
  (select count(*) from public.productos where descripcion = 'DEMO — datos de ejemplo') as productos,
  (select count(*) from public.variantes v join public.productos p on p.id = v.producto_id
     where p.descripcion = 'DEMO — datos de ejemplo') as variantes,
  (select count(*) from public.movimientos_stock where nota = 'DEMO — carga de ejemplo') as movimientos;

-- ---------------------------------------------------------------------------
-- Si el borrado falla con "violates foreign key constraint"
-- ---------------------------------------------------------------------------
-- Significa que alguna de estas variantes ya se vendió de verdad. No la
-- borres: esa venta existió y el sistema tiene que poder mostrarla siempre.
-- Descatalogá en vez de borrar, que es para lo que está `activo`:
--
--   update public.productos set activo = false
--   where descripcion = 'DEMO — datos de ejemplo';
--
--   update public.variantes v set activa = false
--   from public.productos p
--   where v.producto_id = p.id and p.descripcion = 'DEMO — datos de ejemplo';
--
-- Desaparecen del mostrador y del alta de ventas, pero las ventas viejas
-- siguen siendo legibles.
-- ---------------------------------------------------------------------------
