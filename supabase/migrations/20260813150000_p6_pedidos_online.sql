-- P6, parte B: los pedidos que entran por la tienda online.
--
-- Reglas que ordenan todo lo de abajo:
--
--   1. El precio nunca viene del navegador. El comprador manda que variante y
--      cuanto quiere; la plata la calcula la base. Si no fuera asi, cualquiera
--      podria comprar unas zapatillas a un peso editando el pedido antes de
--      mandarlo.
--   2. Un pedido online NO es una venta. Reserva mercaderia. La venta se
--      registra recien cuando se entrega y se cobra, y se registra con
--      registrar_venta, la misma funcion que usa el mostrador. Un segundo
--      motor de ventas seria un segundo lugar donde arreglar cada error.
--   3. La reserva es una sola. Si el pedido ya genero una entrega, quien
--      reserva es la entrega: contar las dos cosas dejaria mercaderia trabada
--      que en realidad esta disponible.
--   4. Las funciones que abre el comprador son publicas y sin sesion. La llave
--      es el token del pedido, igual que en el seguimiento de entregas.

-- ---------------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------------

create table if not exists public.pedidos_online (
  id                  uuid primary key default gen_random_uuid(),
  numero              bigint not null,
  sucursal_id         uuid not null references public.sucursales(id),
  cliente_id          uuid references public.clientes(id),
  nombre              text not null,
  telefono            text not null,
  email               text,
  documento           text,
  entrega             text not null,
  direccion           text,
  localidad           text,
  referencia          text,
  lat                 numeric(10,7),
  lng                 numeric(10,7),
  pago                text not null,
  estado              text not null default 'pendiente',
  subtotal            numeric(12,2) not null default 0,
  costo_envio         numeric(12,2) not null default 0,
  total               numeric(12,2) not null default 0,
  venta_id            uuid references public.ventas(id),
  envio_id            uuid references public.envios(id),
  token               text not null,
  nota                text,
  mp_preference_id    text,
  mp_payment_id       text,
  pagado_at           timestamptz,
  confirmado_at       timestamptz,
  listo_at            timestamptz,
  entregado_at        timestamptz,
  cancelado_at        timestamptz,
  cancelado_por       uuid references auth.users(id),
  motivo_cancelacion  text,
  created_at          timestamptz not null default now(),
  constraint pedidos_online_entrega_valida check (entrega in ('retiro','envio')),
  constraint pedidos_online_pago_valido    check (pago in ('mercadopago','al_entregar')),
  constraint pedidos_online_estado_valido  check (estado in ('iniciado','pendiente','confirmado','listo','entregado','cancelado')),
  constraint pedidos_online_envio_con_direccion check (entrega <> 'envio' or direccion is not null),
  constraint pedidos_online_entregado_tiene_venta check (estado <> 'entregado' or venta_id is not null)
);

comment on table public.pedidos_online is
  'Pedidos que entran por la tienda online. No mueven plata ni stock: reservan. La venta se registra al entregar, con registrar_venta.';
comment on column public.pedidos_online.estado is
  'iniciado: eligio pagar con Mercado Pago y todavia no pago. pendiente: esperando que el local lo confirme. confirmado: el local lo acepto y lo esta preparando. listo: esta para retirar o ya salio. entregado: se convirtio en venta. cancelado: no va mas.';
comment on column public.pedidos_online.token is
  'La llave del link que se le manda al comprador para que vea como viene su pedido. Un uuid sin guiones: adivinarlo es tan probable como adivinar una clave de 32 caracteres.';
comment on column public.pedidos_online.pago is
  'al_entregar quiere decir que reserva y paga cuando retira o recibe. La tienda tiene que poder vender asi antes de que Mercado Pago este configurado.';

create unique index if not exists pedidos_online_numero_unico on public.pedidos_online (sucursal_id, numero);
create unique index if not exists pedidos_online_token_unico  on public.pedidos_online (token);
create index if not exists pedidos_online_estado_idx          on public.pedidos_online (estado, created_at desc);
create index if not exists pedidos_online_sucursal_idx        on public.pedidos_online (sucursal_id, created_at desc);
create index if not exists pedidos_online_cliente_idx         on public.pedidos_online (cliente_id);
create index if not exists pedidos_online_mp_payment_idx      on public.pedidos_online (mp_payment_id);

