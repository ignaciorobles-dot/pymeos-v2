-- P4b - Gastos: lo que sale del negocio y no es mercaderia.
--
-- La distincion que hace esta migracion, y que es la razon de que gastos y
-- compras sean dos cosas separadas: la mercaderia que se compra para revender
-- no es un gasto, es stock que despues se vende. Si se registra en los dos
-- lados, el resultado del mes queda restado dos veces. Aca va el alquiler, la
-- luz, los sueldos, el flete, el insumo. Lo otro va a compras (P4c).
--
-- Dos reglas del negocio que quedan escritas en la base y no en la pantalla:
--
--  * La sucursal del gasto es la sucursal en la que esta trabajando el equipo,
--    no una que se elige de un desplegable. Es la misma regla que rige toda la
--    operacion: manda el equipo, no la persona. Por eso la funcion la recibe
--    como parametro y la pantalla no ofrece un selector.
--
--  * Un gasto se puede anotar sin tocar la caja (la factura de luz que se paga
--    por banco) o pagando del cajon (el flete que se paga en el momento). En el
--    segundo caso la plata sale de verdad, y tiene que salir por donde sale
--    todo lo demas: un movimiento de caja, sobre el turno abierto, que el
--    arqueo del cierre va a contar.

-- ---------------------------------------------------------------------------
-- Categorias de gasto
-- ---------------------------------------------------------------------------
-- Lista editable por el dueno, igual que las categorias del catalogo y por el
-- mismo motivo: con texto libre terminan conviviendo "Luz", "luz" y "Energia
-- electrica", y el total por categoria deja de querer decir algo.
create table if not exists public.categorias_gasto (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null check (length(trim(nombre)) > 0),
  orden      integer not null default 0,
  activa     boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.categorias_gasto is
  'Categorias de gasto operativo. Las edita el dueno; no se borran, se desactivan.';

create unique index if not exists categorias_gasto_nombre_unico
  on public.categorias_gasto (lower(trim(nombre)));

-- ---------------------------------------------------------------------------
-- Gastos
-- ---------------------------------------------------------------------------
create table if not exists public.gastos (
  id                 uuid primary key default gen_random_uuid(),
  sucursal_id        uuid not null references public.sucursales(id),
  categoria_id       uuid not null references public.categorias_gasto(id) on delete restrict,
  detalle            text not null check (length(trim(detalle)) > 0),
  monto              numeric(12,2) not null check (monto > 0),
  fecha              date not null default current_date,
  paga_caja          boolean not null default false,
  movimiento_caja_id uuid references public.movimientos_caja(id),
  usuario_id         uuid not null references public.usuarios(user_id),
  anulado            boolean not null default false,
  anulado_por        uuid references public.usuarios(user_id),
  anulado_at         timestamptz,
  motivo_anulacion   text,
  created_at         timestamptz not null default now(),

  -- Si salio del cajon tiene que existir el movimiento que lo saco, y si no
  -- salio del cajon no puede haber ninguno. Sin esto se puede llegar a un gasto
  -- que dice "pagado en efectivo" y una caja que nunca se entero.
  constraint gastos_caja_coherente check (
    (paga_caja and movimiento_caja_id is not null)
    or (not paga_caja and movimiento_caja_id is null)
  )
);

comment on column public.gastos.fecha is
  'Fecha del gasto, que puede ser anterior a la de carga (una factura de la semana pasada). Si se paga de caja tiene que ser hoy: la plata sale hoy.';
comment on column public.gastos.paga_caja is
  'True = la plata salio del cajon y hay un movimiento de caja. False = se pago por afuera (banco, transferencia, debito automatico).';
comment on column public.gastos.anulado is
  'Un gasto no se borra. Se anula, se explica por que, y si habia salido de la caja la plata vuelve con otro movimiento.';

create index if not exists gastos_por_sucursal_fecha
  on public.gastos (sucursal_id, fecha desc) where not anulado;

create index if not exists gastos_por_categoria
  on public.gastos (categoria_id, fecha desc) where not anulado;

-- ---------------------------------------------------------------------------
-- Registrar
-- ---------------------------------------------------------------------------
/**
 * Registra un gasto y, si se paga del cajon, lo saca de la caja en el mismo
 * movimiento. Las dos cosas juntas o ninguna: por eso es una funcion y no dos
 * inserts desde la pantalla.
 */
create or replace function public.registrar_gasto(
  p_sucursal_id  uuid,
  p_categoria_id uuid,
  p_detalle      text,
  p_monto        numeric,
  p_fecha        date,
  p_paga_caja    boolean
) returns uuid
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_usuario   uuid := auth.uid();
  v_gasto_id  uuid := gen_random_uuid();
  v_turno     uuid;
  v_monto     numeric(12,2) := round(coalesce(p_monto, 0), 2);
  v_fecha     date := coalesce(p_fecha, current_date);
  v_paga_caja boolean := coalesce(p_paga_caja, false);
  v_mov_id    uuid;
  v_categoria text;
begin
  if public.mi_rol() is null then
    raise exception 'Necesitas un usuario activo para registrar un gasto.';
  end if;

  if not exists (select 1 from public.sucursales where id = p_sucursal_id and activa) then
    raise exception 'La sucursal no existe o esta desactivada. Elegi en que sucursal esta trabajando este equipo, en Configuracion.';
  end if;

  select nombre into v_categoria
    from public.categorias_gasto where id = p_categoria_id and activa;
  if v_categoria is null then
    raise exception 'Esa categoria de gasto no existe o esta desactivada.';
  end if;

  if btrim(coalesce(p_detalle, '')) = '' then
    raise exception 'Hay que decir de que es el gasto. Dentro de un mes, "Insumos $8.000" no le dice nada a nadie.';
  end if;

  if v_monto <= 0 then
    raise exception 'El monto tiene que ser mayor a cero.';
  end if;

  -- Un gasto con fecha futura casi siempre es un error de tipeo en el ano.
  if v_fecha > current_date then
    raise exception 'La fecha del gasto no puede ser posterior a hoy.';
  end if;

  if v_paga_caja then
    -- Sacar plata del cajon es la operacion mas delicada del sistema, y es la
    -- misma regla que ya rige el retiro manual: la firma un dueno.
    if not public.tiene_rol(array['dueno']) then
      raise exception 'Un gasto pagado de la caja lo tiene que registrar un dueno. Si ya lo pagaste, anotalo como pagado por afuera y avisale.';
    end if;

    -- La plata sale hoy. Un gasto viejo pagado del cajon de hoy descuadraria
    -- el arqueo de un turno que ya cerro.
    if v_fecha <> current_date then
      raise exception 'Un gasto pagado de la caja tiene que ser de hoy: la plata sale del cajon de hoy.';
    end if;

    v_turno := public.turno_abierto_id(p_sucursal_id);
    if v_turno is null then
      raise exception 'La caja de esta sucursal esta cerrada. Abrila antes de pagar un gasto en efectivo.';
    end if;

    if public.saldo_esperado_caja(v_turno) - v_monto < 0 then
      raise exception 'No hay esa plata en la caja.';
    end if;

    insert into public.movimientos_caja
      (turno_id, sucursal_id, tipo, monto, motivo, usuario_id, referencia_id)
    values
      (v_turno, p_sucursal_id, 'retiro', -v_monto,
       'Gasto: ' || v_categoria || ' - ' || btrim(p_detalle), v_usuario, v_gasto_id)
    returning id into v_mov_id;
  end if;

  insert into public.gastos
    (id, sucursal_id, categoria_id, detalle, monto, fecha, paga_caja, movimiento_caja_id, usuario_id)
  values
    (v_gasto_id, p_sucursal_id, p_categoria_id, btrim(p_detalle), v_monto, v_fecha,
     v_paga_caja, v_mov_id, v_usuario);

  return v_gasto_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Anular
-- ---------------------------------------------------------------------------
/**
 * Anula un gasto. No lo borra: lo marca, guarda quien y por que, y si habia
 * salido de la caja devuelve la plata con un movimiento nuevo. La caja queda
 * contando las dos veces, que es como tiene que quedar: la plata salio y volvio.
 */
create or replace function public.anular_gasto(p_gasto_id uuid, p_motivo text)
returns void
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_usuario uuid := auth.uid();
  g         public.gastos%rowtype;
  v_turno   uuid;
begin
  if not public.tiene_rol(array['dueno']) then
    raise exception 'Solo un dueno puede anular un gasto.';
  end if;
  if btrim(coalesce(p_motivo, '')) = '' then
    raise exception 'Hay que decir por que se anula.';
  end if;

  select * into g from public.gastos where id = p_gasto_id;
  if g.id is null then
    raise exception 'Ese gasto no existe.';
  end if;
  if g.anulado then
    raise exception 'Ese gasto ya estaba anulado.';
  end if;

  if g.paga_caja then
    v_turno := public.turno_abierto_id(g.sucursal_id);
    if v_turno is null then
      raise exception 'La plata tiene que volver al cajon y la caja esta cerrada. Abrila y anula despues.';
    end if;
    insert into public.movimientos_caja
      (turno_id, sucursal_id, tipo, monto, motivo, usuario_id, referencia_id)
    values
      (v_turno, g.sucursal_id, 'ingreso', g.monto,
       'Anulacion de gasto: ' || btrim(p_motivo), v_usuario, g.id);
  end if;

  update public.gastos
     set anulado = true,
         anulado_por = v_usuario,
         anulado_at = now(),
         motivo_anulacion = btrim(p_motivo)
   where id = p_gasto_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
alter table public.categorias_gasto enable row level security;
alter table public.gastos enable row level security;

drop policy if exists categorias_gasto_select_usuarios_activos on public.categorias_gasto;
create policy categorias_gasto_select_usuarios_activos on public.categorias_gasto
  for select to authenticated using (public.mi_rol() is not null);

drop policy if exists categorias_gasto_escribe_dueno on public.categorias_gasto;
create policy categorias_gasto_escribe_dueno on public.categorias_gasto
  for all to authenticated
  using (public.tiene_rol(array['dueno']))
  with check (public.tiene_rol(array['dueno']));

-- Los gastos se leen desde la pantalla y se escriben solo por las funciones de
-- arriba. Es la misma regla que ventas, pagos y caja: ninguna tabla de plata
-- acepta un insert suelto, porque un insert suelto se saltea la caja.
drop policy if exists gastos_select_usuarios_activos on public.gastos;
create policy gastos_select_usuarios_activos on public.gastos
  for select to authenticated using (public.mi_rol() is not null);

grant select, insert, update, delete on public.categorias_gasto to authenticated;
grant select, insert, update, delete on public.categorias_gasto to service_role;
grant select on public.gastos to authenticated;

revoke execute on function public.registrar_gasto(uuid, uuid, text, numeric, date, boolean) from public, anon;
revoke execute on function public.anular_gasto(uuid, text) from public, anon;
grant execute on function public.registrar_gasto(uuid, uuid, text, numeric, date, boolean) to authenticated;
grant execute on function public.anular_gasto(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Carga inicial
-- ---------------------------------------------------------------------------
-- Las que ya usa el negocio. El dueno agrega y desactiva desde la pantalla.
insert into public.categorias_gasto (nombre, orden)
values
  ('Alquiler', 10), ('Luz', 20), ('Agua', 30), ('Gas', 40),
  ('Internet y telefono', 50), ('Sueldos', 60), ('Cargas sociales', 70),
  ('Fletes', 80), ('Insumos', 90), ('Marketing', 100), ('Impuestos', 110),
  ('Mantenimiento', 120), ('Otros', 130)
on conflict do nothing;
