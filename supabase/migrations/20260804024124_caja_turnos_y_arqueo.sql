-- P4a — Caja: turno con apertura, arqueo y cierre.
--
-- Reglas del negocio que esta migracion hace cumplir:
--  * La caja es el cajon: solo entra lo que tiene el flag afecta_caja (hoy, efectivo).
--  * Un turno abierto por sucursal, no mas.
--  * No se cobra en efectivo con la caja cerrada. Esa plata no tendria donde entrar.
--  * El saldo esperado no se guarda mientras el turno vive: se calcula. Recien al
--    cerrar se congela, junto con lo contado y la diferencia.

create table if not exists public.turnos_caja (
  id             uuid primary key default gen_random_uuid(),
  sucursal_id    uuid not null references public.sucursales(id),
  numero         bigint not null,
  monto_apertura numeric(12,2) not null check (monto_apertura >= 0),
  abierto_por    uuid not null references public.usuarios(user_id),
  abierto_at     timestamptz not null default now(),
  estado         text not null default 'abierto' check (estado in ('abierto','cerrado')),
  monto_contado  numeric(12,2),
  monto_esperado numeric(12,2),
  diferencia     numeric(12,2),
  cerrado_por    uuid references public.usuarios(user_id),
  cerrado_at     timestamptz,
  nota_cierre    text,
  unique (sucursal_id, numero)
);

-- Dos turnos abiertos en el mismo local harian que la plata no se sepa de quien es.
create unique index if not exists turnos_caja_uno_abierto_por_sucursal
  on public.turnos_caja (sucursal_id) where estado = 'abierto';

create index if not exists turnos_caja_sucursal_fecha
  on public.turnos_caja (sucursal_id, abierto_at desc);

create table if not exists public.movimientos_caja (
  id          uuid primary key default gen_random_uuid(),
  turno_id    uuid not null references public.turnos_caja(id),
  sucursal_id uuid not null references public.sucursales(id),
  tipo        text not null check (tipo in ('ingreso','retiro','anulacion')),
  monto       numeric(12,2) not null check (monto <> 0),
  motivo      text not null,
  usuario_id  uuid not null references public.usuarios(user_id),
  referencia_id uuid,
  created_at  timestamptz not null default now(),
  constraint movimientos_caja_signo check (
    (tipo = 'ingreso' and monto > 0) or (tipo in ('retiro','anulacion') and monto < 0)
  )
);

create index if not exists movimientos_caja_turno on public.movimientos_caja (turno_id, created_at);

-- Igual que el stock y la cuenta corriente: nada se edita ni se borra.
create or replace function public.movimientos_caja_inmutables()
returns trigger language plpgsql as $$
begin
  raise exception 'Un movimiento de caja no se edita ni se borra. Se corrige con otro movimiento.';
end;
$$;

drop trigger if exists movimientos_caja_sin_update on public.movimientos_caja;
create trigger movimientos_caja_sin_update
  before update or delete on public.movimientos_caja
  for each row execute function public.movimientos_caja_inmutables();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.turno_abierto_id(p_sucursal_id uuid)
returns uuid
language sql stable security definer set search_path to 'public','pg_temp'
as $$
  select id from public.turnos_caja
   where sucursal_id = p_sucursal_id and estado = 'abierto'
   limit 1;
$$;

-- Lo que TIENE que haber en el cajon ahora mismo.
-- No se guarda en ninguna columna: se suma cada vez. Una columna con el saldo
-- se desincroniza el dia que alguien inserte una fila por afuera.
create or replace function public.saldo_esperado_caja(p_turno_id uuid)
returns numeric
language sql stable security definer set search_path to 'public','pg_temp'
as $$
  with w as (
    select sucursal_id, monto_apertura, abierto_at as desde,
           coalesce(cerrado_at, now()) as hasta
      from public.turnos_caja where id = p_turno_id
  ),
  ventas_efectivo as (
    -- Se cuenta la venta anulada igual: esa plata entro de verdad. La salida
    -- queda como movimiento 'anulacion', asi el cajon cuenta las dos veces.
    select coalesce(sum(p.monto), 0) as m
      from public.pagos p
      join public.ventas v on v.id = p.venta_id
      join public.medios_pago mp on mp.id = p.medio_pago_id
      join w on w.sucursal_id = v.sucursal_id
     where mp.afecta_caja
       and p.created_at >= w.desde and p.created_at < w.hasta
  ),
  cobros_efectivo as (
    select coalesce(sum(-mc.monto), 0) as m
      from public.movimientos_cuenta mc
      join public.medios_pago mp on mp.id = mc.medio_pago_id
      join w on w.sucursal_id = mc.sucursal_id
     where mp.afecta_caja and mc.tipo = 'pago'
       and mc.created_at >= w.desde and mc.created_at < w.hasta
  ),
  manuales as (
    select coalesce(sum(monto), 0) as m
      from public.movimientos_caja where turno_id = p_turno_id
  )
  select round((select monto_apertura from w) + ve.m + ce.m + mn.m, 2)
    from ventas_efectivo ve, cobros_efectivo ce, manuales mn;
