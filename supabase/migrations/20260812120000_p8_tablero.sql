-- P8 - Tablero: los numeros del negocio, calculados en la base.
--
-- Hasta ahora la primera pantalla del sistema mostraba numeros inventados. Es
-- la peor pantalla para tener datos falsos: es la unica que alguien mira sin
-- buscar nada, y de ella salen las decisiones de "este mes vamos bien" o "hay
-- que frenar la compra".
--
-- Por que en la base y no en el navegador:
--
--  * Sumar plata trayendo todas las ventas del mes al navegador funciona con
--    doscientas ventas y se cae con veinte mil. Aca la suma la hace Postgres
--    sobre los indices que ya existen y viaja una fila.
--
--  * PostgREST no expone agregados por defecto en Supabase, asi que la
--    alternativa real era traer todo y sumar en JavaScript. No es alternativa.
--
--  * Estas funciones son la misma cuenta que despues va a usar la pantalla de
--    Resultado y cualquier reporte. Si vive en un componente, se copia y las
--    dos copias empiezan a dar distinto.
--
-- Tres decisiones que quedan escritas aca y explican los numeros:
--
--  1. El mes es el mes de Rosario, no el del servidor. Supabase corre en UTC:
--     una venta de las 22:30 del 31 seria del mes siguiente. Todos los cortes
--     se calculan en 'America/Argentina/Cordoba', que es la hora del local.
--
--  2. La comparacion contra el mes anterior usa el mismo pedazo de mes, no el
--     mes anterior completo. El dia 3 no se puede comparar tres dias contra
--     treinta: daria -90% todos los meses y nadie volveria a mirar la flecha.
--
--  3. La mercaderia comprada NO resta en el resultado. Resta el costo de lo
--     que efectivamente se vendio, congelado en la linea de venta. Comprar no
--     es perder plata: es cambiar plata por stock. Es la misma regla que ya
--     separa gastos de compras, ahora del lado del que mira el numero.

-- ---------------------------------------------------------------------------
-- Resumen del mes
-- ---------------------------------------------------------------------------
/**
 * Los numeros de las tarjetas de arriba del tablero, en una sola fila.
 *
 * p_sucursal_id null significa "las dos sucursales juntas". Aca esta permitido
 * y en el resto del sistema no, porque esto solo mira: no existe ninguna
 * operacion que se guarde "en las dos". Mirar todo junto si; operar sobre las
 * dos no existe.
 */
create or replace function public.resumen_tablero(
  p_sucursal_id   uuid default null,
  p_stock_minimo  integer default 3
)
returns table (
  ventas                  numeric,
  ventas_previo           numeric,
  costo                   numeric,
  costo_previo            numeric,
  gastos                  numeric,
  gastos_previo           numeric,
  resultado               numeric,
  resultado_previo        numeric,
  tickets                 integer,
  tickets_previo          integer,
  ticket_promedio         numeric,
  ticket_promedio_previo  numeric,
  stock_bajo              integer,
  por_cobrar              numeric
)
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_zona      text := 'America/Argentina/Cordoba';
  v_hoy       date;
  v_ini_local date;
  v_dias      integer;

  -- Cortes en timestamptz para que las ventas usen el indice por fecha.
  v_desde     timestamptz;
  v_hasta     timestamptz;
  v_desde_ant timestamptz;
  v_hasta_ant timestamptz;

  -- Los gastos se anotan con fecha (date), no con hora: el corte es otro.
  v_ini_ant_local date;
  v_fin_ant_local date;

  v_ventas     numeric := 0;  v_ventas_ant  numeric := 0;
  v_costo      numeric := 0;  v_costo_ant   numeric := 0;
  v_gastos     numeric := 0;  v_gastos_ant  numeric := 0;
  v_tickets    integer := 0;  v_tickets_ant integer := 0;
  v_bajo       integer := 0;
  v_cobrar     numeric := 0;
