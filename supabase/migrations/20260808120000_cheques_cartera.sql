-- Cheques: cartera de terceros y propios, papel y e-cheq.
-- Porta el modulo del sistema viejo al modelo de este repo: estados con libro
-- mayor inmutable, transiciones validadas EN LA BASE (ocultar botones no es
-- seguridad) y escritura solo por funciones. Diseno relevado de Xubio/Tango/
-- Colppy/Nativo; la mejora propia es que el rechazo de un cheque recibido de
-- un cliente le devuelve la deuda a su cuenta corriente en la misma
-- transaccion, usando el libro mayor que ya existe (movimientos_cuenta).

create table public.cheques (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('tercero','propio')),
  numero text not null check (length(btrim(numero)) > 0),
  banco text not null check (length(btrim(banco)) > 0),
  echeq boolean not null default false,
  importe numeric(12,2) not null check (importe > 0),
  fecha_emision date not null,
  fecha_pago date not null,
  estado text not null check (estado in (
    'en_cartera','depositado','acreditado','endosado','descontado',
    'emitido','debitado','rechazado','anulado'
  )),
  -- terceros: quien lo firmo y de quien se recibio
  librador_nombre text,
  librador_cuit text,
  cliente_id uuid references public.clientes(id),
  venta_id uuid references public.ventas(id),
  -- propios: contra que cuenta se emitio / a quien se entrego o endoso
  cuenta_bancaria text,
  entregado_a text,
  -- auditoria: donde y quien lo cargo (manda el equipo, no la persona)
  sucursal_id uuid not null references public.sucursales(id),
  usuario_id uuid not null references public.usuarios(user_id),
  nota text,
  created_at timestamptz not null default now(),
  -- un diferido no puede superar los 360 dias desde la emision (ley de cheques)
  constraint cheques_fechas_coherentes check (
    fecha_pago >= fecha_emision and fecha_pago <= fecha_emision + 360
  )
);
comment on table public.cheques is
  'Cartera de cheques. El estado solo lo mueve transicionar_cheque: cada cambio queda en cheque_movimientos.';
comment on column public.cheques.fecha_pago is
  'La que manda en diferidos: desde cuando se puede cobrar. Un cheque comun prescribe a los 30 dias de esta fecha.';
comment on column public.cheques.cliente_id is
  'De que cliente se recibio (terceros). Habilita la reversion automatica de su deuda si el cheque rebota.';

-- mismo banco+numero+tipo no se carga dos veces; anulados afuera para poder
-- recargar una carga erronea sin pelearse con la constraint
create unique index cheques_no_duplicado_idx
  on public.cheques (tipo, lower(btrim(banco)), lower(btrim(numero)))
  where estado <> 'anulado';
create index cheques_vivos_por_vencimiento_idx
  on public.cheques (fecha_pago)
  where estado in ('en_cartera','depositado','emitido');

create table public.cheque_movimientos (
  id uuid primary key default gen_random_uuid(),
  cheque_id uuid not null references public.cheques(id) on delete cascade,
  de_estado text,
  a_estado text not null,
  usuario_id uuid not null references public.usuarios(user_id),
  sucursal_id uuid not null references public.sucursales(id),
  nota text,
  created_at timestamptz not null default now()
);
comment on table public.cheque_movimientos is
  'Historial de estados del cheque, estilo cadena de endosos. Inmutable: un error se corrige con otra transicion, nunca borrando.';
create index cheque_movimientos_cheque_idx
  on public.cheque_movimientos (cheque_id, created_at desc);

create or replace function public.cheque_movimientos_inmutables()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'El historial de un cheque no se edita ni se borra.';
end;
$$;

create trigger cheque_movimientos_sin_update
before update or delete on public.cheque_movimientos
for each row execute function public.cheque_movimientos_inmutables();