$$;

-- ---------------------------------------------------------------------------
-- Abrir, mover y cerrar
-- ---------------------------------------------------------------------------

create or replace function public.abrir_caja(p_sucursal_id uuid, p_monto_apertura numeric)
returns uuid
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_usuario uuid := auth.uid();
  v_numero bigint;
  v_id uuid;
begin
  if public.mi_rol() is null then
    raise exception 'Necesitas un usuario activo para abrir la caja.';
  end if;
  if not exists (select 1 from public.sucursales where id = p_sucursal_id and activa) then
    raise exception 'La sucursal no existe o esta desactivada.';
  end if;
  if coalesce(p_monto_apertura, -1) < 0 then
    raise exception 'El monto de apertura no puede ser negativo. Si arrancas sin plata, poné 0.';
  end if;
  if public.turno_abierto_id(p_sucursal_id) is not null then
    raise exception 'Esta caja ya esta abierta. Hay que cerrarla antes de abrir otra.';
  end if;

  perform pg_advisory_xact_lock(hashtext('caja:' || p_sucursal_id::text));
  select coalesce(max(numero), 0) + 1 into v_numero
    from public.turnos_caja where sucursal_id = p_sucursal_id;

  insert into public.turnos_caja (sucursal_id, numero, monto_apertura, abierto_por)
  values (p_sucursal_id, v_numero, round(p_monto_apertura, 2), v_usuario)
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.registrar_movimiento_caja(
  p_sucursal_id uuid, p_tipo text, p_monto numeric, p_motivo text)
returns uuid
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_usuario uuid := auth.uid();
  v_turno uuid;
  v_firmado numeric(12,2);
  v_id uuid;
begin
  if public.mi_rol() is null then
    raise exception 'Necesitas un usuario activo para tocar la caja.';
  end if;
  if p_tipo not in ('ingreso','retiro') then
    raise exception 'Un movimiento a mano solo puede ser ingreso o retiro.';
  end if;
  -- Sacar plata del cajon es la operacion mas delicada del sistema.
  if p_tipo = 'retiro' and not public.tiene_rol(array['dueno']) then
    raise exception 'Solo un dueno puede retirar plata de la caja.';
  end if;
  if coalesce(p_monto, 0) <= 0 then
    raise exception 'El monto tiene que ser mayor a cero. Lo que decide si entra o sale es el tipo.';
  end if;
  if btrim(coalesce(p_motivo, '')) = '' then
    raise exception 'Hay que decir de que es. Un movimiento de caja sin motivo no se puede explicar despues.';
  end if;

  v_turno := public.turno_abierto_id(p_sucursal_id);
  if v_turno is null then
    raise exception 'La caja de esta sucursal esta cerrada.';
  end if;

  v_firmado := case when p_tipo = 'ingreso' then round(p_monto, 2) else -round(p_monto, 2) end;

  if p_tipo = 'retiro' and public.saldo_esperado_caja(v_turno) + v_firmado < 0 then
    raise exception 'No se puede retirar mas de lo que hay en la caja.';
  end if;

  insert into public.movimientos_caja (turno_id, sucursal_id, tipo, monto, motivo, usuario_id)
  values (v_turno, p_sucursal_id, p_tipo, v_firmado, btrim(p_motivo), v_usuario)
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.cerrar_caja(
  p_turno_id uuid, p_monto_contado numeric, p_nota text default null)
