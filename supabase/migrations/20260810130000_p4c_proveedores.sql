-- P4c (1 de 2) - Proveedores y lo que se les debe.
--
-- Es el espejo exacto de clientes / movimientos_cuenta, y a proposito: el
-- negocio ya tiene un libro mayor de deuda que funciona, esta probado y se sabe
-- leer. Inventarle otro modelo a la deuda con proveedores serian dos formas
-- distintas de contestar la misma pregunta ("cuanto se debe y desde cuando"), y
-- la segunda siempre es la que nadie mantiene.
--
-- La unica diferencia esta en el signo, y conviene tenerla clara:
--
--   clientes.saldo    positivo = el cliente NOS debe.
--   proveedores.saldo positivo = NOSOTROS le debemos al proveedor.
--
-- En los dos casos "positivo" quiere decir plata pendiente, mirado desde el
-- lado del que tiene la cuenta abierta. Ninguno de los dos saldos se escribe a
-- mano: los dos salen de sumar su libro mayor con un trigger.

create table if not exists public.proveedores (
  id            uuid primary key default gen_random_uuid(),
  nombre        text not null check (length(btrim(nombre)) > 0),
  cuit          text,
  condicion_iva text not null default 'responsable_inscripto',
  telefono      text,
  email         text,
  direccion     text,
  notas         text,
  saldo         numeric(12,2) not null default 0,
  activo        boolean not null default true,
  created_at    timestamptz not null default now(),

  -- Mismo vocabulario que clientes y sucursales. Que sea el mismo importa
  -- cuando haya que decidir que comprobante entra: si aca dijera "monotributo"
  -- y alla "monotributista", la comparacion falla y nadie se entera.
  constraint proveedores_condicion_iva_valida check (
    condicion_iva in (
      'consumidor_final',
      'responsable_inscripto',
      'monotributista',
      'exento',
      'no_categorizado'
    )
  ),
  -- El CUIT es opcional al cargarlo (se le puede comprar a alguien antes de
  -- tener el dato), pero si esta tiene que ser un CUIT y no cualquier cosa.
  constraint proveedores_cuit_valido check (
    cuit is null or cuit ~ '^[0-9]{11}$'
  )
);

comment on table public.proveedores is
  'A quien se le compra mercaderia. saldo positivo = se le debe.';
comment on column public.proveedores.saldo is
  'Lo calcula el trigger desde movimientos_proveedor. Nadie tiene permiso de escribirlo: un saldo tipeable no sirve para discutir con un proveedor.';
comment on column public.proveedores.cuit is
  'Sin guiones ni puntos, 11 digitos. Es lo que despues va a pedir el sistema de facturacion.';

-- Dos proveedores con el mismo nombre son el mismo proveedor cargado dos veces,
-- y la deuda queda partida entre los dos. Misma regla que las listas del
-- catalogo. Los desactivados quedan afuera para poder recargar uno viejo.
create unique index if not exists proveedores_nombre_unico
  on public.proveedores (lower(btrim(nombre))) where activo;

create index if not exists proveedores_con_deuda_idx
  on public.proveedores (saldo) where saldo <> 0;

-- ---------------------------------------------------------------------------
-- Libro mayor de la cuenta con el proveedor
-- ---------------------------------------------------------------------------
create table if not exists public.movimientos_proveedor (
  id            uuid primary key default gen_random_uuid(),
  proveedor_id  uuid not null references public.proveedores(id),
  sucursal_id   uuid not null references public.sucursales(id),
  tipo          text not null check (tipo in ('compra','pago','ajuste','anulacion')),
  monto         numeric(12,2) not null check (monto <> 0),
  compra_id     uuid,
  medio_pago_id uuid references public.medios_pago(id),
  usuario_id    uuid not null references public.usuarios(user_id),
  nota          text,
  created_at    timestamptz not null default now()
);

comment on table public.movimientos_proveedor is
  'El libro mayor de lo que se debe a proveedores. Inmutable: un error se corrige con un ajuste a la vista, nunca borrando la fila.';
comment on column public.movimientos_proveedor.monto is
  'Con signo: positivo suma deuda (se compro en cuenta corriente), negativo la baja (se le pago).';
