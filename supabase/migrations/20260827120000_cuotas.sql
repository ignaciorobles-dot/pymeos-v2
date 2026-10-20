-- Las cuotas, como dato y no como nombre.
--
-- Hasta ahora un plan de tarjeta era un medio de pago mas: "Credito 3 cuotas"
-- con su recargo. Funciona para cobrar — el recargo se aplica igual — pero deja
-- las cuotas escondidas adentro de un texto. Y ahi empiezan los problemas:
--
--   * "Cuanto vendi en 6 cuotas" no se puede contestar sin leer nombres, y
--     alcanza con que alguien escriba "Credito 6c" para que ese mes no cuente.
--   * La liquidacion de la tarjeta llega separada por plan. Si el sistema no
--     sabe en cuantas cuotas se vendio, conciliar es a mano.
--
-- Asi que las cuotas pasan a ser un numero. El plan las declara, y cada pago se
-- lleva las suyas.
--
-- Lo que NO cambia: el plan sigue siendo un medio de pago. No se agrega una
-- pantalla de planes ni un selector de cuotas en el cobro, porque el cajero ya
-- elige "Credito 6 cuotas" de la lista y con eso ya dijo todo.

alter table public.medios_pago
  add column if not exists cuotas integer not null default 1;

alter table public.medios_pago
  drop constraint if exists medios_pago_cuotas_validas;
alter table public.medios_pago
  add constraint medios_pago_cuotas_validas check (cuotas >= 1);

comment on column public.medios_pago.cuotas is
  'En cuantas cuotas cobra este plan. 1 = un pago. Lo mira el reporte, no cambia como se cobra.';


-- En el pago va nullable a proposito, aunque despues nunca quede en null.
--
-- Es la unica forma de distinguir "no me lo dijeron" de "me dijeron 1". Si
-- tuviera default 1, el trigger de abajo no podria saber si tiene que ir a
-- buscar las del plan o si alguien eligio un pago. Lo completa el trigger y
-- despues el CHECK garantiza que quedo.
alter table public.pagos
  add column if not exists cuotas integer;

comment on column public.pagos.cuotas is
  'Congelado al cobrar, igual que el costo en las lineas de venta. Si manana el plan pasa de 6 a 12 cuotas, las ventas viejas tienen que seguir diciendo 6.';


-- Por que un trigger y no tocar `registrar_venta`:
--
-- `registrar_venta` es la funcion mas critica del sistema y tiene casi
-- doscientas lineas. Reescribirla entera para agregar una columna a un insert
-- es mucho riesgo para muy poco: cualquier error de transcripcion rompe vender.
-- Esto se mete al lado, hace una sola cosa, y se lee de una.
--
-- Ademas cubre cualquier otra puerta por la que entre un pago, hoy o manana,
-- sin que haya que acordarse de agregarlo.
create or replace function public.pago_congela_cuotas()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.cuotas is null then
    select cuotas into new.cuotas
      from public.medios_pago
     where id = new.medio_pago_id;
  end if;

  -- Si el medio no existiera, el foreign key lo va a rechazar igual un
  -- instante despues. El coalesce esta para que el CHECK no explote antes con
  -- un mensaje que no ayuda a nadie.
  new.cuotas := coalesce(new.cuotas, 1);
  return new;
end;
$$;

comment on function public.pago_congela_cuotas() is
  'Copia al pago las cuotas del plan con el que se cobro, si no vinieron dadas.';

drop trigger if exists pagos_congelan_cuotas on public.pagos;
create trigger pagos_congelan_cuotas
  before insert on public.pagos
  for each row execute function public.pago_congela_cuotas();

-- Los pagos que ya estaban quedan en un pago, que es lo que eran: hasta hoy no
-- habia planes cargados con cuotas.
update public.pagos set cuotas = 1 where cuotas is null;

alter table public.pagos
  drop constraint if exists pagos_cuotas_validas;
alter table public.pagos
  add constraint pagos_cuotas_validas check (cuotas is not null and cuotas >= 1);


-- ---------------------------------------------------------------------------
-- El reporte
-- ---------------------------------------------------------------------------
/**
 * Cuanto entro por cada plan en el periodo.
 *
 * Es la vista que hace falta cuando llega la liquidacion de la tarjeta: viene
 * separada por plan, y hasta ahora habia que sacar la cuenta a mano.
 *
 * El recargo va en su propia columna porque no es plata del negocio: es lo que
 * se le sumo al cliente para cubrir el costo de financiar. Mezclarlo con el
 * monto haria parecer que se vendio mas.
 *
 * Las ventas anuladas no cuentan. Una venta que se dio de baja no entro por
 * ningun plan.
 */
create or replace function public.cobros_por_medio(
  p_desde       date,
  p_hasta       date,
  p_sucursal_id uuid default null
)
returns table (
  medio    text,
  cuotas   integer,
  cuantos  integer,
  monto    numeric,
  recargo  numeric
)
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_zona  text := 'America/Argentina/Cordoba';
  v_desde timestamptz;
  v_hasta timestamptz;
begin
  if not public.tiene_rol(array['dueno','contador']) then
    raise exception 'Los cobros por plan son de los duenos.';
  end if;

  if p_desde is null or p_hasta is null or p_hasta < p_desde then
    raise exception 'El periodo esta al reves o incompleto.';
  end if;

  -- Mismo criterio que el resto de los reportes: el limite de arriba es
  -- exclusivo y cae al dia siguiente, y la conversion lleva la zona puesta. Sin
  -- la zona, una venta de las 21:00 del ultimo dia se cuenta en el mes que
  -- viene, porque en UTC ya es otro dia.
  v_desde := p_desde::timestamp at time zone v_zona;
  v_hasta := (p_hasta + 1)::timestamp at time zone v_zona;

  return query
  select m.nombre,
         p.cuotas,
         count(*)::integer,
         sum(p.monto),
         sum(p.recargo)
    from public.pagos p
    join public.ventas v      on v.id = p.venta_id
    join public.medios_pago m on m.id = p.medio_pago_id
   where v.estado = 'completada'
     and (p_sucursal_id is null or v.sucursal_id = p_sucursal_id)
     and v.created_at >= v_desde
     and v.created_at <  v_hasta
   group by m.nombre, p.cuotas
   -- Primero lo que mas plata movio, que es lo que se mira.
   order by sum(p.monto) desc;
end;
$$;

comment on function public.cobros_por_medio(date, date, uuid) is
  'Lo cobrado en el periodo por plan y cantidad de cuotas. Para conciliar contra la liquidacion de la tarjeta.';

revoke execute on function public.cobros_por_medio(date, date, uuid) from public, anon;
grant execute on function public.cobros_por_medio(date, date, uuid) to authenticated;

-- El trigger corre con los permisos de su duenio, asi que no hace falta abrirle
-- `medios_pago` a nadie. Pero `pagos` ya se escribe solo desde `registrar_venta`
-- y esto no cambia esa puerta.