create table if not exists public.pedido_online_lineas (
  id              uuid primary key default gen_random_uuid(),
  pedido_id       uuid not null references public.pedidos_online(id) on delete cascade,
  variante_id     uuid not null references public.variantes(id),
  cantidad        integer not null,
  precio_unitario numeric(12,2) not null,
  subtotal        numeric(12,2) not null,
  constraint pedido_online_lineas_cantidad_positiva check (cantidad > 0)
);

create index if not exists pedido_online_lineas_pedido_idx  on public.pedido_online_lineas (pedido_id);
create index if not exists pedido_online_lineas_variante_idx on public.pedido_online_lineas (variante_id);

-- ---------------------------------------------------------------------------
-- 2. La reserva
-- ---------------------------------------------------------------------------
-- Se rehace la vista de disponible para que tambien descuente lo que ya
-- aparto un pedido online. Un pedido que ya genero su entrega no cuenta aca:
-- lo reserva la entrega, y sumarlo dos veces trabaria mercaderia que existe.

create or replace view public.stock_disponible as
select
  s.variante_id,
  s.sucursal_id,
  s.cantidad,
  coalesce(r.reservado, 0) + coalesce(o.reservado, 0) as reservado,
  s.cantidad - coalesce(r.reservado, 0) - coalesce(o.reservado, 0) as disponible
from public.stock s
left join (
  select el.variante_id, e.sucursal_id, sum(el.cantidad)::integer as reservado
    from public.envio_lineas el
    join public.envios e on e.id = el.envio_id
   where e.venta_id is null
     and e.estado = any (array['pendiente','preparando','en_camino'])
   group by el.variante_id, e.sucursal_id
) r on r.variante_id = s.variante_id and r.sucursal_id = s.sucursal_id
left join (
  select pl.variante_id, p.sucursal_id, sum(pl.cantidad)::integer as reservado
    from public.pedido_online_lineas pl
    join public.pedidos_online p on p.id = pl.pedido_id
   where p.venta_id is null
     and p.envio_id is null
     and p.estado = any (array['iniciado','pendiente','confirmado','listo'])
   group by pl.variante_id, p.sucursal_id
) o on o.variante_id = s.variante_id and o.sucursal_id = s.sucursal_id;

-- ---------------------------------------------------------------------------
-- 3. Permisos de tabla
-- ---------------------------------------------------------------------------
-- El pedido online se lee desde el sistema; se escribe solo por funcion. Un
-- pedido que se pueda editar a mano desde el navegador es un pedido que puede
-- quedar con un total que no coincide con sus lineas.

alter table public.pedidos_online enable row level security;
alter table public.pedido_online_lineas enable row level security;

drop policy if exists pedidos_online_select_usuarios_activos on public.pedidos_online;
create policy pedidos_online_select_usuarios_activos
  on public.pedidos_online for select to authenticated
  using (public.mi_rol() is not null);

drop policy if exists pedido_online_lineas_select_usuarios_activos on public.pedido_online_lineas;
create policy pedido_online_lineas_select_usuarios_activos
  on public.pedido_online_lineas for select to authenticated
  using (public.mi_rol() is not null);

grant select on public.pedidos_online to authenticated;
grant select on public.pedido_online_lineas to authenticated;

-- ---------------------------------------------------------------------------
-- 4. La vidriera: lo que ve cualquiera, sin sesion
-- ---------------------------------------------------------------------------

create or replace function public.tienda_config()
returns table (
  activa             boolean,
  nombre             text,
  slug               text,
  descripcion        text,
  whatsapp           text,
  instagram          text,
  email_contacto     text,
  retiro_habilitado  boolean,
  envio_habilitado   boolean,
  costo_envio        numeric,
  envio_gratis_desde numeric,
  zona_envio         text,
  mp_habilitado      boolean,
  texto_retiro       text,
  direccion_local    text,
  lat                numeric,
  lng                numeric
)
language sql
security definer
set search_path = public
as $fn$
  select c.activa, c.nombre, c.slug, c.descripcion, c.whatsapp, c.instagram,
         c.email_contacto, c.retiro_habilitado, c.envio_habilitado,
         c.costo_envio, c.envio_gratis_desde, c.zona_envio, c.mp_habilitado,
         c.texto_retiro,
         s.direccion, s.lat, s.lng
    from public.config_tienda c
    left join public.sucursales s on s.id = c.sucursal_id
   where c.id;
