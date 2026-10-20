-- P8 - Resultado: cuanto quedo, y de donde salio.
--
-- El tablero contesta "como venimos este mes". Esta pantalla contesta otra
-- pregunta, la que se hace con el contador al lado: cuanto quedo en un periodo
-- cualquiera, cuanto puso cada sucursal, y en que se fue la plata.
--
-- La cuenta es siempre la misma y esta escrita una sola vez:
--
--     ventas - costo de lo vendido - gastos = resultado
--
--  * ventas: lo facturado en el periodo, sin las anuladas.
--  * costo de lo vendido: el costo que tenia cada par el dia que se vendio,
--    congelado en la linea de venta. No se lee variantes.costo: cambiar un
--    precio de lista no puede reescribir la ganancia de un mes ya cerrado.
--  * gastos: lo operativo, sin la mercaderia. Comprar mercaderia no resta:
--    es cambiar plata por stock. Cuando esa mercaderia se venda, va a restar
--    como costo de lo vendido. Contarla en los dos lados partiria el resultado
--    del mes al medio.
--
-- Igual que en el tablero, los cortes se calculan en la hora de Rosario: el
-- servidor esta en UTC y una venta de las 22:30 del 31 caeria en el mes
-- siguiente.
--
-- Las ventas se filtran por created_at (timestamptz) para usar el indice que
-- ya existe; los gastos por fecha (date), que es como se anotan.

-- ---------------------------------------------------------------------------
-- Resultado de un periodo
-- ---------------------------------------------------------------------------
create or replace function public.resultado_periodo(
  p_desde       date,
  p_hasta       date,
  p_sucursal_id uuid default null
)
returns table (
  ventas          numeric,
  unidades        integer,
  costo           numeric,
  margen          numeric,
  gastos          numeric,
  resultado       numeric,
  tickets         integer,
  ticket_promedio numeric
)
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_zona   text := 'America/Argentina/Cordoba';
  v_desde  timestamptz;
  v_hasta  timestamptz;
  v_ventas numeric := 0;
  v_unid   integer := 0;
  v_costo  numeric := 0;
  v_gastos numeric := 0;
  v_tick   integer := 0;
begin
  if not public.tiene_rol(array['dueno','contador']) then
    raise exception 'El resultado es de los duenos.';
  end if;

  if p_desde is null or p_hasta is null or p_hasta < p_desde then
    raise exception 'El periodo esta al reves o incompleto.';
  end if;

  -- El limite de arriba es exclusivo y cae al dia siguiente: asi una venta de
  -- las 20:00 del ultimo dia entra, que es lo que espera cualquiera que pida
  -- "del 1 al 31".
  v_desde := p_desde::timestamp at time zone v_zona;
  v_hasta := (p_hasta + 1)::timestamp at time zone v_zona;

  select coalesce(sum(v.total), 0), count(*)
    into v_ventas, v_tick
    from public.ventas v
   where v.estado = 'completada'
     and (p_sucursal_id is null or v.sucursal_id = p_sucursal_id)
     and v.created_at >= v_desde and v.created_at < v_hasta;

  select coalesce(sum(vl.cantidad), 0),
         coalesce(sum(vl.cantidad * vl.costo_unitario), 0)
    into v_unid, v_costo
    from public.venta_lineas vl
    join public.ventas v on v.id = vl.venta_id
   where v.estado = 'completada'
     and (p_sucursal_id is null or v.sucursal_id = p_sucursal_id)
     and v.created_at >= v_desde and v.created_at < v_hasta;

  select coalesce(sum(g.monto), 0) into v_gastos
    from public.gastos g
   where not g.anulado
     and (p_sucursal_id is null or g.sucursal_id = p_sucursal_id)
     and g.fecha >= p_desde and g.fecha <= p_hasta;

  return query select
    v_ventas,
    v_unid,
    v_costo,
    v_ventas - v_costo,
    v_gastos,
    v_ventas - v_costo - v_gastos,
    v_tick,
    case when v_tick > 0 then round(v_ventas / v_tick, 2) else 0 end;
end;
$$;

