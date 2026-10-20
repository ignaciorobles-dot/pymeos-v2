-- P3 — Ventas, pagos y cuenta corriente. Contrato: docs/contrato-ventas.md

create table public.clientes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null check (length(btrim(nombre)) > 0),
  telefono text,
  documento text,
  email text,
  direccion text,
  notas text,
  saldo numeric(12,2) not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table public.clientes is
  'Existen porque el negocio fia. saldo positivo = debe; negativo = tiene a favor.';
comment on column public.clientes.saldo is
  'Lo calcula el trigger desde movimientos_cuenta. Nadie tiene permiso de escribirlo: un saldo tipeable no sirve para discutir con un cliente.';
create index clientes_nombre_idx on public.clientes (lower(nombre));
create index clientes_con_deuda_idx on public.clientes (saldo) where saldo <> 0;

create table public.medios_pago (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique check (length(btrim(nombre)) > 0),
  recargo_porcentaje numeric(5,2) not null default 0 check (recargo_porcentaje >= 0),
  es_cuenta_corriente boolean not null default false,
  afecta_caja boolean not null default true,
  activo boolean not null default true,
  orden integer not null default 100
);
comment on table public.medios_pago is
  'El recargo de tarjeta se configura aca, no se escribe en el codigo: cuando pase de 10 a 12 se cambia en una pantalla.';

create table public.ventas (
  id uuid primary key default gen_random_uuid(),
  numero bigint not null,
  sucursal_id uuid not null references public.sucursales(id),
  usuario_id uuid not null references public.usuarios(user_id),
  cliente_id uuid references public.clientes(id),
  estado text not null default 'completada' check (estado in ('completada','anulada')),
  subtotal numeric(12,2) not null,
  descuento numeric(12,2) not null default 0 check (descuento >= 0),
  recargo numeric(12,2) not null default 0 check (recargo >= 0),
  total numeric(12,2) not null,
  venta_origen_id uuid references public.ventas(id),
  nota text,
  created_at timestamptz not null default now(),
  anulada_at timestamptz,
  anulada_por uuid references public.usuarios(user_id),
  motivo_anulacion text,
  constraint ventas_numero_por_sucursal unique (sucursal_id, numero),
  constraint ventas_total_cuadra check (total = subtotal - descuento + recargo),
  constraint ventas_anulacion_completa check (
    (estado = 'completada' and anulada_at is null and anulada_por is null)
    or (estado = 'anulada' and anulada_at is not null and anulada_por is not null)
  )
);
comment on table public.ventas is
  'Una venta nunca se borra: se anula, y la anulacion devuelve stock y revierte la deuda con movimientos nuevos.';
comment on column public.ventas.numero is
  'Correlativo por sucursal. Lo asigna la base con un lock: dos vendedores cobrando a la vez no pueden sacar el mismo ticket.';
comment on column public.ventas.venta_origen_id is
  'Si esta venta es un cambio, de que venta original viene.';
create index ventas_sucursal_fecha_idx on public.ventas (sucursal_id, created_at desc);
create index ventas_cliente_idx on public.ventas (cliente_id) where cliente_id is not null;
create index ventas_usuario_idx on public.ventas (usuario_id);

create table public.venta_lineas (
  id uuid primary key default gen_random_uuid(),
  venta_id uuid not null references public.ventas(id) on delete cascade,
  variante_id uuid not null references public.variantes(id),
  cantidad integer not null check (cantidad <> 0),
  precio_unitario numeric(12,2) not null check (precio_unitario >= 0),
  costo_unitario numeric(12,2),
  subtotal numeric(12,2) generated always as (cantidad * precio_unitario) stored
);
comment on table public.venta_lineas is
  'Apunta siempre a una variante, nunca a un producto: hay que saber que talle descontar.';
comment on column public.venta_lineas.cantidad is
  'Positivo = mercaderia que sale del local. Negativo = mercaderia que vuelve (cambio de talle).';
comment on column public.venta_lineas.costo_unitario is
  'Congelado al vender. Si se leyera variantes.costo, actualizar un costo cambiaria la ganancia de todas las ventas del pasado.';
create index venta_lineas_venta_idx on public.venta_lineas (venta_id);
create index venta_lineas_variante_idx on public.venta_lineas (variante_id);

create table public.pagos (
  id uuid primary key default gen_random_uuid(),
  venta_id uuid not null references public.ventas(id) on delete cascade,
  medio_pago_id uuid not null references public.medios_pago(id),
  monto numeric(12,2) not null check (monto <> 0),
  recargo numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);
comment on table public.pagos is
  'Tabla aparte y no una columna en ventas porque se paga mitad efectivo y mitad tarjeta todo el tiempo. Monto negativo = plata que sale.';
create index pagos_venta_idx on public.pagos (venta_id);

create table public.movimientos_cuenta (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id),
  sucursal_id uuid not null references public.sucursales(id),
  tipo text not null check (tipo in ('venta','pago','ajuste','anulacion')),
  monto numeric(12,2) not null check (monto <> 0),
  venta_id uuid references public.ventas(id),
  usuario_id uuid not null references public.usuarios(user_id),
  nota text,
  created_at timestamptz not null default now()
);
comment on table public.movimientos_cuenta is
  'El libro mayor de lo que se debe. Inmutable: un error se corrige con un ajuste a la vista, nunca borrando la fila.';
comment on column public.movimientos_cuenta.monto is
  'Con signo: positivo suma deuda (se fio), negativo la baja (pago).';
create index movimientos_cuenta_cliente_idx on public.movimientos_cuenta (cliente_id, created_at desc);