$fn$;

-- La grilla de la tienda. Solo productos publicados, activos, y que tengan al
-- menos un par disponible en la sucursal que atiende la tienda: ofrecer lo que
-- no hay es la forma mas rapida de perder un cliente.
create or replace function public.tienda_catalogo(
  p_buscar       text default null,
  p_categoria_id uuid default null
)
returns table (
  producto_id uuid,
  slug        text,
  nombre      text,
  marca       text,
  categoria   text,
  destacado   boolean,
  precio_min  numeric,
  precio_max  numeric,
  disponible  integer,
  imagen      text
)
language sql
security definer
set search_path = public
as $fn$
  with tienda as (
    select sucursal_id, activa from public.config_tienda where id
  )
  select
    p.id,
    p.slug,
    p.nombre,
    p.marca,
    c.nombre,
    p.destacado,
    min(v.precio),
    max(v.precio),
    sum(greatest(sd.disponible, 0))::integer,
    (select i.ruta from public.producto_imagenes i
      where i.producto_id = p.id order by i.orden, i.created_at limit 1)
  from public.productos p
  join tienda t on true
  join public.variantes v on v.producto_id = p.id and v.activa
  join public.stock_disponible sd
    on sd.variante_id = v.id and sd.sucursal_id = t.sucursal_id
  left join public.categorias c on c.id = p.categoria_id
  where t.activa
    and p.activo
    and p.publicado
    and sd.disponible > 0
    and (p_categoria_id is null or p.categoria_id = p_categoria_id)
    and (
      p_buscar is null or btrim(p_buscar) = '' or
      public.unaccent_simple(lower(p.nombre)) like '%' || public.unaccent_simple(lower(btrim(p_buscar))) || '%' or
      public.unaccent_simple(lower(coalesce(p.marca, ''))) like '%' || public.unaccent_simple(lower(btrim(p_buscar))) || '%'
    )
  group by p.id, p.slug, p.nombre, p.marca, c.nombre, p.destacado, p.orden_tienda
  order by p.destacado desc, p.orden_tienda, p.nombre;
$fn$;

-- La ficha del producto: lo que decide la compra. Devuelve una fila por talle
-- y color con lo que queda de cada uno.
create or replace function public.tienda_producto(p_slug text)
returns table (
  producto_id       uuid,
  slug              text,
  nombre            text,
  marca             text,
  categoria         text,
  descripcion       text,
  descripcion_larga text,
  variante_id       uuid,
  talle             text,
  color             text,
  codigo_barras     text,
  precio            numeric,
  disponible        integer,
  imagenes          text[]
)
language sql
security definer
set search_path = public
as $fn$
  with tienda as (
    select sucursal_id, activa from public.config_tienda where id
  )
  select
    p.id, p.slug, p.nombre, p.marca, c.nombre, p.descripcion, p.descripcion_larga,
    v.id, v.talle, v.color, v.codigo_barras, v.precio,
    greatest(coalesce(sd.disponible, 0), 0)::integer,
    (select coalesce(array_agg(i.ruta order by i.orden, i.created_at), array[]::text[])
       from public.producto_imagenes i where i.producto_id = p.id)
  from public.productos p
  join tienda t on true
  join public.variantes v on v.producto_id = p.id and v.activa
  left join public.stock_disponible sd
    on sd.variante_id = v.id and sd.sucursal_id = t.sucursal_id
  left join public.categorias c on c.id = p.categoria_id
  where t.activa and p.activo and p.publicado and p.slug = p_slug
  order by v.talle, v.color;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Crear el pedido
-- ---------------------------------------------------------------------------