comment on function public.resultado_periodo(date, date, uuid) is
  'Ventas, costo de lo vendido, gastos y resultado de un periodo. Sucursal null = las dos juntas.';

-- ---------------------------------------------------------------------------
-- El mismo resultado, abierto por sucursal
-- ---------------------------------------------------------------------------
/**
 * Una fila por sucursal activa, incluidas las que no vendieron nada. Una
 * sucursal que no aparece se lee como "no la calculo"; una sucursal en cero se
 * lee como "no vendio", que es la informacion que hace falta.
 */
create or replace function public.resultado_por_sucursal(
  p_desde date,
  p_hasta date
)
returns table (
  sucursal_id uuid,
  sucursal    text,
  ventas      numeric,
  costo       numeric,
  gastos      numeric,
  resultado   numeric,
  tickets     integer
)
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_zona  text := 'America/Argentina/Cordoba';
  v_desde timestamptz;
  v_hasta timestamptz;
begin
  if not public.tiene_rol(array['dueno','contador']) then
    raise exception 'El resultado es de los duenos.';
  end if;

  if p_desde is null or p_hasta is null or p_hasta < p_desde then
    raise exception 'El periodo esta al reves o incompleto.';
  end if;

  v_desde := p_desde::timestamp at time zone v_zona;
  v_hasta := (p_hasta + 1)::timestamp at time zone v_zona;

  return query
  select
    s.id,
    s.alias,
    coalesce(vt.total, 0),
    coalesce(vt.costo, 0),
    coalesce(gs.total, 0),
    coalesce(vt.total, 0) - coalesce(vt.costo, 0) - coalesce(gs.total, 0),
    coalesce(vt.tickets, 0)
    from public.sucursales s
    left join lateral (
      select sum(v.total) as total,
             count(*)::integer as tickets,
             (select coalesce(sum(vl.cantidad * vl.costo_unitario), 0)
                from public.venta_lineas vl
                join public.ventas v2 on v2.id = vl.venta_id
               where v2.sucursal_id = s.id
                 and v2.estado = 'completada'
                 and v2.created_at >= v_desde and v2.created_at < v_hasta) as costo
        from public.ventas v
       where v.sucursal_id = s.id
         and v.estado = 'completada'
         and v.created_at >= v_desde and v.created_at < v_hasta
    ) vt on true
    left join lateral (
      select sum(g.monto) as total
        from public.gastos g
       where g.sucursal_id = s.id
         and not g.anulado
         and g.fecha >= p_desde and g.fecha <= p_hasta
    ) gs on true
   where s.activa
   order by s.alias;
end;
$$;

comment on function public.resultado_por_sucursal(date, date) is
  'El resultado del periodo abierto por sucursal, con las que no vendieron en cero.';

-- ---------------------------------------------------------------------------
-- En que se fue la plata
-- ---------------------------------------------------------------------------
create or replace function public.gastos_por_categoria(
  p_desde       date,
  p_hasta       date,
  p_sucursal_id uuid default null
)
returns table (categoria text, total numeric, cuantos integer)
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
begin
  if not public.tiene_rol(array['dueno','contador']) then
    raise exception 'El resultado es de los duenos.';
  end if;

  if p_desde is null or p_hasta is null or p_hasta < p_desde then
    raise exception 'El periodo esta al reves o incompleto.';
  end if;

  return query
  select c.nombre, sum(g.monto), count(*)::integer
    from public.gastos g
    join public.categorias_gasto c on c.id = g.categoria_id
   where not g.anulado
     and (p_sucursal_id is null or g.sucursal_id = p_sucursal_id)
     and g.fecha >= p_desde and g.fecha <= p_hasta
   group by c.nombre
   -- De mayor a menor: el primer renglon es el que hay que discutir.
   order by sum(g.monto) desc;
end;
$$;

comment on function public.gastos_por_categoria(date, date, uuid) is
  'Los gastos del periodo agrupados por categoria, de mayor a menor.';

-- ---------------------------------------------------------------------------
-- La serie mensual
-- ---------------------------------------------------------------------------
/**
 * Un mes por fila, para ver si el resultado sube o baja. Un solo numero no
 * dice nada: dos millones de ganancia puede ser el mejor mes del ano o la
 * mitad del anterior.
 */
