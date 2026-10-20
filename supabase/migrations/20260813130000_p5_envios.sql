-- P5 (2 de 2) - Entregas: sacar la mercaderia del local y que el cliente vea donde va.
--
-- El reparto lo hace gente de la casa, no una empresa de logistica. Eso define
-- todo lo demas: el GPS no se le compra a nadie, sale del celular del que
-- reparte. Abre un link, aprieta "Empezar reparto" y el navegador va publicando
-- su posicion. El cliente abre otro link y ve el punto moverse. Sin apps, sin
-- cuentas, sin abono mensual.
--
-- Dos secretos distintos, a proposito:
--   token            -> el que se le pasa al cliente. Solo lee.
--   token_repartidor -> el que se le pasa al cadete. Publica posicion y cambia estado.
-- Si el cliente reenvia su link a un grupo de WhatsApp, no pasa nada.
--
-- Un envio puede nacer de una venta ya cobrada, o de un pedido por WhatsApp que
-- todavia no se cobro. En el segundo caso la mercaderia NO se descuenta: queda
-- reservada. El stock se mueve cuando se registra la venta, nunca antes: esa es
-- la regla de toda la base y no se rompe por comodidad.

create table if not exists public.envios (
  id                 uuid primary key default gen_random_uuid(),
  numero             bigint not null,
  sucursal_id        uuid not null references public.sucursales(id),
  venta_id           uuid references public.ventas(id),
  cliente_id         uuid references public.clientes(id),
  destinatario       text not null,
  telefono           text,
  direccion          text not null,
  referencia         text,
  localidad          text,
  lat                numeric(10,7),
  lng                numeric(10,7),
  estado             text not null default 'pendiente',
  repartidor_id      uuid references public.usuarios(user_id),
  token              text not null,
  token_repartidor   text not null,
  programado_para    date,
  franja             text,
  costo_envio        numeric(12,2) not null default 0 check (costo_envio >= 0),
  nota               text,
  salida_at          timestamptz,
  entrega_at         timestamptz,
  recibido_por       text,
  motivo_no_entrega  text,
  cancelado_at       timestamptz,
  cancelado_por      uuid references public.usuarios(user_id),
  motivo_cancelacion text,
  usuario_id         uuid references public.usuarios(user_id),
  created_at         timestamptz not null default now(),

  constraint envios_estado_valido check (
    estado in ('pendiente','preparando','en_camino','entregado','no_entregado','cancelado')
  ),
  constraint envios_franja_valida check (
    franja is null or franja in ('mañana','tarde','todo_el_dia')
  ),
  -- Entregado sin venta seria mercaderia que salio del local sin quedar
  -- registrada en ningun lado. Con eso no se puede cerrar una caja.
  constraint envios_entregado_tiene_venta check (
    estado <> 'entregado' or venta_id is not null
  )
);

comment on table public.envios is
  'Una entrega a domicilio. Si no tiene venta asociada, la mercaderia esta reservada, no descontada.';
comment on column public.envios.token is
  'Secreto del link que ve el cliente. Solo lectura: estado y ultima posicion.';
comment on column public.envios.token_repartidor is
  'Secreto del link del celular que reparte. Publica posicion y mueve el estado. No se le pasa al cliente.';
comment on column public.envios.lat is
  'Destino, si alguien lo marco en el mapa. Sin esto el seguimiento igual funciona: se ve el punto del repartidor moverse.';

create unique index if not exists envios_numero_unico   on public.envios (sucursal_id, numero);
create unique index if not exists envios_token_unico    on public.envios (token);
create unique index if not exists envios_token_rep_unico on public.envios (token_repartidor);
create index if not exists envios_abiertos_idx
  on public.envios (sucursal_id, programado_para)
  where estado in ('pendiente','preparando','en_camino');
create index if not exists envios_por_venta_idx  on public.envios (venta_id);
create index if not exists envios_por_cliente_idx on public.envios (cliente_id, created_at desc);

