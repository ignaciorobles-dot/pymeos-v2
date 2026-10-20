-- P6, parte A: el catalogo que se publica en la tienda online.
--
-- Decision de fondo: la tienda NO tiene catalogo propio. Es el mismo producto
-- del mostrador con dos cosas mas: fotos y un interruptor de publicado. Dos
-- catalogos separados terminan siempre igual: a la semana el precio de la
-- tienda no coincide con el del local y el stock miente.
--
-- Por eso aca no se crea ninguna tabla de productos: se le agregan a
-- "productos" las columnas que una tienda necesita y que en el mostrador no
-- hacen falta.

-- ---------------------------------------------------------------------------
-- 1. Columnas de tienda sobre el producto que ya existe
-- ---------------------------------------------------------------------------

alter table public.productos
  add column if not exists publicado boolean not null default false,
  add column if not exists descripcion_larga text,
  add column if not exists slug text,
  add column if not exists destacado boolean not null default false,
  add column if not exists orden_tienda integer not null default 0;

comment on column public.productos.publicado is
  'Si esta en true el producto aparece en la tienda online. Nada se publica solo: el duenno lo prende a mano cuando el producto tiene foto y descripcion.';
comment on column public.productos.descripcion_larga is
  'El texto que lee el comprador. La descripcion corta sigue siendo la del mostrador.';
comment on column public.productos.slug is
  'Parte de la direccion web del producto. Se calcula del nombre pero queda guardado: si mannana se corrige el nombre, el link viejo que alguien compartio en Instagram no se rompe.';
comment on column public.productos.destacado is
  'Aparece primero en la portada de la tienda.';

-- El slug tiene que ser unico entre lo publicado: dos links iguales apuntando
-- a productos distintos es un error que solo se descubre cuando un cliente
-- compra lo que no era.
create unique index if not exists productos_slug_unico
  on public.productos (slug)
  where slug is not null and activo;

-- No hay extension unaccent instalada y no vale la pena pedirla por esto:
-- alcanza con traducir las vocales acentuadas y la enne, que es todo lo que
-- aparece en nombres de calzado en castellano.
create or replace function public.unaccent_simple(p_texto text)
returns text
language sql
immutable
as $$
  select translate(
    coalesce(p_texto, ''),
    'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
    'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC'
  );
$$;