comment on column public.movimientos_proveedor.compra_id is
  'Sin foreign key todavia: la tabla compras nace en la migracion que sigue. Se la agrega ahi, cuando existe.';

create index if not exists movimientos_proveedor_idx
  on public.movimientos_proveedor (proveedor_id, created_at desc);

-- El saldo lo lleva la base, igual que el del cliente y que el stock.
create or replace function public.aplicar_movimiento_proveedor()
returns trigger
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
begin
  update public.proveedores
     set saldo = saldo + new.monto
   where id = new.proveedor_id;
  return new;
end;
$$;

drop trigger if exists movimientos_proveedor_aplica on public.movimientos_proveedor;
create trigger movimientos_proveedor_aplica
after insert on public.movimientos_proveedor
for each row execute function public.aplicar_movimiento_proveedor();

create or replace function public.movimientos_proveedor_inmutables()
returns trigger
language plpgsql set search_path to 'public','pg_temp'
as $$
begin
  raise exception 'Los movimientos de cuenta con proveedores no se editan ni se borran. Corregi con un movimiento de tipo ajuste.';
end;
$$;

drop trigger if exists movimientos_proveedor_sin_update on public.movimientos_proveedor;
create trigger movimientos_proveedor_sin_update
before update or delete on public.movimientos_proveedor
for each row execute function public.movimientos_proveedor_inmutables();

-- ---------------------------------------------------------------------------
-- Pagarle a un proveedor
-- ---------------------------------------------------------------------------
/**
 * Baja la deuda con el proveedor y, si se paga en efectivo, saca la plata del
 * cajon en el mismo movimiento. Es el espejo de cobrar una cuenta corriente,
 * con la caja al reves: ahi la plata entra, aca sale.
 */
create or replace function public.pagar_proveedor(
  p_proveedor_id  uuid,
  p_sucursal_id   uuid,
  p_monto         numeric,
  p_medio_pago_id uuid,
  p_nota          text default null
) returns uuid
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_usuario   uuid := auth.uid();
  v_monto     numeric(12,2) := round(coalesce(p_monto, 0), 2);
  v_medio     public.medios_pago%rowtype;
  v_proveedor public.proveedores%rowtype;
  v_turno     uuid;
  v_id        uuid;
begin
  if public.mi_rol() is null then
    raise exception 'Necesitas un usuario activo para pagarle a un proveedor.';
  end if;
  if not exists (select 1 from public.sucursales where id = p_sucursal_id and activa) then
    raise exception 'La sucursal no existe o esta desactivada.';
  end if;
  if v_monto <= 0 then
    raise exception 'El monto tiene que ser mayor a cero.';
  end if;

  select * into v_proveedor from public.proveedores where id = p_proveedor_id and activo;
  if not found then
    raise exception 'Ese proveedor no existe o esta desactivado.';
  end if;

  select * into v_medio from public.medios_pago where id = p_medio_pago_id and activo;
  if not found then
    raise exception 'Ese medio de pago no existe o esta desactivado.';
  end if;
  -- Pagarle a un proveedor "en cuenta corriente" seria pagar una deuda con
  -- otra deuda: no mueve nada y deja el saldo mintiendo.
  if v_medio.es_cuenta_corriente then
    raise exception 'La cuenta corriente no es una forma de pagar: es lo que se esta pagando.';
  end if;

  if v_medio.afecta_caja then
    -- Sacar plata del cajon es la operacion mas delicada del sistema. Misma
    -- regla que el retiro manual y que el gasto pagado de caja: la firma un dueno.
    if not public.tiene_rol(array['dueno']) then
      raise exception 'Un pago a proveedor en efectivo lo tiene que registrar un dueno.';
    end if;

    v_turno := public.turno_abierto_id(p_sucursal_id);
    if v_turno is null then
      raise exception 'La caja de esta sucursal esta cerrada. Abrila antes de pagar en efectivo.';
    end if;
    if public.saldo_esperado_caja(v_turno) - v_monto < 0 then
      raise exception 'No hay esa plata en la caja.';
    end if;

    insert into public.movimientos_caja
      (turno_id, sucursal_id, tipo, monto, motivo, usuario_id)
    values
      (v_turno, p_sucursal_id, 'retiro', -v_monto,
       'Pago a proveedor: ' || v_proveedor.nombre, v_usuario);
  end if;

  insert into public.movimientos_proveedor
    (proveedor_id, sucursal_id, tipo, monto, medio_pago_id, usuario_id, nota)
  values
    (p_proveedor_id, p_sucursal_id, 'pago', -v_monto, p_medio_pago_id, v_usuario,
     nullif(btrim(coalesce(p_nota, '')), ''))
  returning id into v_id;

  return v_id;