returns numeric
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_usuario uuid := auth.uid();
  v_esperado numeric(12,2);
  v_diferencia numeric(12,2);
begin
  if public.mi_rol() is null then
    raise exception 'Necesitas un usuario activo para cerrar la caja.';
  end if;
  if coalesce(p_monto_contado, -1) < 0 then
    raise exception 'Hay que contar la plata. Si el cajon quedo vacio, poné 0.';
  end if;

  perform 1 from public.turnos_caja where id = p_turno_id and estado = 'abierto' for update;
  if not found then
    raise exception 'Ese turno no existe o ya estaba cerrado.';
  end if;

  -- Se congela antes de marcar el cierre: despues de cerrado, la ventana cambia.
  v_esperado := public.saldo_esperado_caja(p_turno_id);
  v_diferencia := round(round(p_monto_contado, 2) - v_esperado, 2);

  -- Una diferencia sin explicacion es exactamente el dato que interesa auditar.
  if v_diferencia <> 0 and btrim(coalesce(p_nota, '')) = '' then
    raise exception 'La caja no cierra: hay una diferencia de %. Hay que explicar por que.', v_diferencia;
  end if;

  update public.turnos_caja
     set estado = 'cerrado',
         cerrado_at = now(),
         cerrado_por = v_usuario,
         monto_contado = round(p_monto_contado, 2),
         monto_esperado = v_esperado,
         diferencia = v_diferencia,
         nota_cierre = nullif(btrim(coalesce(p_nota, '')), '')
   where id = p_turno_id;

  return v_diferencia;
end;
$$;

-- ---------------------------------------------------------------------------
-- Nadie cobra en efectivo con la caja cerrada
-- ---------------------------------------------------------------------------
-- Va como trigger y no dentro de registrar_venta a proposito: asi vale para
-- cualquier camino que inserte un pago, hoy y el dia que haya otro.

create or replace function public.exigir_caja_abierta_en_pago()
returns trigger language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_sucursal uuid;
begin
  if not exists (select 1 from public.medios_pago where id = new.medio_pago_id and afecta_caja) then
    return new;
  end if;

  if tg_table_name = 'pagos' then
    select sucursal_id into v_sucursal from public.ventas where id = new.venta_id;
  else
    if new.tipo <> 'pago' then return new; end if;
    v_sucursal := new.sucursal_id;
  end if;

  if public.turno_abierto_id(v_sucursal) is null then
    raise exception 'La caja de esta sucursal esta cerrada. Abrila antes de cobrar en efectivo.';
  end if;

  return new;
end;
$$;

drop trigger if exists pagos_exigen_caja_abierta on public.pagos;
create trigger pagos_exigen_caja_abierta
  before insert on public.pagos
  for each row execute function public.exigir_caja_abierta_en_pago();

drop trigger if exists mov_cuenta_exigen_caja_abierta on public.movimientos_cuenta;
create trigger mov_cuenta_exigen_caja_abierta
  before insert on public.movimientos_cuenta
  for each row execute function public.exigir_caja_abierta_en_pago();

-- ---------------------------------------------------------------------------
-- Permisos: RLS sin GRANT no sirve de nada, y GRANT de mas rompe el modelo.
-- ---------------------------------------------------------------------------

alter table public.turnos_caja enable row level security;
alter table public.movimientos_caja enable row level security;

grant select on public.turnos_caja to authenticated;
grant select on public.movimientos_caja to authenticated;
-- Sin insert/update/delete: la unica puerta son las funciones de arriba.

drop policy if exists turnos_caja_select_usuarios_activos on public.turnos_caja;
create policy turnos_caja_select_usuarios_activos on public.turnos_caja
  for select to authenticated using (public.mi_rol() is not null);

drop policy if exists mov_caja_select_usuarios_activos on public.movimientos_caja;
create policy mov_caja_select_usuarios_activos on public.movimientos_caja
  for select to authenticated using (public.mi_rol() is not null);

grant execute on function public.turno_abierto_id(uuid) to authenticated;
grant execute on function public.saldo_esperado_caja(uuid) to authenticated;
grant execute on function public.abrir_caja(uuid, numeric) to authenticated;
grant execute on function public.registrar_movimiento_caja(uuid, text, numeric, text) to authenticated;
grant execute on function public.cerrar_caja(uuid, numeric, text) to authenticated;
