-- Atencion al cliente: el registro de lo que la gente pregunta y reclama.
--
-- Reglas que ordenan todo lo de abajo:
--
--   1. Esto no es un chat de WhatsApp. La API de WhatsApp Business es un
--      tramite aparte. Mientras tanto, el mostrador carga a mano lo que pasa,
--      que es exactamente lo que hoy se pierde en el celular de alguien. El
--      dia que entre la API, los mensajes caen en esta misma tabla.
--   2. Una consulta no necesita un cliente cargado. La mayoria de las que
--      llegan por Instagram son de gente que todavia no compro nada. Alcanza
--      con un nombre. Si despues compra, se la engancha al cliente.
--   3. Nada se cierra sin decir como termino. Una consulta resuelta sin
--      resolucion escrita es una consulta que dentro de un mes no le sirve a
--      nadie, y menos cuando la persona vuelve a reclamar por lo mismo.
--   4. Las notas internas viven en el mismo hilo que los mensajes, marcadas
--      como notas. Tenerlas aparte termina siempre igual: nadie las lee.

-- ---------------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------------

create table if not exists public.consultas (
  id                  uuid primary key default gen_random_uuid(),
  numero              bigint not null,
  sucursal_id         uuid not null references public.sucursales(id),
  cliente_id          uuid references public.clientes(id),
  nombre              text not null,
  telefono            text,
  email               text,
  canal               text not null,
  tipo                text not null default 'consulta',
  asunto              text not null,
  prioridad           text not null default 'normal',
  estado              text not null default 'abierta',
  asignado_a          uuid references auth.users(id),
  venta_id            uuid references public.ventas(id),
  pedido_online_id    uuid references public.pedidos_online(id),
  resolucion          text,
  primera_respuesta_at timestamptz,
  resuelta_at         timestamptz,
  resuelta_por        uuid references auth.users(id),
  creado_por          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  actualizado_at      timestamptz not null default now(),
  constraint consultas_canal_valido     check (canal in ('whatsapp','instagram','facebook','telefono','email','mostrador','tienda_online')),
  constraint consultas_tipo_valido      check (tipo in ('consulta','reclamo','cambio','devolucion','garantia','otro')),
  constraint consultas_prioridad_valida check (prioridad in ('baja','normal','alta')),
  constraint consultas_estado_valido    check (estado in ('abierta','en_curso','esperando','resuelta')),
  constraint consultas_resuelta_completa
    check (estado <> 'resuelta' or (resuelta_at is not null and coalesce(btrim(resolucion), '') <> ''))
);

comment on table public.consultas is
  'Consultas, reclamos y cambios. Una fila por asunto, no por mensaje. Sirve para saber que se le prometio a quien.';
comment on column public.consultas.estado is
  'abierta: entro y nadie la contesto. en_curso: alguien la esta atendiendo. esperando: la pelota esta del lado del cliente. resuelta: termino, y quedo escrito como.';
comment on column public.consultas.canal is
  'Por donde llego. Sirve para saber donde conviene estar: si el ochenta por ciento entra por Instagram, ahi hay que contestar rapido.';
comment on column public.consultas.nombre is
  'El nombre suelto, sin cliente cargado. Cuando hay cliente_id se copia el del cliente, pero la consulta igual se sostiene sola.';
comment on column public.consultas.primera_respuesta_at is
  'Cuando el local contesto por primera vez. Es el numero que mide de verdad la atencion: no cuanto tardo en resolverse, cuanto tardo en que alguien conteste.';

create unique index if not exists consultas_numero_unico  on public.consultas (sucursal_id, numero);
create index if not exists consultas_estado_idx           on public.consultas (estado, created_at desc);
create index if not exists consultas_sucursal_idx         on public.consultas (sucursal_id, created_at desc);
create index if not exists consultas_cliente_idx          on public.consultas (cliente_id);
create index if not exists consultas_asignado_idx         on public.consultas (asignado_a);
create index if not exists consultas_venta_idx            on public.consultas (venta_id);
create index if not exists consultas_pedido_online_idx    on public.consultas (pedido_online_id);

create table if not exists public.consulta_mensajes (
  id          uuid primary key default gen_random_uuid(),
  consulta_id uuid not null references public.consultas(id) on delete cascade,
  autor       text not null,
  texto       text not null,
  usuario_id  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  constraint consulta_mensajes_autor_valido check (autor in ('cliente','local','nota')),
  constraint consulta_mensajes_con_texto    check (coalesce(btrim(texto), '') <> '')
);

comment on table public.consulta_mensajes is
  'El hilo de una consulta. autor cliente es lo que dijo la persona, local lo que se le contesto, nota es para adentro y no se le muestra a nadie de afuera.';