create or replace function public.crear_pedido_online(
  p_lineas     jsonb,
  p_nombre     text,
  p_telefono   text,
  p_entrega    text,
  p_pago       text default 'al_entregar',
  p_email      text default null,
  p_documento  text default null,
  p_direccion  text default null,
  p_localidad  text default null,
  p_referencia text default null,
  p_lat        numeric default null,
  p_lng        numeric default null,
  p_nota       text default null
)
returns table (pedido_id uuid, numero bigint, token text, total numeric)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_cfg      public.config_tienda%rowtype;
  v_id       uuid;
  v_numero   bigint;
  v_token    text;
  v_subtotal numeric(12,2) := 0;
  v_envio    numeric(12,2) := 0;
  v_estado   text;
  v_linea    jsonb;
  v_var      record;
  v_cant     integer;
  v_disp     integer;
begin
  select * into v_cfg from public.config_tienda where id;

  if not coalesce(v_cfg.activa, false) or v_cfg.sucursal_id is null then
    raise exception 'La tienda no esta atendiendo en este momento.';
  end if;

  if coalesce(btrim(p_nombre), '') = '' or coalesce(btrim(p_telefono), '') = '' then
    raise exception 'Hace falta un nombre y un telefono para poder avisarte.';
  end if;

  if p_entrega not in ('retiro','envio') then
    raise exception 'Elegi como queres recibirlo.';
  end if;
  if p_entrega = 'retiro' and not v_cfg.retiro_habilitado then
    raise exception 'Por ahora no se puede retirar por el local.';
  end if;
  if p_entrega = 'envio' then
    if not v_cfg.envio_habilitado then
      raise exception 'Por ahora no estamos haciendo envios.';
    end if;
    if coalesce(btrim(coalesce(p_direccion, '')), '') = '' then
      raise exception 'Para el envio hace falta la direccion.';
    end if;
  end if;

  if p_pago not in ('mercadopago','al_entregar') then
    raise exception 'Forma de pago desconocida.';
  end if;
  if p_pago = 'mercadopago' and not coalesce(v_cfg.mp_habilitado, false) then
    raise exception 'El pago online todavia no esta disponible.';
  end if;

  if p_lineas is null or jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) = 0 then
    raise exception 'El pedido esta vacio.';
  end if;
  -- Tope de sentido comun: un carrito de mas de cincuenta renglones no es una
  -- compra, es alguien probando el formulario.
  if jsonb_array_length(p_lineas) > 50 then
    raise exception 'El pedido tiene demasiados productos.';
  end if;

  -- Un solo pedido a la vez por sucursal mientras se numera y se controla el
  -- stock: sin esto, dos compradores simultaneos se llevan el ultimo par.
  perform pg_advisory_xact_lock(hashtext('pedido_online:' || v_cfg.sucursal_id::text));

  select coalesce(max(po.numero), 0) + 1 into v_numero
    from public.pedidos_online po where po.sucursal_id = v_cfg.sucursal_id;

  v_token := replace(gen_random_uuid()::text, '-', '');
  v_estado := case when p_pago = 'mercadopago' then 'iniciado' else 'pendiente' end;

  insert into public.pedidos_online (
    numero, sucursal_id, nombre, telefono, email, documento,
    entrega, direccion, localidad, referencia, lat, lng,
    pago, estado, token, nota
  ) values (
    v_numero, v_cfg.sucursal_id,
    btrim(p_nombre), btrim(p_telefono),
    nullif(btrim(coalesce(p_email, '')), ''),
    nullif(btrim(coalesce(p_documento, '')), ''),
    p_entrega,
    nullif(btrim(coalesce(p_direccion, '')), ''),
    nullif(btrim(coalesce(p_localidad, '')), ''),
    nullif(btrim(coalesce(p_referencia, '')), ''),
    p_lat, p_lng,
    p_pago, v_estado, v_token,
    nullif(btrim(coalesce(p_nota, '')), '')
  ) returning id into v_id;

  for v_linea in select * from jsonb_array_elements(p_lineas) loop
    v_cant := coalesce((v_linea->>'cantidad')::integer, 0);
    if v_cant <= 0 then
      raise exception 'Una de las cantidades no es valida.';
    end if;

    -- El precio sale de aca, no del navegador.
    select v.id as id, v.precio as precio, p.nombre as nombre into v_var
      from public.variantes v
      join public.productos p on p.id = v.producto_id
     where v.id = (v_linea->>'variante_id')::uuid
       and v.activa and p.activo and p.publicado;

    if v_var.id is null then
      raise exception 'Uno de los productos ya no esta disponible.';
    end if;

    select coalesce(sd.disponible, 0) into v_disp
      from public.stock_disponible sd
     where sd.variante_id = v_var.id and sd.sucursal_id = v_cfg.sucursal_id;

    -- Las lineas que ya se cargaron de este mismo pedido cuentan como
    -- reservadas, asi que pedir dos veces el mismo par se frena aca.
    if coalesce(v_disp, 0) < v_cant then
      raise exception 'De % nos queda menos de lo que pediste.', v_var.nombre;
    end if;

    insert into public.pedido_online_lineas (pedido_id, variante_id, cantidad, precio_unitario, subtotal)
    values (v_id, v_var.id, v_cant, v_var.precio, round(v_var.precio * v_cant, 2));

    v_subtotal := v_subtotal + round(v_var.precio * v_cant, 2);
  end loop;

  if p_entrega = 'envio' then
    v_envio := coalesce(v_cfg.costo_envio, 0);
    if v_cfg.envio_gratis_desde is not null and v_subtotal >= v_cfg.envio_gratis_desde then
      v_envio := 0;
    end if;
  end if;

  update public.pedidos_online
     set subtotal = v_subtotal, costo_envio = v_envio, total = v_subtotal + v_envio
   where id = v_id;

  return query select v_id, v_numero, v_token, v_subtotal + v_envio;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. El seguimiento del comprador