create table if not exists public.envio_lineas (
  id          uuid primary key default gen_random_uuid(),
  envio_id    uuid not null references public.envios(id) on delete cascade,
  variante_id uuid not null references public.variantes(id),
  cantidad    integer not null check (cantidad > 0)
);

create unique index if not exists envio_lineas_unicas
  on public.envio_lineas (envio_id, variante_id);
create index if not exists envio_lineas_por_variante_idx
  on public.envio_lineas (variante_id);

-- Las posiciones del celular que reparte. Se guardan todas, no solo la ultima:
-- si un cliente dice "nunca pasaron por mi casa", el recorrido esta.
create table if not exists public.envio_posiciones (
  id          uuid primary key default gen_random_uuid(),
  envio_id    uuid not null references public.envios(id) on delete cascade,
  lat         numeric(10,7) not null,
  lng         numeric(10,7) not null,
  precision_m numeric(8,1),
  created_at  timestamptz not null default now()
);

create index if not exists envio_posiciones_recorrido_idx
  on public.envio_posiciones (envio_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Lo que hay contra lo que se puede vender
-- ---------------------------------------------------------------------------
/**
 * stock.cantidad es lo que hay fisicamente en el deposito. Pero si tres pares
 * ya estan prometidos para repartir esta tarde, vender esos tres pares en el
 * mostrador es prometer dos veces lo mismo. "disponible" es lo que se puede
 * comprometer sin quedar mal con nadie.
 */
create or replace view public.stock_disponible
with (security_invoker = true) as
select
  s.variante_id,
  s.sucursal_id,
  s.cantidad,
  coalesce(r.reservado, 0)::integer as reservado,
  (s.cantidad - coalesce(r.reservado, 0))::integer as disponible
from public.stock s
left join (
  select el.variante_id, e.sucursal_id, sum(el.cantidad)::integer as reservado
    from public.envio_lineas el
    join public.envios e on e.id = el.envio_id
   -- Solo reserva lo que todavia no se cobro: con venta hecha el stock ya bajo.
   where e.venta_id is null
     and e.estado in ('pendiente','preparando','en_camino')
   group by el.variante_id, e.sucursal_id
) r on r.variante_id = s.variante_id and r.sucursal_id = s.sucursal_id;

comment on view public.stock_disponible is
  'Stock fisico, lo reservado por entregas sin cobrar, y la diferencia: lo que realmente se puede vender.';

-- ---------------------------------------------------------------------------
-- Crear o corregir una entrega
-- ---------------------------------------------------------------------------
create or replace function public.guardar_envio(
  p_envio_id        uuid,
  p_sucursal_id     uuid,
  p_destinatario    text,
  p_direccion       text,
  p_lineas          jsonb default null,
  p_venta_id        uuid default null,
  p_cliente_id      uuid default null,
  p_telefono        text default null,
  p_referencia      text default null,
  p_localidad       text default null,
  p_lat             numeric default null,
  p_lng             numeric default null,
  p_programado_para date default null,
  p_franja          text default null,
  p_costo_envio     numeric default 0,
  p_nota            text default null
) returns uuid
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_usuario uuid := auth.uid();
  v_id      uuid := p_envio_id;
  v_numero  bigint;
  v_estado  text;
  v_linea   jsonb;
begin
  if public.mi_rol() is null then
    raise exception 'Hay que estar identificado para armar una entrega.';
  end if;
  if btrim(coalesce(p_destinatario, '')) = '' then
    raise exception 'Falta a nombre de quien va la entrega.';
  end if;
  if btrim(coalesce(p_direccion, '')) = '' then
    raise exception 'Sin direccion no hay entrega que hacer.';
  end if;
  if not exists (select 1 from public.sucursales where id = p_sucursal_id and activa) then
    raise exception 'La sucursal no existe o esta desactivada.';
  end if;

  if v_id is null then
    perform pg_advisory_xact_lock(hashtext('envio:' || p_sucursal_id::text));
    select coalesce(max(numero), 0) + 1 into v_numero
      from public.envios where sucursal_id = p_sucursal_id;

    insert into public.envios (
      numero, sucursal_id, venta_id, cliente_id, destinatario, telefono,
      direccion, referencia, localidad, lat, lng, programado_para, franja,
      costo_envio, nota, usuario_id,
      -- Dos secretos independientes. Un uuid sin guiones alcanza y sobra:
      -- adivinarlo es tan probable como adivinar una clave de 32 caracteres.
      token, token_repartidor
    ) values (
      v_numero, p_sucursal_id, p_venta_id, p_cliente_id,
      btrim(p_destinatario), nullif(btrim(coalesce(p_telefono, '')), ''),
      btrim(p_direccion), nullif(btrim(coalesce(p_referencia, '')), ''),
      nullif(btrim(coalesce(p_localidad, '')), ''),
      p_lat, p_lng, p_programado_para, p_franja,
      round(coalesce(p_costo_envio, 0), 2),
      nullif(btrim(coalesce(p_nota, '')), ''), v_usuario,
      replace(gen_random_uuid()::text, '-', ''),
      replace(gen_random_uuid()::text, '-', '')
    ) returning id into v_id;
  else
    select estado into v_estado from public.envios where id = v_id;
    if not found then
      raise exception 'Esa entrega no existe.';
    end if;
    if v_estado in ('entregado','cancelado') then
      raise exception 'Esta entrega ya esta cerrada (%).', v_estado;
    end if;

    update public.envios
       set venta_id        = coalesce(p_venta_id, venta_id),
           cliente_id      = p_cliente_id,
           destinatario    = btrim(p_destinatario),
           telefono        = nullif(btrim(coalesce(p_telefono, '')), ''),
           direccion       = btrim(p_direccion),
           referencia      = nullif(btrim(coalesce(p_referencia, '')), ''),
           localidad       = nullif(btrim(coalesce(p_localidad, '')), ''),
           lat             = p_lat,
           lng             = p_lng,
           programado_para = p_programado_para,
           franja          = p_franja,
           costo_envio     = round(coalesce(p_costo_envio, 0), 2),
           nota            = nullif(btrim(coalesce(p_nota, '')), '')
     where id = v_id;
  end if;

  -- Las lineas se reescriben enteras, o no se tocan si vienen vacias. Un envio
  -- creado desde una venta puede no traerlas: la venta ya dice que se llevo.
  if p_lineas is not null then
    delete from public.envio_lineas where envio_id = v_id;
    for v_linea in select * from jsonb_array_elements(p_lineas) loop
      insert into public.envio_lineas (envio_id, variante_id, cantidad)
      values (v_id, (v_linea->>'variante_id')::uuid, (v_linea->>'cantidad')::integer);
    end loop;
  end if;

  return v_id;
end;
$$;

create or replace function public.asignar_repartidor(
  p_envio_id     uuid,
  p_repartidor_id uuid
) returns void
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
begin
  if public.mi_rol() is null then
    raise exception 'Hay que estar identificado.';
  end if;
  if p_repartidor_id is not null
     and not exists (select 1 from public.usuarios where user_id = p_repartidor_id and activo) then
    raise exception 'Esa persona no esta activa en el sistema.';
  end if;

  update public.envios set repartidor_id = p_repartidor_id
   where id = p_envio_id and estado not in ('entregado','cancelado');

  if not found then
    raise exception 'Esa entrega no existe o ya esta cerrada.';
  end if;
end;
$$;

/**
 * Ata una venta a una entrega que se armo antes de cobrar. En cuanto queda
 * atada, la reserva se termina sola: el stock ya bajo con la venta, y contarlo
 * dos veces mostraria menos mercaderia de la que hay.
 */
create or replace function public.vincular_venta_a_envio(
  p_envio_id uuid,
  p_venta_id uuid
) returns void
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
begin
  if public.mi_rol() is null then
    raise exception 'Hay que estar identificado.';
  end if;
  if not exists (select 1 from public.ventas where id = p_venta_id and anulada_at is null) then
    raise exception 'Esa venta no existe o esta anulada.';
  end if;

  update public.envios set venta_id = p_venta_id
   where id = p_envio_id and estado <> 'cancelado';

  if not found then
    raise exception 'Esa entrega no existe o esta cancelada.';
  end if;
end;
$$;

create or replace function public.cambiar_estado_envio(
  p_envio_id    uuid,
  p_destino     text,
  p_motivo      text default null,
  p_recibido_por text default null
) returns void
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_envio public.envios%rowtype;
begin
  if public.mi_rol() is null then
    raise exception 'Hay que estar identificado.';
  end if;

  select * into v_envio from public.envios where id = p_envio_id;
  if not found then
    raise exception 'Esa entrega no existe.';
  end if;

  perform public.mover_envio(v_envio, p_destino, p_motivo, p_recibido_por);
end;
$$;

/**
 * El motor de estados, aparte, porque lo usan dos puertas distintas: la
 * pantalla del local y el celular del repartidor. Una sola definicion de que
 * transicion vale evita que por un lado se pueda hacer algo que por el otro no.
 */
create or replace function public.mover_envio(
  p_envio        public.envios,
  p_destino      text,
  p_motivo       text default null,
  p_recibido_por text default null,
  p_usuario      uuid default null
) returns void
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_estado text := p_envio.estado;
begin
  if v_estado in ('entregado','cancelado') then
    raise exception 'Esta entrega ya esta cerrada (%).', v_estado;
  end if;

  if p_destino = 'preparando' and v_estado = 'pendiente' then
    update public.envios set estado = 'preparando' where id = p_envio.id;

  elsif p_destino = 'en_camino' and v_estado in ('pendiente','preparando') then
    update public.envios set estado = 'en_camino', salida_at = now() where id = p_envio.id;

  elsif p_destino = 'entregado' and v_estado in ('preparando','en_camino') then
    if p_envio.venta_id is null then
      raise exception 'Antes de dar por entregado hay que registrar la venta: si no, sale mercaderia del deposito sin quedar anotada en ningun lado.';
    end if;
    update public.envios
       set estado = 'entregado', entrega_at = now(),
           recibido_por = nullif(btrim(coalesce(p_recibido_por, '')), '')
     where id = p_envio.id;

  elsif p_destino = 'no_entregado' and v_estado in ('preparando','en_camino') then
    if btrim(coalesce(p_motivo, '')) = '' then
      raise exception 'Hay que decir por que no se pudo entregar: no habia nadie, direccion equivocada, lo que sea.';
    end if;
    update public.envios
       set estado = 'no_entregado', motivo_no_entrega = btrim(p_motivo)
     where id = p_envio.id;

  elsif p_destino = 'cancelado' then
    if btrim(coalesce(p_motivo, '')) = '' then
      raise exception 'Hay que decir por que se cancela.';
    end if;
    update public.envios
       set estado = 'cancelado', cancelado_at = now(),
           cancelado_por = coalesce(p_usuario, auth.uid()),
           motivo_cancelacion = btrim(p_motivo)
     where id = p_envio.id;

  -- Un "no entregado" se reintenta al dia siguiente. No se arma otro envio:
  -- perderia el historial de que ya se intento una vez.
  elsif p_destino = 'pendiente' and v_estado = 'no_entregado' then
    update public.envios
       set estado = 'pendiente', motivo_no_entrega = null, salida_at = null
     where id = p_envio.id;

  else
    raise exception 'Una entrega % no puede pasar a %.', v_estado, p_destino;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Las tres puertas publicas: solo se abren con el token
-- ---------------------------------------------------------------------------
/**
 * Lo que ve el cliente. Devuelve poco a proposito: estado, a donde va, y donde
 * anda el que reparte. Ni el telefono del cliente, ni que se compro, ni cuanto
 * salio. El link puede terminar en cualquier lado.
 */
create or replace function public.seguimiento_envio(p_token text)
returns table (
  numero         bigint,
  estado         text,
  destinatario   text,
  direccion      text,
  localidad      text,
  destino_lat    numeric,
  destino_lng    numeric,
  repartidor     text,
  salida_at      timestamptz,
  entrega_at     timestamptz,
  programado_para date,
  franja         text,
  origen_lat     numeric,
  origen_lng     numeric,
  local_nombre   text,
  ultima_lat     numeric,
  ultima_lng     numeric,
  ultima_at      timestamptz
)
language sql security definer set search_path to 'public','pg_temp'
stable
as $$
  select
    e.numero, e.estado,
    -- Solo el nombre de pila: el apellido en una pantalla publica no suma nada.
    split_part(e.destinatario, ' ', 1),
    e.direccion, e.localidad, e.lat, e.lng,
    split_part(coalesce(u.nombre, ''), ' ', 1),
    e.salida_at, e.entrega_at, e.programado_para, e.franja,
    s.lat, s.lng, s.nombre,
    p.lat, p.lng, p.created_at
  from public.envios e
  left join public.usuarios u  on u.user_id = e.repartidor_id
  left join public.sucursales s on s.id = e.sucursal_id
  left join lateral (
    select lat, lng, created_at
      from public.envio_posiciones
     where envio_id = e.id
     order by created_at desc
     limit 1
  ) p on true
  where e.token = p_token;
$$;

/**
 * Lo que ve el celular que reparte. Aca si va el telefono y que hay que
 * entregar: lo necesita para tocar el timbre y para no equivocarse de bolsa.
 */
create or replace function public.envio_del_repartidor(p_token text)
returns table (
  envio_id     uuid,
  numero       bigint,
  estado       text,
  destinatario text,
  telefono     text,
  direccion    text,
  referencia   text,
  localidad    text,
  destino_lat  numeric,
  destino_lng  numeric,
  nota         text,
  productos    text
)
language sql security definer set search_path to 'public','pg_temp'
stable
as $$
  select
    e.id, e.numero, e.estado, e.destinatario, e.telefono, e.direccion,
    e.referencia, e.localidad, e.lat, e.lng, e.nota,
    (select string_agg(
              pr.nombre || coalesce(' ' || va.talle, '') ||
              coalesce(' ' || va.color, '') || ' x' || el.cantidad, ', ')
       from public.envio_lineas el
       join public.variantes va on va.id = el.variante_id
       join public.productos pr on pr.id = va.producto_id
      where el.envio_id = e.id)
  from public.envios e
  where e.token_repartidor = p_token;
$$;

/**
 * El celular publica donde esta. Solo mientras el envio esta en camino: apenas
 * se entrega, deja de aceptar posiciones. Nadie queda transmitiendo su ubicacion
 * toda la tarde porque se olvido una pestaña abierta.
 */
create or replace function public.publicar_posicion(
  p_token       text,
  p_lat         numeric,
  p_lng         numeric,
  p_precision_m numeric default null
) returns text
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_envio public.envios%rowtype;
begin
  select * into v_envio from public.envios where token_repartidor = p_token;
  if not found then
    raise exception 'Link invalido.';
  end if;
  if v_envio.estado <> 'en_camino' then
    return v_envio.estado;
  end if;
  if p_lat is null or p_lng is null
     or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'Posicion invalida.';
  end if;

  insert into public.envio_posiciones (envio_id, lat, lng, precision_m)
  values (v_envio.id, round(p_lat, 7), round(p_lng, 7), round(coalesce(p_precision_m, 0), 1));

  return v_envio.estado;
end;
$$;

/**
 * El repartidor mueve el estado desde la calle. Puede salir, marcar entregado o
 * avisar que no pudo. Cancelar no: eso se decide en el local.
 */
create or replace function public.repartidor_cambiar_estado(
  p_token        text,
  p_destino      text,
  p_motivo       text default null,
  p_recibido_por text default null
) returns text
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_envio public.envios%rowtype;
begin
  select * into v_envio from public.envios where token_repartidor = p_token;
  if not found then
    raise exception 'Link invalido.';
  end if;
  if p_destino not in ('en_camino','entregado','no_entregado') then
    raise exception 'Desde el reparto solo se puede salir, entregar o avisar que no se pudo.';
  end if;

  perform public.mover_envio(v_envio, p_destino, p_motivo, p_recibido_por, v_envio.repartidor_id);

  select estado into v_envio.estado from public.envios where id = v_envio.id;
  return v_envio.estado;
end;
$$;

/**
 * El recorrido, para dibujar la linea en el mapa del cliente. Se limita a los
 * ultimos 200 puntos: mas que eso no se ve, y hace pesada la pagina en un
 * celular con mala señal.
 */
create or replace function public.recorrido_envio(p_token text)
returns table (lat numeric, lng numeric, created_at timestamptz)
language sql security definer set search_path to 'public','pg_temp'
stable
as $$
  select p.lat, p.lng, p.created_at
    from public.envio_posiciones p
    join public.envios e on e.id = p.envio_id
   where e.token = p_token
   order by p.created_at desc
   limit 200;
$$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
alter table public.envios           enable row level security;
alter table public.envio_lineas     enable row level security;
alter table public.envio_posiciones enable row level security;

-- Adentro del sistema las entregas las ve cualquier empleado activo: el que
-- atiende el mostrador tiene que poder decirle a un cliente que llamo por
-- telefono en que anda su pedido.
drop policy if exists envios_select on public.envios;
create policy envios_select on public.envios
  for select to authenticated using (public.mi_rol() is not null);

drop policy if exists envio_lineas_select on public.envio_lineas;
create policy envio_lineas_select on public.envio_lineas
  for select to authenticated using (public.mi_rol() is not null);

drop policy if exists envio_posiciones_select on public.envio_posiciones;
create policy envio_posiciones_select on public.envio_posiciones
  for select to authenticated using (public.mi_rol() is not null);

-- Escritura directa, ninguna. El token no da acceso a la tabla: da acceso a
-- cuatro funciones que devuelven exactamente lo que tienen que devolver.
grant select on public.envios           to authenticated;
grant select on public.envio_lineas     to authenticated;
grant select on public.envio_posiciones to authenticated;
grant select on public.stock_disponible to authenticated;

revoke execute on function public.guardar_envio(uuid, uuid, text, text, jsonb, uuid, uuid, text, text, text, numeric, numeric, date, text, numeric, text) from public, anon;
revoke execute on function public.asignar_repartidor(uuid, uuid) from public, anon;
revoke execute on function public.vincular_venta_a_envio(uuid, uuid) from public, anon;
revoke execute on function public.cambiar_estado_envio(uuid, text, text, text) from public, anon;
revoke execute on function public.mover_envio(public.envios, text, text, text, uuid) from public, anon, authenticated;

grant execute on function public.guardar_envio(uuid, uuid, text, text, jsonb, uuid, uuid, text, text, text, numeric, numeric, date, text, numeric, text) to authenticated;
grant execute on function public.asignar_repartidor(uuid, uuid) to authenticated;
grant execute on function public.vincular_venta_a_envio(uuid, uuid) to authenticated;
grant execute on function public.cambiar_estado_envio(uuid, text, text, text) to authenticated;

-- Estas cuatro si son publicas: son las que abre el link. La llave es el token.
grant execute on function public.seguimiento_envio(text)      to anon, authenticated;
grant execute on function public.recorrido_envio(text)        to anon, authenticated;
grant execute on function public.envio_del_repartidor(text)   to anon, authenticated;
grant execute on function public.publicar_posicion(text, numeric, numeric, numeric) to anon, authenticated;
grant execute on function public.repartidor_cambiar_estado(text, text, text, text)  to anon, authenticated;