begin
  -- El tablero es la foto de la plata del negocio. La mira quien la puede
  -- mirar: el dueno, y el contador que despues tiene que explicarla.
  if not public.tiene_rol(array['dueno','contador']) then
    raise exception 'El tablero es de los duenos.';
  end if;

  v_hoy       := (now() at time zone v_zona)::date;
  v_ini_local := date_trunc('month', v_hoy::timestamp)::date;
  v_dias      := v_hoy - v_ini_local;

  v_desde     := v_ini_local::timestamp at time zone v_zona;
  v_hasta     := now();
  v_desde_ant := (v_ini_local - interval '1 month')::timestamp at time zone v_zona;
  -- El mismo pedazo del mes anterior: los mismos dias corridos y la misma hora.
  v_hasta_ant := v_desde_ant + (v_hasta - v_desde);

  v_ini_ant_local := (v_ini_local - interval '1 month')::date;
  v_fin_ant_local := v_ini_ant_local + v_dias;

  select coalesce(sum(v.total), 0), count(*)
    into v_ventas, v_tickets
    from public.ventas v
   where v.estado = 'completada'
     and (p_sucursal_id is null or v.sucursal_id = p_sucursal_id)
     and v.created_at >= v_desde and v.created_at < v_hasta;

  select coalesce(sum(v.total), 0), count(*)
    into v_ventas_ant, v_tickets_ant
    from public.ventas v
   where v.estado = 'completada'
     and (p_sucursal_id is null or v.sucursal_id = p_sucursal_id)
     and v.created_at >= v_desde_ant and v.created_at < v_hasta_ant;

  -- Costo de lo vendido, con el costo que tenia la mercaderia el dia que se
  -- vendio. Si esto leyera variantes.costo, cambiar un precio de lista
  -- reescribiria la ganancia de meses ya cerrados.
  select coalesce(sum(vl.cantidad * vl.costo_unitario), 0)
    into v_costo
    from public.venta_lineas vl
    join public.ventas v on v.id = vl.venta_id
   where v.estado = 'completada'
     and (p_sucursal_id is null or v.sucursal_id = p_sucursal_id)
     and v.created_at >= v_desde and v.created_at < v_hasta;

  select coalesce(sum(vl.cantidad * vl.costo_unitario), 0)
    into v_costo_ant
    from public.venta_lineas vl
    join public.ventas v on v.id = vl.venta_id
   where v.estado = 'completada'
     and (p_sucursal_id is null or v.sucursal_id = p_sucursal_id)
     and v.created_at >= v_desde_ant and v.created_at < v_hasta_ant;

  select coalesce(sum(g.monto), 0) into v_gastos
    from public.gastos g
   where not g.anulado
     and (p_sucursal_id is null or g.sucursal_id = p_sucursal_id)
     and g.fecha >= v_ini_local and g.fecha <= v_hoy;

  select coalesce(sum(g.monto), 0) into v_gastos_ant
    from public.gastos g
   where not g.anulado
     and (p_sucursal_id is null or g.sucursal_id = p_sucursal_id)
     and g.fecha >= v_ini_ant_local and g.fecha <= v_fin_ant_local;

  -- Stock bajo. Cuenta variantes activas de productos activos, no productos:
  -- que queden dos pares del 44 y ninguno del 43 es exactamente el aviso que
  -- se necesita, y contando por producto no aparece.
  select count(*) into v_bajo
    from public.stock st
    join public.variantes vt on vt.id = st.variante_id
    join public.productos p on p.id = vt.producto_id
   where vt.activa and p.activo
     and (p_sucursal_id is null or st.sucursal_id = p_sucursal_id)
     and st.cantidad <= p_stock_minimo;

  -- Lo fiado que todavia no se cobro. No entra en el resultado (la venta ya
  -- se conto cuando se hizo), pero es plata que falta en el cajon y el dueno
  -- la tiene que ver al lado de lo demas.
  --
  -- Solo los saldos positivos: un cliente con saldo a favor no le tapa la
  -- deuda a otro. Lo que hay que salir a cobrar es la suma de los que deben.
  --
  -- No se filtra por sucursal: la cuenta corriente es del cliente, no del
  -- local. El que fio en Centro paga en Norte y esta bien que asi sea.
  select coalesce(sum(c.saldo), 0) into v_cobrar
    from public.clientes c
   where c.saldo > 0;

  return query select
    v_ventas, v_ventas_ant,
    v_costo, v_costo_ant,
    v_gastos, v_gastos_ant,
    v_ventas - v_costo - v_gastos,
    v_ventas_ant - v_costo_ant - v_gastos_ant,
    v_tickets, v_tickets_ant,
    case when v_tickets > 0 then round(v_ventas / v_tickets, 2) else 0 end,
    case when v_tickets_ant > 0 then round(v_ventas_ant / v_tickets_ant, 2) else 0 end,
    v_bajo,
    v_cobrar;