-- ---------------------------------------------------------------------------

create or replace function public.seguimiento_pedido_online(p_token text)
returns table (
  numero        bigint,
  estado        text,
  entrega       text,
  pago          text,
  nombre        text,
  direccion     text,
  localidad     text,
  subtotal      numeric,
  costo_envio   numeric,
  total         numeric,
  created_at    timestamptz,
  token_envio   text,
  local_nombre  text,
  local_direccion text,
  whatsapp      text,
  texto_retiro  text,
  lineas        jsonb
)
language sql
security definer
set search_path = public
as $fn$
  select
    p.numero, p.estado, p.entrega, p.pago, p.nombre, p.direccion, p.localidad,
    p.subtotal, p.costo_envio, p.total, p.created_at,
    e.token,
    c.nombre, s.direccion, c.whatsapp, c.texto_retiro,
    (select coalesce(jsonb_agg(jsonb_build_object(
              'producto', pr.nombre,
              'talle', v.talle,
              'color', v.color,
              'cantidad', pl.cantidad,
              'precio_unitario', pl.precio_unitario,
              'subtotal', pl.subtotal
            ) order by pr.nombre), '[]'::jsonb)
       from public.pedido_online_lineas pl
       join public.variantes v on v.id = pl.variante_id
       join public.productos pr on pr.id = v.producto_id
      where pl.pedido_id = p.id)
  from public.pedidos_online p
  left join public.envios e on e.id = p.envio_id
  left join public.sucursales s on s.id = p.sucursal_id
  cross join public.config_tienda c
  where p.token = p_token and c.id;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Lo que hace el local con el pedido
-- ---------------------------------------------------------------------------

create or replace function public.cambiar_estado_pedido_online(
  p_pedido_id uuid,
  p_destino   text,
  p_motivo    text default null
) returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_p public.pedidos_online%rowtype;
begin
  if public.mi_rol() is null then
    raise exception 'No tenes permiso para tocar los pedidos de la tienda.';
  end if;

  select * into v_p from public.pedidos_online where id = p_pedido_id;
  if not found then
    raise exception 'Ese pedido no existe.';
  end if;
  if v_p.estado in ('entregado','cancelado') then
    raise exception 'Ese pedido ya esta cerrado (%).', v_p.estado;
  end if;

  if p_destino = 'confirmado' and v_p.estado in ('iniciado','pendiente') then
    update public.pedidos_online set estado = 'confirmado', confirmado_at = now() where id = p_pedido_id;

  elsif p_destino = 'listo' and v_p.estado in ('pendiente','confirmado') then
    update public.pedidos_online set estado = 'listo', listo_at = now() where id = p_pedido_id;

  elsif p_destino = 'cancelado' then
    if coalesce(btrim(coalesce(p_motivo, '')), '') = '' then
      raise exception 'Para cancelar un pedido hay que decir por que.';
    end if;
    update public.pedidos_online
       set estado = 'cancelado', cancelado_at = now(), cancelado_por = auth.uid(),
           motivo_cancelacion = btrim(p_motivo)
     where id = p_pedido_id;

  else
    raise exception 'De % no se puede pasar a %.', v_p.estado, p_destino;
  end if;
