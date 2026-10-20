-- ============================================================================
-- DATOS DE DEMO — catálogo de zapatillas para mostrar el sistema andando.
--
-- NO es una migración. No va en supabase/migrations y no se aplica sola:
-- se pega en el SQL Editor del Dashboard y se corre a mano.
--
-- Por qué existe: con la base vacía, las pantallas que SÍ funcionan (Stock,
-- Ventas, Caja, Clientes) se ven vacías y las que todavía son maqueta se ven
-- llenas de números inventados — la impresión exactamente al revés de la
-- realidad. 
--
-- ⚠️ LEER ANTES DE CORRER:
-- Los movimientos de stock son inmutables por diseño (un trigger bloquea
-- UPDATE y DELETE). Sacar estos datos después NO es un `delete` simple: hay
-- que correr `limpiar_demo_zapatillas.sql`. Decidí antes si esto queda o se va.
--
-- Es idempotente: correrlo dos veces no duplica nada (la segunda vez corta).
--
-- Qué carga: 12 modelos con talles y colores, y stock DISTINTO en cada
-- sucursal — que es justamente lo que hay que mostrar. Precios en pesos de
-- 2026; ajustalos si querés que sean los de verdad.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Cortes de seguridad
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from public.categorias where lower(trim(nombre)) = 'calzado') then
    raise exception 'Falta la categoría "Calzado". Aplicá primero la migración 20260805210000.';
  end if;

  if (select count(*) from public.sucursales where activa) = 0 then
    raise exception 'No hay sucursales activas: el stock no tendría dónde vivir.';
  end if;

  -- Sin esto, correr el script dos veces deja 24 productos en vez de 12:
  -- `productos` no tiene índice único por nombre (dos modelos pueden llamarse
  -- igual y ser distintos), así que el ON CONFLICT no lo atajaría.
  if exists (select 1 from public.productos where descripcion = 'DEMO — datos de ejemplo') then
    raise exception 'Los datos de demo ya están cargados. Para rehacerlos, corré antes limpiar_demo_zapatillas.sql';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Productos y variantes
-- ---------------------------------------------------------------------------
-- Cada modelo declara su rango de talles y sus colores; las variantes salen del
-- cruce. Un modelo real no viene en los 13 talles ni en todos los colores.
with modelos (nombre, marca, precio, costo, t_desde, t_hasta, colores) as (
  values
    ('Air Max 90',       'Nike',     289900::numeric, 168000::numeric, 38, 45, array['Negro','Blanco']),
    ('Revolution 7',     'Nike',     164900,           94000,          38, 45, array['Negro','Gris']),
    ('Court Vision Low', 'Nike',     199900,          115000,          39, 44, array['Blanco']),
    ('Superstar',        'Adidas',   209900,          121000,          36, 44, array['Blanco','Negro']),
    ('Runfalcon 3',      'Adidas',   149900,           86000,          38, 45, array['Negro','Azul']),
    ('Grand Court',      'Adidas',   179900,          103000,          36, 42, array['Blanco']),
    ('Caven 2.0',        'Puma',     139900,           79000,          38, 44, array['Negro','Blanco']),
    ('Boston',           'Topper',    89900,           49000,          37, 45, array['Negro','Blanco','Azul']),
    ('Squad',            'Topper',    79900,           43000,          36, 43, array['Negro','Gris']),
    ('Go Walk 6',        'Skechers', 199900,          116000,          37, 43, array['Negro','Gris']),
    ('Old Skool',        'Vans',     189900,          110000,          38, 44, array['Negro']),
    ('Chuck Taylor',     'Converse', 169900,           97000,          36, 44, array['Negro','Blanco'])
),
cat as (
  select id from public.categorias where lower(trim(nombre)) = 'calzado' limit 1
),
nuevos as (
  insert into public.productos (nombre, marca, categoria_id, descripcion, activo)
  select m.nombre, m.marca, cat.id, 'DEMO — datos de ejemplo', true
  from modelos m cross join cat
  returning id, nombre, marca
),
combinaciones as (
  select
    n.id as producto_id,
    n.marca,
    n.nombre,
    t as talle,
    c.color,
    m.precio,
    m.costo,
    -- Correlativo estable: el código de barras sale de acá, así no depende de
    -- un hash (dos hashes iguales harían perder una variante en silencio).
    row_number() over (order by n.marca, n.nombre, t, c.color) as nro
  from nuevos n
  join modelos m on m.nombre = n.nombre and m.marca = n.marca
  cross join lateral generate_series(m.t_desde, m.t_hasta) as t
  cross join lateral unnest(m.colores) as c(color)
)
insert into public.variantes (producto_id, talle, color, sku, codigo_barras, precio, costo)
select
  producto_id,
  talle::text,
  color,
  -- SKU legible: MARCA-MODELO-TALLE-COLOR (ej. NIK-AIRM-42-NEG)
  upper(
    substr(regexp_replace(marca,  '[^A-Za-z]', '', 'g'), 1, 3) || '-' ||
    substr(regexp_replace(nombre, '[^A-Za-z]', '', 'g'), 1, 4) || '-' ||
    talle::text || '-' ||
    substr(regexp_replace(color,  '[^A-Za-z]', '', 'g'), 1, 3)
  ),
  '779' || lpad(nro::text, 10, '0'),   -- 13 dígitos, único por construcción
  precio,
  costo
