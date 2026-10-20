-- Cuanto hay, por sucursal. Aca vive la separacion entre sucursales:
-- mismo catalogo, numeros distintos.
create table if not exists public.stock (
  variante_id uuid not null references public.variantes(id) on delete restrict,
  sucursal_id uuid not null references public.sucursales(id) on delete restrict,
  cantidad integer not null default 0,
  actualizado_at timestamptz not null default now(),
  primary key (variante_id, sucursal_id)
);

comment on table public.stock is
  'Cantidad por variante y sucursal. Puede quedar negativa a proposito: el sistema no frena la venta, avisa. Un negativo significa "aca hay algo que contar".';
comment on column public.stock.cantidad is
  'Sin check >= 0 a proposito. Ver docs/contrato-catalogo.md, decision 3.';

create index if not exists stock_por_sucursal on public.stock (sucursal_id);
-- Para la pantalla "faltantes": los negativos se buscan seguido y son pocos.
create index if not exists stock_negativo on public.stock (sucursal_id) where cantidad < 0;

-- Por que cambio. Cada suma o resta deja rastro.
create table if not exists public.movimientos_stock (
  id uuid primary key default gen_random_uuid(),
  variante_id uuid not null references public.variantes(id) on delete restrict,
  sucursal_id uuid not null references public.sucursales(id) on delete restrict,
  cantidad integer not null check (cantidad <> 0),
  motivo text not null check (motivo in (
    'venta', 'compra', 'ajuste', 'devolucion', 'traslado', 'inventario_inicial'
  )),
  referencia_id uuid,
  nota text,
  usuario_id uuid references public.usuarios(user_id),
  created_at timestamptz not null default now()
);

comment on table public.movimientos_stock is
  'El libro mayor del stock. Nunca se edita ni se borra una fila: un error se corrige con otro movimiento de tipo ajuste. Si dentro de seis meses un numero no cierra, se reconstruye dia por dia y se ve quien lo toco.';
comment on column public.movimientos_stock.cantidad is
  'Con signo: positivo entra, negativo sale. Nunca cero.';
comment on column public.movimientos_stock.motivo is
  'inventario_inicial es la carga del primer conteo fisico, para no confundirla con una compra que nunca existio.';
comment on column public.movimientos_stock.referencia_id is
  'Id de la venta o compra que lo origino, cuando lo hay. Permite ir del numero al comprobante.';

create index if not exists movimientos_por_variante_sucursal
  on public.movimientos_stock (variante_id, sucursal_id, created_at desc);
create index if not exists movimientos_por_fecha
  on public.movimientos_stock (sucursal_id, created_at desc);