end;
$fn$;

-- Genera la entrega a domicilio del pedido, con sus links de seguimiento. A
-- partir de aca la reserva la lleva la entrega y no el pedido.
create or replace function public.generar_envio_pedido_online(
  p_pedido_id       uuid,
  p_programado_para date default null,
  p_franja          text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_p      public.pedidos_online%rowtype;
  v_envio  uuid;
  v_lineas jsonb;
begin
  if public.mi_rol() is null then
    raise exception 'No tenes permiso para tocar los pedidos de la tienda.';
  end if;

  select * into v_p from public.pedidos_online where id = p_pedido_id;
  if not found then
    raise exception 'Ese pedido no existe.';
  end if;
  if v_p.entrega <> 'envio' then
    raise exception 'Ese pedido es para retirar por el local.';
  end if;
  if v_p.envio_id is not null then
    return v_p.envio_id;
  end if;
  if v_p.estado in ('entregado','cancelado') then
    raise exception 'Ese pedido ya esta cerrado (%).', v_p.estado;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('variante_id', pl.variante_id, 'cantidad', pl.cantidad)), '[]'::jsonb)
    into v_lineas
    from public.pedido_online_lineas pl where pl.pedido_id = p_pedido_id;

  v_envio := public.guardar_envio(
    null, v_p.sucursal_id, v_p.nombre, v_p.direccion,
    v_lineas, null, v_p.cliente_id, v_p.telefono, v_p.referencia,
    v_p.localidad, v_p.lat, v_p.lng, p_programado_para, p_franja,
    v_p.costo_envio,
    'Pedido online #' || v_p.numero::text
  );

  update public.pedidos_online
     set envio_id = v_envio,
         estado = case when estado in ('iniciado','pendiente') then 'confirmado' else estado end,
         confirmado_at = coalesce(confirmado_at, now())
   where id = p_pedido_id;

  return v_envio;
end;
$fn$;