create or replace function public.resultado_por_mes(
  p_meses       integer default 12,
  p_sucursal_id uuid default null
)
returns table (
  mes       date,
  ventas    numeric,
  costo     numeric,
  gastos    numeric,
  resultado numeric
)
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_zona  text := 'America/Argentina/Cordoba';
  v_meses integer := least(greatest(coalesce(p_meses, 12), 1), 36);
  v_hoy   date;
begin
  if not public.tiene_rol(array['dueno','contador']) then
    raise exception 'El resultado es de los duenos.';
  end if;

  v_hoy := (now() at time zone v_zona)::date;

  return query
  with meses as (
    select generate_series(
             date_trunc('month', v_hoy::timestamp) - ((v_meses - 1) || ' months')::interval,
             date_trunc('month', v_hoy::timestamp),
             interval '1 month'
           )::date as m
  )
  select
    meses.m,
    coalesce((select sum(v.total)
                from public.ventas v
               where v.estado = 'completada'
                 and (p_sucursal_id is null or v.sucursal_id = p_sucursal_id)
                 and v.created_at >= (meses.m::timestamp at time zone v_zona)
                 and v.created_at <  ((meses.m + interval '1 month')::timestamp at time zone v_zona)), 0),
    coalesce((select sum(vl.cantidad * vl.costo_unitario)
                from public.venta_lineas vl
                join public.ventas v on v.id = vl.venta_id
               where v.estado = 'completada'
                 and (p_sucursal_id is null or v.sucursal_id = p_sucursal_id)
                 and v.created_at >= (meses.m::timestamp at time zone v_zona)
                 and v.created_at <  ((meses.m + interval '1 month')::timestamp at time zone v_zona)), 0),
    coalesce((select sum(g.monto)
                from public.gastos g
               where not g.anulado
                 and (p_sucursal_id is null or g.sucursal_id = p_sucursal_id)
                 and g.fecha >= meses.m
                 and g.fecha <  (meses.m + interval '1 month')::date), 0),
    coalesce((select sum(v.total)
                from public.ventas v
               where v.estado = 'completada'
                 and (p_sucursal_id is null or v.sucursal_id = p_sucursal_id)
                 and v.created_at >= (meses.m::timestamp at time zone v_zona)
                 and v.created_at <  ((meses.m + interval '1 month')::timestamp at time zone v_zona)), 0)
    - coalesce((select sum(vl.cantidad * vl.costo_unitario)
                from public.venta_lineas vl
                join public.ventas v on v.id = vl.venta_id
               where v.estado = 'completada'
                 and (p_sucursal_id is null or v.sucursal_id = p_sucursal_id)
                 and v.created_at >= (meses.m::timestamp at time zone v_zona)
                 and v.created_at <  ((meses.m + interval '1 month')::timestamp at time zone v_zona)), 0)
    - coalesce((select sum(g.monto)
                from public.gastos g
               where not g.anulado
                 and (p_sucursal_id is null or g.sucursal_id = p_sucursal_id)
                 and g.fecha >= meses.m
                 and g.fecha <  (meses.m + interval '1 month')::date), 0)
    from meses
   order by meses.m;
end;
$$;

comment on function public.resultado_por_mes(integer, uuid) is
  'Serie mensual de ventas, costo, gastos y resultado, para ver la tendencia.';

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
revoke execute on function public.resultado_periodo(date, date, uuid) from public, anon;
revoke execute on function public.resultado_por_sucursal(date, date) from public, anon;
revoke execute on function public.gastos_por_categoria(date, date, uuid) from public, anon;
revoke execute on function public.resultado_por_mes(integer, uuid) from public, anon;

grant execute on function public.resultado_periodo(date, date, uuid) to authenticated;
grant execute on function public.resultado_por_sucursal(date, date) to authenticated;
grant execute on function public.gastos_por_categoria(date, date, uuid) to authenticated;
grant execute on function public.resultado_por_mes(integer, uuid) to authenticated;