end;
$$;

comment on function public.resumen_tablero(uuid, integer) is
  'Numeros del mes en curso y del mismo pedazo del mes anterior, para las tarjetas del tablero. Sucursal null = las dos juntas, y solo para mirar.';

-- ---------------------------------------------------------------------------
-- Ventas por dia, para el grafico
-- ---------------------------------------------------------------------------
/**
 * Una fila por dia, incluidos los dias sin ventas. Los dias vacios importan:
 * un grafico que saltea el lunes que no se vendio nada dibuja una linea plana
 * y esconde justamente el dia que habia que mirar.
 */
create or replace function public.ventas_por_dia(
  p_sucursal_id uuid default null,
  p_dias        integer default 30
)
returns table (dia date, total numeric, tickets integer)
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_zona  text := 'America/Argentina/Cordoba';
  v_hoy   date;
  v_desde date;
  v_dias  integer := least(greatest(coalesce(p_dias, 30), 1), 365);
begin
  if not public.tiene_rol(array['dueno','contador']) then
    raise exception 'El tablero es de los duenos.';
  end if;

  v_hoy   := (now() at time zone v_zona)::date;
  v_desde := v_hoy - (v_dias - 1);

  return query
  with dias as (
    select generate_series(v_desde, v_hoy, interval '1 day')::date as d
  ),
  vendido as (
    select (v.created_at at time zone v_zona)::date as d,
           sum(v.total) as total,
           count(*)::integer as tickets
      from public.ventas v
     where v.estado = 'completada'
       and (p_sucursal_id is null or v.sucursal_id = p_sucursal_id)
       and v.created_at >= (v_desde::timestamp at time zone v_zona)
     group by 1
  )
  select dias.d, coalesce(vendido.total, 0)::numeric, coalesce(vendido.tickets, 0)
    from dias left join vendido on vendido.d = dias.d
   order by dias.d;
end;
$$;

comment on function public.ventas_por_dia(uuid, integer) is
  'Serie diaria de ventas para el grafico del tablero, con los dias sin ventas en cero.';

-- ---------------------------------------------------------------------------
-- Ultimos movimientos
-- ---------------------------------------------------------------------------
/**
 * Lo ultimo que paso en el negocio, mezclado y en orden: ventas, gastos,
 * compras y los movimientos de caja que alguien hizo a mano.
 *
 * Los movimientos de caja que nacen de una venta o de un gasto quedan afuera a
 * proposito (tienen referencia_id): si entraran, cada venta en efectivo
 * apareceria dos veces y la lista dejaria de leerse.
 *
 * Cada pedazo del union trae su propio limite antes de mezclar. Sin eso, pedir
 * las ultimas ocho cosas obligaria a Postgres a ordenar todas las ventas de la
 * historia para tirar todas menos ocho: anda hoy con cien ventas y se arrastra
 * con veinte mil.
 */