-- Convierte "Zapatilla Nike Air Max 90" en "zapatilla-nike-air-max-90".
-- Se saca de la base y no del navegador para que dos personas cargando al
-- mismo tiempo no generen dos formas distintas del mismo nombre.
create or replace function public.slug_de(p_texto text)
returns text
language sql
immutable
as $$
  select nullif(
    trim(both '-' from
      regexp_replace(
        lower(public.unaccent_simple(coalesce(p_texto, ''))),
        '[^a-z0-9]+', '-', 'g'
      )
    ),
    ''
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. Fotos del producto
-- ---------------------------------------------------------------------------
-- Una tienda sin fotos no vende. Se guardan en Storage y aca queda el orden:
-- la primera es la que se ve en la grilla.

create table if not exists public.producto_imagenes (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references public.productos(id) on delete cascade,
  ruta text not null,
  alt text,
  orden integer not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.producto_imagenes is
  'Fotos del producto para la tienda online. "ruta" es la ubicacion dentro del bucket "productos" de Storage, no una URL completa: si mannana cambia el dominio de Storage no hay que reescribir la tabla.';

create index if not exists producto_imagenes_producto_idx
  on public.producto_imagenes (producto_id, orden);

alter table public.producto_imagenes enable row level security;

drop policy if exists producto_imagenes_select_usuarios_activos on public.producto_imagenes;
create policy producto_imagenes_select_usuarios_activos
  on public.producto_imagenes for select to authenticated
  using (public.mi_rol() is not null);

drop policy if exists producto_imagenes_escribe_dueno on public.producto_imagenes;
create policy producto_imagenes_escribe_dueno
  on public.producto_imagenes for all to authenticated
  using (public.tiene_rol(array['dueno']))
  with check (public.tiene_rol(array['dueno']));

grant select, insert, update, delete on public.producto_imagenes to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Configuracion de la tienda
-- ---------------------------------------------------------------------------
-- Fila unica. La tienda es una sola: el negocio tiene dos sucursales pero una
-- sola direccion web y un solo Instagram.

create table if not exists public.config_tienda (
  id boolean primary key default true,
  activa boolean not null default false,
  nombre text not null default 'Tienda',
  slug text not null default 'tienda',
  descripcion text,
  sucursal_id uuid references public.sucursales(id),
  whatsapp text,
  instagram text,
  email_contacto text,
  retiro_habilitado boolean not null default true,
  envio_habilitado boolean not null default false,
  costo_envio numeric(12,2) not null default 0,
  envio_gratis_desde numeric(12,2),
  zona_envio text,
  mp_habilitado boolean not null default false,
  texto_retiro text,
  actualizado_at timestamptz not null default now(),
  constraint config_tienda_fila_unica check (id),
  constraint config_tienda_slug_valido check (slug = public.slug_de(slug))
);

comment on table public.config_tienda is
  'Fila unica con la configuracion de la tienda online.';
comment on column public.config_tienda.sucursal_id is
  'La sucursal que atiende la tienda. De ahi sale el stock que se muestra y ahi se descuenta lo vendido. Es una decision del duenno: sin esto, una compra online no sabe de que deposito salio.';
comment on column public.config_tienda.mp_habilitado is
  'Cobro con Mercado Pago. Arranca apagado a proposito: la tienda tiene que funcionar antes de configurar Mercado Pago, reservando y cobrando al retirar.';
comment on column public.config_tienda.activa is
  'Mientras esta en false la tienda no atiende. Sirve para cargar productos con calma antes de publicarla.';

alter table public.config_tienda enable row level security;

drop policy if exists config_tienda_select_usuarios_activos on public.config_tienda;
create policy config_tienda_select_usuarios_activos
  on public.config_tienda for select to authenticated
  using (public.mi_rol() is not null);

drop policy if exists config_tienda_escribe_dueno on public.config_tienda;
create policy config_tienda_escribe_dueno
  on public.config_tienda for all to authenticated
  using (public.tiene_rol(array['dueno']))
  with check (public.tiene_rol(array['dueno']));

grant select, insert, update on public.config_tienda to authenticated;

-- La fila arranca existiendo: una pantalla de configuracion que a veces tiene
-- fila y a veces no obliga a escribir dos caminos para nada.
insert into public.config_tienda (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Bucket de fotos
-- ---------------------------------------------------------------------------
-- Publico de lectura: son fotos de productos que se van a compartir en
-- Instagram y WhatsApp, no hay nada privado. Escribir solo el duenno.

insert into storage.buckets (id, name, public)
values ('productos', 'productos', true)
on conflict (id) do nothing;

drop policy if exists productos_fotos_lectura_publica on storage.objects;
create policy productos_fotos_lectura_publica
  on storage.objects for select to public
  using (bucket_id = 'productos');

drop policy if exists productos_fotos_escribe_dueno on storage.objects;
create policy productos_fotos_escribe_dueno
  on storage.objects for all to authenticated
  using (bucket_id = 'productos' and public.tiene_rol(array['dueno']))
  with check (bucket_id = 'productos' and public.tiene_rol(array['dueno']));

-- ---------------------------------------------------------------------------
-- 5. Guardar la parte de tienda de un producto
-- ---------------------------------------------------------------------------
-- Una sola puerta para publicar: asi el slug siempre se calcula igual y nunca
-- se publica un producto sin nombre.

create or replace function public.guardar_tienda_producto(
  p_producto_id uuid,
  p_publicado boolean,
  p_descripcion_larga text default null,
  p_destacado boolean default false,
  p_orden_tienda integer default 0
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nombre text;
  v_slug text;
  v_sufijo integer := 0;
begin
  if not public.tiene_rol(array['dueno']) then
    raise exception 'Solo un duenno puede publicar productos en la tienda.';
  end if;

  -- El slug se calcula una sola vez y despues no se toca: cambiarlo romperia
  -- los links que ya se compartieron.
  select nombre, slug into v_nombre, v_slug from public.productos where id = p_producto_id;
  if v_nombre is null then
    raise exception 'No existe el producto.';
  end if;

  if v_slug is null then
    v_slug := coalesce(public.slug_de(v_nombre), 'producto');
    -- Dos productos pueden llamarse parecido: se numera el segundo.
    while exists (select 1 from public.productos where slug = v_slug and id <> p_producto_id) loop
      v_sufijo := v_sufijo + 1;
      v_slug := coalesce(public.slug_de(v_nombre), 'producto') || '-' || v_sufijo::text;
    end loop;
  end if;

  update public.productos
     set publicado = coalesce(p_publicado, publicado),
         descripcion_larga = coalesce(p_descripcion_larga, descripcion_larga),
         destacado = coalesce(p_destacado, false),
         orden_tienda = coalesce(p_orden_tienda, 0),
         slug = v_slug
   where id = p_producto_id;
end;
$$;

revoke execute on function public.guardar_tienda_producto(uuid, boolean, text, boolean, integer) from public, anon;
grant execute on function public.guardar_tienda_producto(uuid, boolean, text, boolean, integer) to authenticated;

grant execute on function public.slug_de(text) to authenticated, anon;
grant execute on function public.unaccent_simple(text) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 6. Guardar la configuracion de la tienda
-- ---------------------------------------------------------------------------

create or replace function public.guardar_config_tienda(
  p_activa boolean,
  p_nombre text,
  p_slug text,
  p_sucursal_id uuid,
  p_descripcion text default null,
  p_whatsapp text default null,
  p_instagram text default null,
  p_email_contacto text default null,
  p_retiro_habilitado boolean default true,
  p_envio_habilitado boolean default false,
  p_costo_envio numeric default 0,
  p_envio_gratis_desde numeric default null,
  p_zona_envio text default null,
  p_texto_retiro text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text;
begin
  if not public.tiene_rol(array['dueno']) then
    raise exception 'Solo un duenno puede configurar la tienda.';
  end if;

  v_slug := public.slug_de(p_slug);
  if v_slug is null then
    raise exception 'La direccion de la tienda no puede quedar vacia.';
  end if;

  if coalesce(p_activa, false) and p_sucursal_id is null then
    raise exception 'Antes de abrir la tienda hay que elegir de que sucursal sale la mercaderia.';
  end if;

  if coalesce(p_activa, false) and not (coalesce(p_retiro_habilitado, false) or coalesce(p_envio_habilitado, false)) then
    raise exception 'La tienda necesita al menos una forma de entrega: retiro en el local o envio.';
  end if;

  update public.config_tienda
     set activa = coalesce(p_activa, false),
         nombre = coalesce(nullif(btrim(p_nombre), ''), nombre),
         slug = v_slug,
         descripcion = p_descripcion,
         sucursal_id = p_sucursal_id,
         whatsapp = p_whatsapp,
         instagram = p_instagram,
         email_contacto = p_email_contacto,
         retiro_habilitado = coalesce(p_retiro_habilitado, true),
         envio_habilitado = coalesce(p_envio_habilitado, false),
         costo_envio = coalesce(p_costo_envio, 0),
         envio_gratis_desde = p_envio_gratis_desde,
         zona_envio = p_zona_envio,
         texto_retiro = p_texto_retiro,
         actualizado_at = now()
   where id;
end;
$$;

revoke execute on function public.guardar_config_tienda(boolean, text, text, uuid, text, text, text, text, boolean, boolean, numeric, numeric, text, text) from public, anon;
grant execute on function public.guardar_config_tienda(boolean, text, text, uuid, text, text, text, text, boolean, boolean, numeric, numeric, text, text) to authenticated;