end;
$$;

/**
 * Corregir a mano un saldo con un proveedor. No edita nada: agrega el
 * movimiento contrario, que queda a la vista con quien lo hizo y por que.
 */
create or replace function public.ajustar_saldo_proveedor(
  p_proveedor_id uuid,
  p_sucursal_id  uuid,
  p_monto        numeric,
  p_motivo       text
) returns uuid
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_usuario uuid := auth.uid();
  v_monto   numeric(12,2) := round(coalesce(p_monto, 0), 2);
  v_id      uuid;
begin
  if not public.tiene_rol(array['dueno']) then
    raise exception 'Solo un dueno puede ajustar a mano un saldo con un proveedor.';
  end if;
  if v_monto = 0 then
    raise exception 'Un ajuste de cero no ajusta nada.';
  end if;
  if btrim(coalesce(p_motivo, '')) = '' then
    raise exception 'Hay que decir por que se ajusta. Un ajuste sin explicacion no se puede discutir despues.';
  end if;
  if not exists (select 1 from public.proveedores where id = p_proveedor_id and activo) then
    raise exception 'Ese proveedor no existe o esta desactivado.';
  end if;
  if not exists (select 1 from public.sucursales where id = p_sucursal_id and activa) then
    raise exception 'La sucursal no existe o esta desactivada.';
  end if;

  insert into public.movimientos_proveedor
    (proveedor_id, sucursal_id, tipo, monto, usuario_id, nota)
  values
    (p_proveedor_id, p_sucursal_id, 'ajuste', v_monto, v_usuario, btrim(p_motivo))
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
alter table public.proveedores          enable row level security;
alter table public.movimientos_proveedor enable row level security;

-- El proveedor en si es una ficha, no plata: se puede cargar y editar desde la
-- pantalla. El saldo no, porque no tiene permiso de columna (mas abajo).
drop policy if exists proveedores_select_usuarios_activos on public.proveedores;
create policy proveedores_select_usuarios_activos on public.proveedores
  for select to authenticated using (public.mi_rol() is not null);

drop policy if exists proveedores_escribe_dueno on public.proveedores;
create policy proveedores_escribe_dueno on public.proveedores
  for all to authenticated
  using (public.tiene_rol(array['dueno','contador']))
  with check (public.tiene_rol(array['dueno','contador']));

drop policy if exists movimientos_proveedor_select on public.movimientos_proveedor;
create policy movimientos_proveedor_select on public.movimientos_proveedor
  for select to authenticated using (public.mi_rol() is not null);

-- Insert y update por columnas: `saldo` queda afuera a proposito. Es la misma
-- proteccion que tiene clientes.saldo — se calcula, no se tipea.
grant select on public.proveedores to authenticated;
grant insert (nombre, cuit, condicion_iva, telefono, email, direccion, notas, activo)
  on public.proveedores to authenticated;
grant update (nombre, cuit, condicion_iva, telefono, email, direccion, notas, activo)
  on public.proveedores to authenticated;

-- El libro mayor se lee y nada mas. La unica puerta de escritura son las
-- funciones de arriba, que es donde vive la regla de la caja.
grant select on public.movimientos_proveedor to authenticated;

revoke execute on function public.pagar_proveedor(uuid, uuid, numeric, uuid, text) from public, anon;
revoke execute on function public.ajustar_saldo_proveedor(uuid, uuid, numeric, text) from public, anon;
grant execute on function public.pagar_proveedor(uuid, uuid, numeric, uuid, text) to authenticated;
grant execute on function public.ajustar_saldo_proveedor(uuid, uuid, numeric, text) to authenticated;