-- El cierre: el pedido se convierte en venta. Una sola puerta para que salga
-- stock y entre plata, la misma que el mostrador.
create or replace function public.cerrar_pedido_online(
  p_pedido_id uuid,
  p_pagos     jsonb default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_p      public.pedidos_online%rowtype;
  v_lineas jsonb;
  v_pagos  jsonb;
  v_venta  uuid;
  v_mp     uuid;
  v_hoy    numeric(12,2);
  v_desc   numeric(12,2);
begin
  if public.mi_rol() is null then
    raise exception 'No tenes permiso para cerrar pedidos de la tienda.';
  end if;

  select * into v_p from public.pedidos_online where id = p_pedido_id;
  if not found then
    raise exception 'Ese pedido no existe.';
  end if;
  if v_p.estado = 'entregado' then
    return v_p.venta_id;
  end if;
  if v_p.estado = 'cancelado' then
    raise exception 'Ese pedido esta cancelado.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'variante_id', pl.variante_id,
           'cantidad', pl.cantidad
         )), '[]'::jsonb)
    into v_lineas
    from public.pedido_online_lineas pl where pl.pedido_id = p_pedido_id;

  if v_lineas = '[]'::jsonb then
    raise exception 'Ese pedido no tiene productos.';
  end if;

  -- registrar_venta siempre toma el precio de hoy, y con razon: en el
  -- mostrador el precio es el del momento. Pero el comprador online ya vio un
  -- numero y sobre ese decidio. Si la lista subio entre medio, la diferencia
  -- se pone como descuento y se le cobra lo que se le prometio.
  select coalesce(sum(round(v.precio * pl.cantidad, 2)), 0) into v_hoy
    from public.pedido_online_lineas pl
    join public.variantes v on v.id = pl.variante_id
   where pl.pedido_id = p_pedido_id;

  v_desc := v_hoy - v_p.subtotal;
  if v_desc < 0 then
    raise exception 'El precio de un producto bajo despues de que el cliente compro. Cerra este pedido desde Ventas para poder devolverle la diferencia.';
  end if;

  -- Si ya pago por Mercado Pago la plata entro por ahi y no hay que
  -- preguntarle nada al vendedor: el medio de pago ya esta decidido. Lo que
  -- cobra la venta es la mercaderia; el costo del envio queda anotado en la
  -- entrega, con el mismo criterio que las entregas del mostrador.
  if p_pagos is not null and jsonb_typeof(p_pagos) = 'array' and jsonb_array_length(p_pagos) > 0 then
    v_pagos := p_pagos;
  elsif v_p.pago = 'mercadopago' and v_p.pagado_at is not null then
    select id into v_mp from public.medios_pago where lower(nombre) = 'mercado pago' and activo limit 1;
    if v_mp is null then
      raise exception 'Falta el medio de pago "Mercado Pago" en la configuracion.';
    end if;
    v_pagos := jsonb_build_array(jsonb_build_object('medio_pago_id', v_mp, 'monto', v_p.subtotal));
  else
    raise exception 'Falta decir como se cobro este pedido.';
  end if;

  -- La misma puerta que el mostrador: una sola funcion mueve stock y plata.
  v_venta := public.registrar_venta(
    v_p.sucursal_id,
    v_lineas,
    v_pagos,
    v_p.cliente_id,
    v_desc,
    'Pedido online #' || v_p.numero::text,
    null
  );

  update public.pedidos_online
     set venta_id = v_venta, estado = 'entregado', entregado_at = now()
   where id = p_pedido_id;

  if v_p.envio_id is not null then
    perform public.vincular_venta_a_envio(v_p.envio_id, v_venta);
  end if;

  return v_venta;
end;
$fn$;

-- Un pedido que eligio pagar online y nunca pago no puede quedar reservando
-- mercaderia para siempre. Se sueltan solos despues de una hora.
create or replace function public.soltar_pedidos_online_vencidos()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_n integer;
begin
  update public.pedidos_online
     set estado = 'cancelado', cancelado_at = now(),
         motivo_cancelacion = 'No se completo el pago online dentro de la hora.'
   where estado = 'iniciado'
     and pagado_at is null
     and created_at < now() - interval '1 hour';
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. Permisos de ejecucion
-- ---------------------------------------------------------------------------
-- Publicas de verdad: son las que abre el link de la tienda. Ninguna de ellas
-- escribe plata ni deja ver datos de otro comprador.

grant execute on function public.tienda_config() to anon, authenticated;
grant execute on function public.tienda_catalogo(text, uuid) to anon, authenticated;
grant execute on function public.tienda_producto(text) to anon, authenticated;
grant execute on function public.crear_pedido_online(jsonb, text, text, text, text, text, text, text, text, text, numeric, numeric, text) to anon, authenticated;
grant execute on function public.seguimiento_pedido_online(text) to anon, authenticated;

-- Las del mostrador: sesion obligatoria.
revoke execute on function public.cambiar_estado_pedido_online(uuid, text, text) from public, anon;
grant execute on function public.cambiar_estado_pedido_online(uuid, text, text) to authenticated;

revoke execute on function public.generar_envio_pedido_online(uuid, date, text) from public, anon;
grant execute on function public.generar_envio_pedido_online(uuid, date, text) to authenticated;

revoke execute on function public.cerrar_pedido_online(uuid, jsonb) from public, anon;
grant execute on function public.cerrar_pedido_online(uuid, jsonb) to authenticated;

revoke execute on function public.soltar_pedidos_online_vencidos() from public;
grant execute on function public.soltar_pedidos_online_vencidos() to anon, authenticated;