-- Alta: un tercero entra en cartera, un propio nace emitido.
create or replace function public.registrar_cheque(
  p_sucursal_id uuid,
  p_tipo text,
  p_numero text,
  p_banco text,
  p_importe numeric,
  p_fecha_emision date,
  p_fecha_pago date,
  p_echeq boolean default false,
  p_librador_nombre text default null,
  p_librador_cuit text default null,
  p_cliente_id uuid default null,
  p_venta_id uuid default null,
  p_cuenta_bancaria text default null,
  p_entregado_a text default null,
  p_nota text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_usuario uuid := auth.uid();
  v_estado text;
  v_id uuid;
begin
  if public.mi_rol() is null then
    raise exception 'Necesitas un usuario activo para cargar cheques.';
  end if;
  if not exists (select 1 from public.sucursales where id = p_sucursal_id and activa) then
    raise exception 'La sucursal no existe o esta desactivada.';
  end if;
  if p_tipo not in ('tercero','propio') then
    raise exception 'Tipo de cheque invalido.';
  end if;
  if p_cliente_id is not null
     and not exists (select 1 from public.clientes where id = p_cliente_id and activo) then
    raise exception 'Ese cliente no existe o esta desactivado.';
  end if;

  v_estado := case when p_tipo = 'tercero' then 'en_cartera' else 'emitido' end;

  insert into public.cheques (
    tipo, numero, banco, echeq, importe, fecha_emision, fecha_pago, estado,
    librador_nombre, librador_cuit, cliente_id, venta_id,
    cuenta_bancaria, entregado_a, sucursal_id, usuario_id, nota
  ) values (
    p_tipo, btrim(p_numero), btrim(p_banco), coalesce(p_echeq, false),
    round(p_importe, 2), p_fecha_emision, p_fecha_pago, v_estado,
    nullif(btrim(coalesce(p_librador_nombre, '')), ''),
    nullif(btrim(coalesce(p_librador_cuit, '')), ''),
    p_cliente_id, p_venta_id,
    nullif(btrim(coalesce(p_cuenta_bancaria, '')), ''),
    nullif(btrim(coalesce(p_entregado_a, '')), ''),
    p_sucursal_id, v_usuario, p_nota
  ) returning id into v_id;

  insert into public.cheque_movimientos (cheque_id, de_estado, a_estado, usuario_id, sucursal_id, nota)
  values (v_id, null, v_estado, v_usuario, p_sucursal_id,
          case when p_tipo = 'tercero' then 'Ingreso a cartera' else 'Emitido' end);

  return v_id;
end;
$$;

-- Transiciones: el grafo vive aca, no en la pantalla. Terceros: en_cartera ->
-- depositado/endosado/descontado/anulado; depositado -> acreditado/rechazado;
-- endosado/descontado -> rechazado (el rebote vuelve contra el negocio);
-- rechazado -> en_cartera (re-presentacion del papel). Propios: emitido ->
-- debitado/rechazado/anulado. acreditado, debitado y anulado son terminales.
create or replace function public.transicionar_cheque(
  p_cheque_id uuid,
  p_sucursal_id uuid,
  p_destino text,
  p_nota text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_usuario uuid := auth.uid();
  v_cheque public.cheques%rowtype;
  v_valida boolean;
begin
  if public.mi_rol() is null then
    raise exception 'Necesitas un usuario activo para mover cheques.';
  end if;
  if not exists (select 1 from public.sucursales where id = p_sucursal_id and activa) then
    raise exception 'La sucursal no existe o esta desactivada.';
  end if;

  select * into v_cheque from public.cheques where id = p_cheque_id for update;
  if not found then
    raise exception 'Ese cheque no existe.';
  end if;

  v_valida := case v_cheque.estado
    when 'en_cartera' then p_destino in ('depositado','endosado','descontado','anulado')
    when 'depositado' then p_destino in ('acreditado','rechazado')
    when 'endosado'   then p_destino = 'rechazado'
    when 'descontado' then p_destino = 'rechazado'
    when 'emitido'    then p_destino in ('debitado','rechazado','anulado')
    when 'rechazado'  then p_destino = 'en_cartera'
    else false
  end;
  -- un propio jamas pasa por estados de cartera, y viceversa
  if v_cheque.tipo = 'propio' and p_destino in ('en_cartera','depositado','acreditado','endosado','descontado') then
    v_valida := false;
  end if;
  if v_cheque.tipo = 'tercero' and p_destino in ('emitido','debitado') then
    v_valida := false;
  end if;
  if not v_valida then
    raise exception 'Un cheque "%" no puede pasar a "%".',
      replace(v_cheque.estado, '_', ' '), replace(p_destino, '_', ' ');
  end if;

  update public.cheques set estado = p_destino where id = p_cheque_id;

  insert into public.cheque_movimientos (cheque_id, de_estado, a_estado, usuario_id, sucursal_id, nota)
  values (p_cheque_id, v_cheque.estado, p_destino, v_usuario, p_sucursal_id, p_nota);

  -- El rechazo de un tercero recibido de un cliente: esa plata nunca entro.
  -- La deuda vuelve a su cuenta corriente en la MISMA transaccion, por el
  -- libro mayor de siempre; el trigger acomoda clientes.saldo solo.
  if p_destino = 'rechazado' and v_cheque.tipo = 'tercero' and v_cheque.cliente_id is not null then
    insert into public.movimientos_cuenta (cliente_id, sucursal_id, tipo, monto, venta_id, usuario_id, nota)
    values (
      v_cheque.cliente_id, p_sucursal_id, 'ajuste', v_cheque.importe, v_cheque.venta_id, v_usuario,
      'Cheque N° ' || v_cheque.numero || ' (' || v_cheque.banco || ') rechazado'
    );
  end if;
end;
$$;

-- RLS + permisos. Leer: cualquier usuario activo. Escribir: nadie — la unica
-- puerta son las dos funciones. RLS sin GRANT no sirve, y GRANT de escritura
-- aca no existe a proposito.
alter table public.cheques            enable row level security;
alter table public.cheque_movimientos enable row level security;

create policy cheques_select_usuarios_activos on public.cheques
  for select using (public.mi_rol() is not null);
create policy cheque_movs_select_usuarios_activos on public.cheque_movimientos
  for select using (public.mi_rol() is not null);

grant select on public.cheques, public.cheque_movimientos to authenticated;

revoke all on function public.registrar_cheque(uuid, text, text, text, numeric, date, date, boolean, text, text, uuid, uuid, text, text, text) from anon, public;
revoke all on function public.transicionar_cheque(uuid, uuid, text, text) from anon, public;
grant execute on function public.registrar_cheque(uuid, text, text, text, numeric, date, date, boolean, text, text, uuid, uuid, text, text, text) to authenticated;
grant execute on function public.transicionar_cheque(uuid, uuid, text, text) to authenticated;