create index if not exists consulta_mensajes_consulta_idx on public.consulta_mensajes (consulta_id, created_at);

-- ---------------------------------------------------------------------------
-- 2. Quien ve que
-- ---------------------------------------------------------------------------
-- Cualquiera del equipo lee las consultas: el que atiende el mostrador tiene
-- que poder ver que le prometio el turno de la manana. Escribir, en cambio,
-- pasa siempre por las funciones de abajo, para que ningun hilo quede con
-- estados y fechas que no se corresponden.

alter table public.consultas enable row level security;
alter table public.consulta_mensajes enable row level security;

drop policy if exists consultas_select_usuarios_activos on public.consultas;
create policy consultas_select_usuarios_activos
  on public.consultas for select to authenticated
  using (public.mi_rol() is not null);

drop policy if exists consulta_mensajes_select_usuarios_activos on public.consulta_mensajes;
create policy consulta_mensajes_select_usuarios_activos
  on public.consulta_mensajes for select to authenticated
  using (public.mi_rol() is not null);

grant select on public.consultas to authenticated;
grant select on public.consulta_mensajes to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Abrir y editar una consulta
-- ---------------------------------------------------------------------------

create or replace function public.guardar_consulta(
  p_sucursal_id      uuid,
  p_asunto           text,
  p_canal            text,
  p_id               uuid    default null,
  p_tipo             text    default 'consulta',
  p_prioridad        text    default 'normal',
  p_cliente_id       uuid    default null,
  p_nombre           text    default null,
  p_telefono         text    default null,
  p_email            text    default null,
  p_asignado_a       uuid    default null,
  p_venta_id         uuid    default null,
  p_pedido_online_id uuid    default null,
  p_primer_mensaje   text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id     uuid;
  v_numero bigint;
  v_nombre text;
  v_tel    text;
  v_cli    public.clientes%rowtype;
begin
  if public.mi_rol() is null then
    raise exception 'No tenes permiso para tocar la atencion al cliente.';
  end if;

  if coalesce(btrim(p_asunto), '') = '' then
    raise exception 'Escribi de que se trata: sin asunto, la lista no sirve para nada.';
  end if;

  v_nombre := nullif(btrim(coalesce(p_nombre, '')), '');
  v_tel    := nullif(btrim(coalesce(p_telefono, '')), '');

  -- Si eligieron un cliente cargado, los datos salen de ahi: escribirlos dos
  -- veces es garantia de que en algun momento no coincidan.
  if p_cliente_id is not null then
    select * into v_cli from public.clientes where id = p_cliente_id;
    if not found then
      raise exception 'Ese cliente no existe.';
    end if;
    v_nombre := coalesce(v_nombre, v_cli.nombre);
    v_tel    := coalesce(v_tel, v_cli.telefono);
  end if;

  if v_nombre is null then
    raise exception 'Pone al menos un nombre: despues no hay forma de saber a quien contestarle.';
  end if;

  if p_id is null then
    -- Un numero por vez y por sucursal, igual que ventas y pedidos.
    perform pg_advisory_xact_lock(hashtext('consulta:' || p_sucursal_id::text));

    select coalesce(max(c.numero), 0) + 1 into v_numero
      from public.consultas c where c.sucursal_id = p_sucursal_id;

    insert into public.consultas (
      numero, sucursal_id, cliente_id, nombre, telefono, email, canal, tipo,
      asunto, prioridad, asignado_a, venta_id, pedido_online_id, creado_por
    ) values (
      v_numero, p_sucursal_id, p_cliente_id, v_nombre, v_tel,
      nullif(btrim(coalesce(p_email, '')), ''), p_canal, coalesce(p_tipo, 'consulta'),
      btrim(p_asunto), coalesce(p_prioridad, 'normal'), p_asignado_a,
      p_venta_id, p_pedido_online_id, auth.uid()
    )
    returning id into v_id;

    -- Lo que la persona dijo cuando escribio, si lo cargaron de una.
    if coalesce(btrim(coalesce(p_primer_mensaje, '')), '') <> '' then
      insert into public.consulta_mensajes (consulta_id, autor, texto, usuario_id)
      values (v_id, 'cliente', btrim(p_primer_mensaje), auth.uid());
    end if;
  else
    update public.consultas set
      cliente_id       = p_cliente_id,
      nombre           = v_nombre,
      telefono         = v_tel,
      email            = nullif(btrim(coalesce(p_email, '')), ''),
      canal            = p_canal,
      tipo             = coalesce(p_tipo, 'consulta'),
      asunto           = btrim(p_asunto),
      prioridad        = coalesce(p_prioridad, 'normal'),
      asignado_a       = p_asignado_a,
      venta_id         = p_venta_id,
      pedido_online_id = p_pedido_online_id,
      actualizado_at   = now()
    where id = p_id
    returning id into v_id;

    if v_id is null then
      raise exception 'Esa consulta no existe.';
    end if;
  end if;

  return v_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Contestar
-- ---------------------------------------------------------------------------

create or replace function public.agregar_mensaje_consulta(
  p_consulta_id uuid,
  p_texto       text,
  p_autor       text default 'local'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id uuid;
  v_c  public.consultas%rowtype;
begin
  if public.mi_rol() is null then
    raise exception 'No tenes permiso para tocar la atencion al cliente.';
  end if;

  if p_autor not in ('cliente','local','nota') then
    raise exception 'No se sabe quien escribio ese mensaje.';
  end if;

  if coalesce(btrim(coalesce(p_texto, '')), '') = '' then
    raise exception 'El mensaje esta vacio.';
  end if;

  select * into v_c from public.consultas where id = p_consulta_id;
  if not found then
    raise exception 'Esa consulta no existe.';
  end if;

  insert into public.consulta_mensajes (consulta_id, autor, texto, usuario_id)
  values (p_consulta_id, p_autor, btrim(p_texto), auth.uid())
  returning id into v_id;

  update public.consultas set
    -- Contestar es empezar a atender: no hace falta acordarse de mover el
    -- estado a mano, y una consulta contestada que sigue figurando como
    -- abierta hace que la lista mienta.
    estado = case
               when p_autor = 'local' and estado = 'abierta' then 'en_curso'
               when p_autor = 'cliente' and estado = 'esperando' then 'en_curso'
               else estado
             end,
    primera_respuesta_at = case
                             when p_autor = 'local' and primera_respuesta_at is null then now()
                             else primera_respuesta_at
                           end,
    actualizado_at = now()
  where id = p_consulta_id;

  return v_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Cambiar el estado
-- ---------------------------------------------------------------------------

create or replace function public.cambiar_estado_consulta(
  p_consulta_id uuid,
  p_destino     text,
  p_resolucion  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_c public.consultas%rowtype;
begin
  if public.mi_rol() is null then
    raise exception 'No tenes permiso para tocar la atencion al cliente.';
  end if;

  if p_destino not in ('abierta','en_curso','esperando','resuelta') then
    raise exception 'Ese estado no existe.';
  end if;

  select * into v_c from public.consultas where id = p_consulta_id;
  if not found then
    raise exception 'Esa consulta no existe.';
  end if;

  if p_destino = 'resuelta' then
    if coalesce(btrim(coalesce(p_resolucion, '')), '') = '' then
      raise exception 'Escribi como se resolvio. Dentro de un mes, cuando la persona vuelva, va a ser lo unico que sirva.';
    end if;

    update public.consultas set
      estado         = 'resuelta',
      resolucion     = btrim(p_resolucion),
      resuelta_at    = now(),
      resuelta_por   = auth.uid(),
      actualizado_at = now()
    where id = p_consulta_id;

    insert into public.consulta_mensajes (consulta_id, autor, texto, usuario_id)
    values (p_consulta_id, 'nota', 'Resuelta: ' || btrim(p_resolucion), auth.uid());
  else
    -- Reabrir borra la resolucion vieja a proposito: si el tema volvio, la
    -- resolucion anterior no era la resolucion. Igual queda en el hilo.
    update public.consultas set
      estado         = p_destino,
      resolucion     = case when v_c.estado = 'resuelta' then null else resolucion end,
      resuelta_at    = case when v_c.estado = 'resuelta' then null else resuelta_at end,
      resuelta_por   = case when v_c.estado = 'resuelta' then null else resuelta_por end,
      actualizado_at = now()
    where id = p_consulta_id;

    if v_c.estado = 'resuelta' then
      insert into public.consulta_mensajes (consulta_id, autor, texto, usuario_id)
      values (p_consulta_id, 'nota', 'Se reabrio la consulta.', auth.uid());
    end if;
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Permisos
-- ---------------------------------------------------------------------------

revoke execute on function public.guardar_consulta(uuid, text, text, uuid, text, text, uuid, text, text, text, uuid, uuid, uuid, text) from public, anon;
grant  execute on function public.guardar_consulta(uuid, text, text, uuid, text, text, uuid, text, text, text, uuid, uuid, uuid, text) to authenticated;

revoke execute on function public.agregar_mensaje_consulta(uuid, text, text) from public, anon;
grant  execute on function public.agregar_mensaje_consulta(uuid, text, text) to authenticated;

revoke execute on function public.cambiar_estado_consulta(uuid, text, text) from public, anon;
grant  execute on function public.cambiar_estado_consulta(uuid, text, text) to authenticated;