from combinaciones;

-- ---------------------------------------------------------------------------
-- 2. Stock inicial, distinto por sucursal
-- ---------------------------------------------------------------------------
-- El stock NO se escribe a mano: se registra un movimiento y el trigger
-- `movimiento_aplica_stock` acomoda la cantidad. Es el único camino que existe.
--
-- Las cantidades imitan un local real: los talles del medio (40-42) son los que
-- más rotan y más se reponen, los extremos casi no tienen, y varios quedan en
-- cero a propósito para que "bajo stock" y los agotados se vean en la demo.
-- Sale de un hash del id, así que es reproducible y no aleatorio.
--
-- El filtro por DEMO va en un CTE y no en el WHERE final: `talle::int` reventaría
-- si en la base hubiera una variante con talle no numérico ("M", "Único"), porque
-- el cast puede evaluarse antes que el filtro.
with variantes_demo as (
  select v.id, v.talle::int as talle_num
  from public.variantes v
  join public.productos p on p.id = v.producto_id
  where p.descripcion = 'DEMO — datos de ejemplo'
    and v.talle ~ '^[0-9]+$'
),
plan as (
  select
    vd.id as variante_id,
    s.id as sucursal_id,
    case
      when vd.talle_num between 40 and 42
        then 2 + (abs(hashtext(vd.id::text || s.id::text)) % 4)   -- 2 a 5
      when vd.talle_num between 38 and 43
        then (abs(hashtext(vd.id::text || s.id::text)) % 4)       -- 0 a 3
      else (abs(hashtext(vd.id::text || s.id::text)) % 3)         -- 0 a 2 en los extremos
    end as cantidad
  from variantes_demo vd
  cross join (select id from public.sucursales where activa) s
)
insert into public.movimientos_stock (variante_id, sucursal_id, cantidad, motivo, nota)
select variante_id, sucursal_id, cantidad, 'inventario_inicial', 'DEMO — carga de ejemplo'
from plan
where cantidad > 0;   -- movimientos_stock tiene check (cantidad <> 0)

-- ---------------------------------------------------------------------------
-- 3. Control — qué quedó cargado
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.productos
     where descripcion = 'DEMO — datos de ejemplo') as productos,
  (select count(*) from public.variantes v
     join public.productos p on p.id = v.producto_id
     where p.descripcion = 'DEMO — datos de ejemplo') as variantes,
  (select count(*) from public.stock st
     join public.variantes v on v.id = st.variante_id
     join public.productos p on p.id = v.producto_id
     where p.descripcion = 'DEMO — datos de ejemplo' and st.cantidad > 0) as filas_con_stock,
  (select coalesce(sum(st.cantidad), 0) from public.stock st
     join public.variantes v on v.id = st.variante_id
     join public.productos p on p.id = v.producto_id
     where p.descripcion = 'DEMO — datos de ejemplo') as pares_totales;

-- ---------------------------------------------------------------------------
-- Las dos ventas de prueba: HACERLAS A MANO EN LA APP.
--
-- No se cargan por SQL a propósito: `registrar_venta` necesita saber quién
-- vende (`auth.uid()`), y desde el SQL Editor no hay usuario. Además sirve de
-- ensayo — abrir la caja, vender dos pares y cerrarla es exactamente el
-- recorrido que conviene tener practicado antes de mostrarlo.
-- ---------------------------------------------------------------------------
