-- Categorias, talles y colores dejan de escribirse a mano y pasan a elegirse.
--
-- El problema que resuelve, tal cual lo planteo el dueno: "si uno guarda
-- calzados, te va a calzados con s, y si guarda calzado sin s es otra categoria
-- y queres ir a lo mismo". Con texto libre y tres personas cargando, el catalogo
-- termina con categorias gemelas y el stock partido en dos. Eso no se arregla
-- despues: hay que impedirlo antes de cargar el primer producto.
--
-- El nombre del modelo y la marca siguen siendo texto libre a proposito. El
-- nombre es un nombre propio (cada modelo es distinto) y todavia no se sabe con
-- que marcas se va a trabajar. El dia que se sepa, la marca se convierte en
-- lista igual que estas, sin migrar nada.

-- --------------------------------------------------------------------------
-- Escalas de talle
-- --------------------------------------------------------------------------
-- Los talles se agrupan por escala en vez de vivir en una lista unica. Hoy se
-- vende calzado (34 a 46), pero el dia que entre una remera la escala es S/M/L,
-- y con una sola lista apareceria todo mezclado en el mismo desplegable. Cada
-- categoria dice que escala usa; hoy hay una sola, asi que en la practica no se
-- nota, pero no hay que migrar nada despues.
create table if not exists public.escalas_talle (
  id uuid primary key default gen_random_uuid(),
  nombre text not null check (length(trim(nombre)) > 0),
  orden integer not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.escalas_talle is
  'Conjuntos de talles que van juntos: "Calzado" (34-46), "Indumentaria" (S-XL). La categoria del producto decide cual se ofrece al cargarlo.';

create unique index if not exists escalas_talle_nombre_unico
  on public.escalas_talle (lower(trim(nombre)));

create table if not exists public.talles (
  id uuid primary key default gen_random_uuid(),
  escala_id uuid not null references public.escalas_talle(id) on delete cascade,
  valor text not null check (length(trim(valor)) > 0),
  orden integer not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

comment on column public.talles.orden is
  'Para mostrarlos como los piensa una persona: 34, 35, 36... y no 34, 340, 35, que es como los ordena el texto.';
comment on column public.talles.activo is
  'Se desactiva, no se borra: un talle que se dejo de traer sigue existiendo en las ventas viejas.';

create unique index if not exists talles_valor_unico_por_escala
  on public.talles (escala_id, lower(trim(valor)));

create index if not exists talles_por_escala on public.talles (escala_id, orden);

-- --------------------------------------------------------------------------
-- Categorias
-- --------------------------------------------------------------------------
create table if not exists public.categorias (
  id uuid primary key default gen_random_uuid(),
  nombre text not null check (length(trim(nombre)) > 0),
  escala_talle_id uuid references public.escalas_talle(id) on delete set null,
  orden integer not null default 0,
  activa boolean not null default true,
  created_at timestamptz not null default now()
);

comment on column public.categorias.escala_talle_id is
  'Que talles se ofrecen al cargar un producto de esta categoria. En null, el producto no lleva talle (una mochila, un par de cordones).';

-- El indice unico es sobre lower(trim(...)): impide que convivan "Calzado" y
-- "calzado ". No impide "Calzado" y "Calzados" —eso lo evita el desplegable,
-- que es justamente por lo que dejo de ser un campo de texto.
create unique index if not exists categorias_nombre_unico
  on public.categorias (lower(trim(nombre)));

-- --------------------------------------------------------------------------
-- Colores
-- --------------------------------------------------------------------------
create table if not exists public.colores (
  id uuid primary key default gen_random_uuid(),
  nombre text not null check (length(trim(nombre)) > 0),
  orden integer not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists colores_nombre_unico
  on public.colores (lower(trim(nombre)));

-- --------------------------------------------------------------------------
-- El producto pasa a apuntar a la categoria
-- --------------------------------------------------------------------------
-- `on delete restrict`: si una categoria esta en uso, la base no deja borrarla.
-- Para sacarla de circulacion se desactiva, y los productos que ya la tienen la
-- conservan.
alter table public.productos
  add column if not exists categoria_id uuid references public.categorias(id) on delete restrict;

create index if not exists productos_por_categoria on public.productos (categoria_id);

-- La columna vieja de texto libre se va. Se puede sacar sin cuidado porque el
-- catalogo esta vacio: hoy hay 0 productos cargados. Si hubiera datos, esto
-- seria un backfill y no un drop.
alter table public.productos drop column if exists categoria;

-- `variantes.talle` y `variantes.color` siguen siendo texto, y es a proposito.
-- Son parte de la identidad de lo que se vendio: si manana se renombra el color
-- "Bordo" a "Vino", la venta de marzo tiene que seguir diciendo "Bordo", igual
-- que la linea de venta se guarda su propia copia del costo. Las listas de
-- abajo son de donde se elige, no donde se guarda.

-- --------------------------------------------------------------------------
-- Permisos y RLS: los lee cualquier usuario activo, los edita solo el dueno
-- --------------------------------------------------------------------------
alter table public.escalas_talle enable row level security;
alter table public.talles enable row level security;
alter table public.categorias enable row level security;
alter table public.colores enable row level security;

do $$
declare t text;
begin
  foreach t in array array['escalas_talle', 'talles', 'categorias', 'colores'] loop
    execute format('drop policy if exists %I_select_usuarios_activos on public.%I', t, t);
    execute format(
      'create policy %I_select_usuarios_activos on public.%I
         for select to authenticated using (public.mi_rol() is not null)', t, t);

    execute format('drop policy if exists %I_escribe_dueno on public.%I', t, t);
    execute format(
      'create policy %I_escribe_dueno on public.%I
         for all to authenticated
         using (public.tiene_rol(array[''dueno'']))
         with check (public.tiene_rol(array[''dueno'']))', t, t);

    execute format(
      'grant select, insert, update, delete on public.%I to authenticated', t);
    execute format(
      'grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- --------------------------------------------------------------------------
-- Carga inicial
-- --------------------------------------------------------------------------
-- Se carga lo que el negocio ya sabe que usa y nada mas. Inventar categorias
-- que despues nadie usa es peor que dejarlas vacias: el dueno las agrega desde
-- la pantalla en diez segundos.
insert into public.escalas_talle (nombre, orden)
values ('Calzado', 10)
on conflict do nothing;

-- 34 a 46, que es el rango que se vende. `orden` va con el numero para que se
-- muestren en el orden que espera una persona.
insert into public.talles (escala_id, valor, orden)
select e.id, n::text, n
from public.escalas_talle e, generate_series(34, 46) as n
where lower(e.nombre) = 'calzado'
on conflict do nothing;

insert into public.categorias (nombre, escala_talle_id, orden)
select 'Calzado', e.id, 10
from public.escalas_talle e
where lower(e.nombre) = 'calzado'
on conflict do nothing;

insert into public.colores (nombre, orden)
values
  ('Negro', 10), ('Blanco', 20), ('Gris', 30), ('Beige', 40), ('Marrón', 50),
  ('Azul', 60), ('Celeste', 70), ('Verde', 80), ('Rojo', 90), ('Bordó', 100),
  ('Rosa', 110), ('Amarillo', 120), ('Naranja', 130), ('Violeta', 140),
  ('Plateado', 150), ('Dorado', 160), ('Multicolor', 170)
on conflict do nothing;
