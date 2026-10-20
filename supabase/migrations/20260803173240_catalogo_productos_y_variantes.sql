-- El modelo. Compartido por las dos sucursales: no existe "producto de la sucursal 1".
create table if not exists public.productos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null check (length(trim(nombre)) > 0),
  marca text,
  categoria text,
  descripcion text,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.productos is
  'El modelo (ej: "Zapatilla Nike Revolution"). No tiene stock ni precio: eso vive en variantes. Compartido entre sucursales.';
comment on column public.productos.activo is
  'Se descataloga, nunca se borra: borrarlo rompería las ventas viejas que lo referencian.';

-- Lo que existe de verdad y se cuenta: el talle 38 negro.
create table if not exists public.variantes (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references public.productos(id) on delete restrict,
  talle text,
  color text,
  sku text,
  codigo_barras text,
  precio numeric(12,2) not null default 0 check (precio >= 0),
  costo numeric(12,2) check (costo >= 0),
  activa boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.variantes is
  'Lo unico que se vende y se cuenta. Una venta apunta siempre a una variante, nunca a un producto: si apuntara al producto el sistema no sabria que talle descontar.';
comment on column public.variantes.talle is
  'Texto y no numero a proposito: existe "38", pero tambien "M", "XL" y "Unico".';
comment on column public.variantes.costo is
  'Lo que costo comprarla. La linea de venta se guarda su propia copia: si la ganancia mirara esta columna, actualizar el costo reescribiria la ganancia de meses ya cerrados.';

-- Una sola combinacion talle+color por producto. coalesce porque en SQL NULL != NULL,
-- y sin esto se podrian cargar dos veces "sin talle, sin color".
create unique index if not exists variantes_combinacion_unica
  on public.variantes (producto_id, coalesce(talle, ''), coalesce(color, ''));

-- El camino principal del mostrador: la pistola lee esto. Unico e indexado para
-- que la busqueda sea un salto por indice y no un recorrido de la tabla.
create unique index if not exists variantes_codigo_barras_unico
  on public.variantes (codigo_barras)
  where codigo_barras is not null;

create index if not exists variantes_por_producto
  on public.variantes (producto_id);

-- Busqueda por nombre para lo que no tiene etiqueta o esta borrosa.
create index if not exists productos_nombre_busqueda
  on public.productos using gin (to_tsvector('spanish', coalesce(nombre, '') || ' ' || coalesce(marca, '')));