create or replace function public.ultimos_movimientos(
  p_sucursal_id uuid default null,
  p_limite      integer default 8
)
returns table (
  cuando   timestamptz,
  tipo     text,
  detalle  text,
  monto    numeric,
  sucursal text,
  quien    text,
  ruta     text
)
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_limite integer := least(greatest(coalesce(p_limite, 8), 1), 100);
begin
  if not public.tiene_rol(array['dueno','contador']) then
    raise exception 'El tablero es de los duenos.';
  end if;

  return query
  select * from (
    (select
      v.created_at,
      case when v.estado = 'anulada' then 'Venta anulada' else 'Venta' end,
      coalesce(
        (select string_agg(
                  p.nombre
                  || coalesce(' T.' || vt.talle, '')
                  || case when vl.cantidad <> 1 then ' x' || vl.cantidad else '' end,
                  ', ' order by p.nombre)
           from public.venta_lineas vl
           join public.variantes vt on vt.id = vl.variante_id
           join public.productos p on p.id = vt.producto_id
          where vl.venta_id = v.id),
        'Ticket #' || v.numero),
      case when v.estado = 'anulada' then 0 else v.total end,
      s.alias,
      u.nombre,
      '/ventas'
      from public.ventas v
      join public.sucursales s on s.id = v.sucursal_id
      left join public.usuarios u on u.user_id = v.usuario_id
     where (p_sucursal_id is null or v.sucursal_id = p_sucursal_id)
     order by v.created_at desc
     limit v_limite)

    union all

    (select
      g.created_at,
      'Gasto',
      c.nombre || ': ' || g.detalle,
      -g.monto,
      s.alias,
      u.nombre,
      '/gastos'
      from public.gastos g
      join public.categorias_gasto c on c.id = g.categoria_id
      join public.sucursales s on s.id = g.sucursal_id
      left join public.usuarios u on u.user_id = g.usuario_id
     where not g.anulado
       and (p_sucursal_id is null or g.sucursal_id = p_sucursal_id)
     order by g.created_at desc
     limit v_limite)

    union all

    (select
      co.created_at,
      'Compra',
      pr.nombre
        || coalesce(' - ' || co.numero_comprobante, '')
        || ' (compra #' || co.numero || ')',
      -co.total,
      s.alias,
      u.nombre,
      '/compras'
      from public.compras co
      join public.proveedores pr on pr.id = co.proveedor_id
      join public.sucursales s on s.id = co.sucursal_id
      left join public.usuarios u on u.user_id = co.usuario_id
     where co.estado = 'registrada'
       and (p_sucursal_id is null or co.sucursal_id = p_sucursal_id)
     order by co.created_at desc
     limit v_limite)

    union all

    (select
      m.created_at,
      case when m.monto > 0 then 'Ingreso de caja' else 'Retiro de caja' end,
      m.motivo,
      m.monto,
      s.alias,
      u.nombre,
      '/caja'
      from public.movimientos_caja m
      join public.sucursales s on s.id = m.sucursal_id
      left join public.usuarios u on u.user_id = m.usuario_id
     where m.referencia_id is null
       and (p_sucursal_id is null or m.sucursal_id = p_sucursal_id)
     order by m.created_at desc
     limit v_limite)
  ) todo (cuando, tipo, detalle, monto, sucursal, quien, ruta)
  order by todo.cuando desc
  limit v_limite;
end;
$$;

comment on function public.ultimos_movimientos(uuid, integer) is
  'Ultimas cosas que pasaron en el negocio, mezcladas y en orden, para la lista de abajo del tablero.';

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
-- Son de lectura y no escriben nada, pero son security definer: pasan por
-- arriba de RLS para poder sumar. Por eso la primera linea de cada una es el
-- control de rol, y por eso anon no las puede ejecutar.
revoke execute on function public.resumen_tablero(uuid, integer) from public, anon;
revoke execute on function public.ventas_por_dia(uuid, integer) from public, anon;
revoke execute on function public.ultimos_movimientos(uuid, integer) from public, anon;

grant execute on function public.resumen_tablero(uuid, integer) to authenticated;
grant execute on function public.ventas_por_dia(uuid, integer) to authenticated;
grant execute on function public.ultimos_movimientos(uuid, integer) to authenticated;
