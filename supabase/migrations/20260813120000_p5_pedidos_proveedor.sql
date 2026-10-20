-- P5 (1 de 2) - Pedidos al proveedor: la intencion de comprar, antes de comprar.
--
-- Un pedido NO es una compra. No entra mercaderia, no se le debe nada a nadie,
-- no sale plata del cajon. Es la lista de lo que se le va a pedir a un
-- proveedor, con los numeros a la vista para decidir si conviene: cuanto sale,
-- cuanto se le suma de flete, a cuanto habria que venderlo y cuanto quedaria.
--
-- Cuando la mercaderia llega, el pedido no se "cierra" y ya: se convierte en la
-- compra que el sistema ya sabe hacer. Esa conversion es el punto entero de esta
-- migracion. Si el pedido moviera stock por su cuenta habria dos caminos por los
-- que entra mercaderia al deposito, y tarde o temprano uno de los dos queda
-- desactualizado. Hay un solo camino: registrar_compra.
--
-- Por eso, al recibir, se vuelve a preguntar que llego y a que costo. Casi nunca
-- llega exactamente lo que se pidio: faltan talles, cambian precios entre que se
-- pide y que llega. Lo que se pidio queda anotado, lo que llego es lo que entra.

-- ---------------------------------------------------------------------------
-- El pedido
-- ---------------------------------------------------------------------------
create table if not exists public.pedidos_proveedor (
  id                 uuid primary key default gen_random_uuid(),
  numero             bigint not null,
  sucursal_id        uuid not null references public.sucursales(id),
  proveedor_id       uuid not null references public.proveedores(id),
  usuario_id         uuid references public.usuarios(user_id),
  estado             text not null default 'borrador',
  fecha_pedido       date not null default current_date,
  fecha_estimada     date,
  gastos_estimados   numeric(12,2) not null default 0 check (gastos_estimados >= 0),
  nota               text,
  enviado_at         timestamptz,
  confirmado_at      timestamptz,
  recibido_at        timestamptz,
  compra_id          uuid references public.compras(id),
  cancelado_at       timestamptz,
  cancelado_por      uuid references public.usuarios(user_id),
  motivo_cancelacion text,
  created_at         timestamptz not null default now(),

  constraint pedidos_proveedor_estado_valido check (
    estado in ('borrador','enviado','confirmado','recibido','cancelado')
  ),
  -- Un pedido recibido sin compra seria mercaderia que entro sin dejar rastro.
  constraint pedidos_proveedor_recibido_tiene_compra check (
    estado <> 'recibido' or compra_id is not null
  )
);

comment on table public.pedidos_proveedor is
  'Lo que se le va a pedir a un proveedor. No mueve stock ni plata: cuando llega se convierte en una compra.';
comment on column public.pedidos_proveedor.gastos_estimados is
  'Flete, impuestos, lo que sea que encarezca el pedido y no venga en la factura del proveedor. No se contabiliza en ningun lado: se prorratea por unidad para que el precio sugerido no ignore el costo real de tener esa mercaderia en el local.';
comment on column public.pedidos_proveedor.compra_id is
  'La compra que nacio de este pedido. Se llena una sola vez, al recibir.';

create unique index if not exists pedidos_proveedor_numero_unico
  on public.pedidos_proveedor (sucursal_id, numero);

create index if not exists pedidos_proveedor_abiertos_idx
  on public.pedidos_proveedor (sucursal_id, fecha_pedido desc)
  where estado in ('borrador','enviado','confirmado');

create index if not exists pedidos_proveedor_por_proveedor_idx
  on public.pedidos_proveedor (proveedor_id, fecha_pedido desc);

-- ---------------------------------------------------------------------------
-- Las lineas: lo que se pide y lo que finalmente llega
-- ---------------------------------------------------------------------------
create table if not exists public.pedido_proveedor_lineas (
  id                  uuid primary key default gen_random_uuid(),
  pedido_id           uuid not null references public.pedidos_proveedor(id) on delete cascade,
  variante_id         uuid not null references public.variantes(id),
  cantidad            integer not null check (cantidad > 0),
  costo_unitario      numeric(12,2) not null check (costo_unitario >= 0),
  precio_previsto     numeric(12,2) check (precio_previsto is null or precio_previsto >= 0),
  precio_competencia  numeric(12,2) check (precio_competencia is null or precio_competencia >= 0),
  cantidad_recibida   integer check (cantidad_recibida is null or cantidad_recibida >= 0),
  costo_recibido      numeric(12,2) check (costo_recibido is null or costo_recibido >= 0)
);

comment on column public.pedido_proveedor_lineas.precio_previsto is
  'A cuanto se piensa venderlo. Es una decision, no un dato: por eso se guarda aca y no en variantes.precio, que recien cambia cuando la mercaderia esta en el local.';
comment on column public.pedido_proveedor_lineas.precio_competencia is
  'El precio que alguien vio en la competencia, cargado a mano. El sistema no lo sale a buscar a ningun lado: no existe una fuente confiable de precios de calzado, y un numero inventado es peor que ninguno.';
comment on column public.pedido_proveedor_lineas.cantidad_recibida is
  'Lo que realmente llego. Vacio mientras el pedido no se recibio. Comparado con cantidad, es el historial de cumplimiento del proveedor.';

-- El mismo par pedido dos veces en el mismo pedido son dos renglones que suman
-- mal en cualquier resumen. Se pide una cantidad, no dos renglones.
create unique index if not exists pedido_proveedor_lineas_unicas
  on public.pedido_proveedor_lineas (pedido_id, variante_id);

create index if not exists pedido_proveedor_lineas_por_variante_idx
  on public.pedido_proveedor_lineas (variante_id);

-- ---------------------------------------------------------------------------
-- Guardar un pedido (crear o reescribir el borrador)
-- ---------------------------------------------------------------------------
/**
 * Crea el pedido si p_pedido_id viene vacio, o reescribe sus lineas si ya
 * existe y todavia es un borrador. Reescribe todo en vez de ir linea por linea
 * porque la pantalla edita la lista entera: mandar el estado final completo
 * evita que un renglon borrado en el navegador sobreviva en la base.
 */
create or replace function public.guardar_pedido_proveedor(
  p_pedido_id        uuid,
  p_sucursal_id      uuid,
  p_proveedor_id     uuid,
  p_lineas           jsonb,
  p_fecha_estimada   date default null,
  p_gastos_estimados numeric default 0,
  p_nota             text default null
) returns uuid
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_usuario uuid := auth.uid();
  v_id      uuid := p_pedido_id;
  v_numero  bigint;
  v_linea   jsonb;
  v_estado  text;
begin
  if not public.tiene_rol(array['dueno','contador']) then
    raise exception 'Los pedidos a proveedores los maneja un dueno o el contador.';
  end if;
  if not exists (select 1 from public.sucursales where id = p_sucursal_id and activa) then
    raise exception 'La sucursal no existe o esta desactivada. Elegi en que sucursal esta trabajando este equipo, en Configuracion.';
  end if;
  if not exists (select 1 from public.proveedores where id = p_proveedor_id and activo) then
    raise exception 'Ese proveedor no existe o esta desactivado.';
  end if;
  if p_lineas is null or jsonb_array_length(p_lineas) = 0 then
    raise exception 'Un pedido sin mercaderia no es un pedido.';
  end if;

  if v_id is null then
    perform pg_advisory_xact_lock(hashtext('pedido_proveedor:' || p_sucursal_id::text));
    select coalesce(max(numero), 0) + 1 into v_numero
      from public.pedidos_proveedor where sucursal_id = p_sucursal_id;

    insert into public.pedidos_proveedor
      (numero, sucursal_id, proveedor_id, usuario_id, fecha_estimada, gastos_estimados, nota)
    values
      (v_numero, p_sucursal_id, p_proveedor_id, v_usuario, p_fecha_estimada,
       round(coalesce(p_gastos_estimados, 0), 2),
       nullif(btrim(coalesce(p_nota, '')), ''))
    returning id into v_id;
  else
    select estado into v_estado from public.pedidos_proveedor where id = v_id;
    if not found then
      raise exception 'Ese pedido no existe.';
    end if;
    -- Un pedido ya enviado al proveedor no se edita: el proveedor tiene otra
    -- lista en la mano y cambiarla de este lado no le avisa a nadie.
    if v_estado <> 'borrador' then
      raise exception 'Este pedido ya salio (%). Para cambiarlo, cancelalo y arma uno nuevo.', v_estado;
    end if;

    update public.pedidos_proveedor
       set proveedor_id     = p_proveedor_id,
           fecha_estimada   = p_fecha_estimada,
           gastos_estimados = round(coalesce(p_gastos_estimados, 0), 2),
           nota             = nullif(btrim(coalesce(p_nota, '')), '')
     where id = v_id;

    delete from public.pedido_proveedor_lineas where pedido_id = v_id;
  end if;

  for v_linea in select * from jsonb_array_elements(p_lineas) loop
    if not exists (
      select 1 from public.variantes
       where id = (v_linea->>'variante_id')::uuid and activa
    ) then
      raise exception 'Uno de los productos del pedido no existe o esta desactivado.';
    end if;

    insert into public.pedido_proveedor_lineas
      (pedido_id, variante_id, cantidad, costo_unitario, precio_previsto, precio_competencia)
    values
      (v_id,
       (v_linea->>'variante_id')::uuid,
       (v_linea->>'cantidad')::integer,
       round((v_linea->>'costo_unitario')::numeric, 2),
       round(nullif(v_linea->>'precio_previsto', '')::numeric, 2),
       round(nullif(v_linea->>'precio_competencia', '')::numeric, 2));
  end loop;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Mover el pedido de estado
-- ---------------------------------------------------------------------------
/**
 * borrador -> enviado -> confirmado, y desde cualquiera de esos a cancelado.
 * "Recibido" no esta aca: recibir es otra cosa, porque crea una compra.
 */
create or replace function public.cambiar_estado_pedido_proveedor(
  p_pedido_id uuid,
  p_destino   text,
  p_motivo    text default null
) returns void
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_usuario uuid := auth.uid();
  v_estado  text;
begin
  if not public.tiene_rol(array['dueno','contador']) then
    raise exception 'Los pedidos a proveedores los maneja un dueno o el contador.';
  end if;

  select estado into v_estado from public.pedidos_proveedor where id = p_pedido_id;
  if not found then
    raise exception 'Ese pedido no existe.';
  end if;
  if v_estado in ('recibido','cancelado') then
    raise exception 'Este pedido ya esta cerrado (%).', v_estado;
  end if;

  if p_destino = 'cancelado' then
    if btrim(coalesce(p_motivo, '')) = '' then
      raise exception 'Hay que decir por que se cancela. Un pedido cancelado sin explicacion no se puede discutir despues.';
    end if;
    update public.pedidos_proveedor
       set estado = 'cancelado', cancelado_at = now(),
           cancelado_por = v_usuario, motivo_cancelacion = btrim(p_motivo)
     where id = p_pedido_id;

  elsif p_destino = 'enviado' and v_estado = 'borrador' then
    update public.pedidos_proveedor
       set estado = 'enviado', enviado_at = now()
     where id = p_pedido_id;

  elsif p_destino = 'confirmado' and v_estado = 'enviado' then
    update public.pedidos_proveedor
       set estado = 'confirmado', confirmado_at = now()
     where id = p_pedido_id;

  else
    raise exception 'Un pedido % no puede pasar a %.', v_estado, p_destino;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Recibir: aca el pedido se convierte en compra
-- ---------------------------------------------------------------------------
/**
 * Toma lo que REALMENTE llego (p_lineas, con la cantidad y el costo de verdad),
 * lo pasa por registrar_compra -que es lo unico que mueve stock y deuda- y deja
 * el pedido cerrado apuntando a esa compra.
 *
 * Recibir de menos es normal y no rompe nada: se anota lo que vino. Si no vino
 * nada, no hay compra que hacer y el pedido se cancela, no se recibe.
 */
create or replace function public.recibir_pedido_proveedor(
  p_pedido_id          uuid,
  p_lineas             jsonb,
  p_pagos              jsonb default '[]'::jsonb,
  p_fecha              date default null,
  p_tipo_comprobante   text default 'factura_a',
  p_punto_venta        text default null,
  p_numero_comprobante text default null
) returns uuid
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_pedido public.pedidos_proveedor%rowtype;
  v_compra uuid;
  v_linea  jsonb;
begin
  if not public.tiene_rol(array['dueno','contador']) then
    raise exception 'Recibir un pedido lo hace un dueno o el contador: entra mercaderia y queda una deuda.';
  end if;

  select * into v_pedido from public.pedidos_proveedor where id = p_pedido_id;
  if not found then
    raise exception 'Ese pedido no existe.';
  end if;
  if v_pedido.estado in ('recibido','cancelado') then
    raise exception 'Este pedido ya esta cerrado (%).', v_pedido.estado;
  end if;
  if p_lineas is null or jsonb_array_length(p_lineas) = 0 then
    raise exception 'Si no llego nada, el pedido se cancela: no hay compra que registrar.';
  end if;

  -- La compra se registra con las reglas de siempre: numero correlativo, stock
  -- por el libro mayor, deuda al proveedor, caja si se pago algo en efectivo.
  v_compra := public.registrar_compra(
    v_pedido.sucursal_id,
    v_pedido.proveedor_id,
    p_lineas,
    coalesce(p_pagos, '[]'::jsonb),
    p_fecha,
    p_tipo_comprobante,
    p_punto_venta,
    p_numero_comprobante,
    'Pedido ' || v_pedido.numero
  );

  -- Que llego de cada cosa, para poder mirar despues si este proveedor cumple.
  for v_linea in select * from jsonb_array_elements(p_lineas) loop
    update public.pedido_proveedor_lineas
       set cantidad_recibida = (v_linea->>'cantidad')::integer,
           costo_recibido    = round((v_linea->>'costo_unitario')::numeric, 2)
     where pedido_id   = p_pedido_id
       and variante_id = (v_linea->>'variante_id')::uuid;
  end loop;

  -- Lo que se pidio y no vino queda en cero, no en blanco: "no llego" es un
  -- dato, "todavia no se sabe" es otro.
  update public.pedido_proveedor_lineas
     set cantidad_recibida = 0
   where pedido_id = p_pedido_id and cantidad_recibida is null;

  update public.pedidos_proveedor
     set estado = 'recibido', recibido_at = now(), compra_id = v_compra
   where id = p_pedido_id;

  return v_compra;
end;
$$;

-- ---------------------------------------------------------------------------
-- A cuanto conviene venderlo
-- ---------------------------------------------------------------------------
/**
 * Devuelve un precio sugerido y, sobre todo, de donde salio cada numero. La
 * pantalla muestra las dos cosas: un precio sugerido sin explicacion es un
 * numero que nadie va a usar.
 *
 * Con que cuenta el sistema, de verdad:
 *   - el costo de este pedido, mas el flete prorrateado por unidad;
 *   - el margen con el que se vendio esa misma categoria en los ultimos 6 meses
 *     (precio de venta contra costo congelado en la venta, no contra la lista);
 *   - a que precio estan hoy los productos parecidos del propio catalogo;
 *   - cuanto se vendio de esa categoria en los ultimos 90 dias;
 *   - el precio de la competencia, SI alguien lo cargo a mano.
 *
 * Con que NO cuenta: precios de mercado traidos de internet. No hay una fuente
 * confiable de precios de calzado en Argentina, y un numero inventado con cara
 * de dato es peor que no tener el dato.
 */
create or replace function public.precio_sugerido(
  p_variante_id        uuid,
  p_costo              numeric default null,
  p_gasto_unitario     numeric default 0,
  p_precio_competencia numeric default null
) returns table (
  costo_total        numeric,
  sugerido           numeric,
  piso               numeric,
  margen_categoria   numeric,
  por_margen         numeric,
  referencia         numeric,
  origen_referencia  text,
  precio_actual      numeric,
  unidades_90d       integer,
  base               text
)
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_categoria  uuid;
  v_marca      text;
  v_precio_act numeric(12,2);
  v_costo      numeric(12,2);
  v_total      numeric(12,2);
  v_margen     numeric;
  v_por_margen numeric(12,2);
  v_ref        numeric(12,2);
  v_origen     text;
  v_unidades   integer;
  v_sug        numeric(12,2);
  v_base       text;
begin
  if not public.tiene_rol(array['dueno','contador']) then
    raise exception 'El precio sugerido mira costos: lo ve un dueno o el contador.';
  end if;

  select pr.categoria_id, pr.marca, va.precio, va.costo
    into v_categoria, v_marca, v_precio_act, v_costo
    from public.variantes va
    join public.productos pr on pr.id = va.producto_id
   where va.id = p_variante_id;

  if not found then
    raise exception 'Ese producto no existe.';
  end if;

  -- Si no se dice cuanto sale, se usa el ultimo costo conocido.
  v_costo := round(coalesce(p_costo, v_costo, 0), 2);
  v_total := v_costo + round(coalesce(p_gasto_unitario, 0), 2);

  -- Margen real de la categoria: lo que efectivamente se cobro arriba del costo.
  -- Sale de las ventas, no de la lista de precios: la lista dice lo que se
  -- queria cobrar, la venta dice lo que se cobro.
  select avg((vl.precio_unitario - vl.costo_unitario) / nullif(vl.costo_unitario, 0))
    into v_margen
    from public.venta_lineas vl
    join public.ventas v     on v.id = vl.venta_id and v.anulada_at is null
    join public.variantes va on va.id = vl.variante_id
    join public.productos pr on pr.id = va.producto_id
   where pr.categoria_id = v_categoria
     and vl.costo_unitario > 0
     and v.created_at >= now() - interval '180 days';

  v_por_margen := round(v_total * (1 + coalesce(v_margen, 1.0)), 2);

  -- La referencia de mercado, en orden de que tan confiable es.
  if p_precio_competencia is not null and p_precio_competencia > 0 then
    v_ref := round(p_precio_competencia, 2);
    v_origen := 'competencia';
  else
    select round(avg(va.precio), 2) into v_ref
      from public.variantes va
      join public.productos pr on pr.id = va.producto_id
     where va.activa and va.precio > 0
       and pr.categoria_id = v_categoria
       and v_marca is not null and pr.marca = v_marca
       and va.id <> p_variante_id;

    if v_ref is not null then
      v_origen := 'misma_marca';
    else
      select round(avg(va.precio), 2) into v_ref
        from public.variantes va
        join public.productos pr on pr.id = va.producto_id
       where va.activa and va.precio > 0
         and pr.categoria_id = v_categoria
         and va.id <> p_variante_id;
      v_origen := case when v_ref is null then 'sin_referencia' else 'misma_categoria' end;
    end if;
  end if;

  select coalesce(sum(vl.cantidad), 0)::integer into v_unidades
    from public.venta_lineas vl
    join public.ventas v     on v.id = vl.venta_id and v.anulada_at is null
    join public.variantes va on va.id = vl.variante_id
    join public.productos pr on pr.id = va.producto_id
   where pr.categoria_id = v_categoria
     and v.created_at >= now() - interval '90 days';

  -- El margen manda, pero no puede alejarse tanto del mercado que el par quede
  -- sin vender. Se lo deja moverse un 15% para arriba y para abajo de la
  -- referencia: mas que eso ya es otra decision, y la toma una persona.
  if v_ref is not null then
    v_sug := least(greatest(v_por_margen, round(v_ref * 0.85, 2)), round(v_ref * 1.15, 2));
    v_base := case
                when v_margen is null then 'solo_mercado'
                else 'margen_y_mercado'
              end;
  else
    v_sug := v_por_margen;
    v_base := case when v_margen is null then 'sin_historia' else 'solo_margen' end;
  end if;

  -- Vender al costo no es vender. Un piso duro, pase lo que pase arriba.
  v_sug := greatest(v_sug, round(v_total * 1.15, 2));

  -- Redondeo a la centena: nadie pone un precio de 47.318.
  v_sug := round(v_sug / 100) * 100;

  return query select
    v_total,
    v_sug,
    v_total,
    round(coalesce(v_margen, 0), 4),
    v_por_margen,
    v_ref,
    v_origen,
    v_precio_act,
    v_unidades,
    v_base;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
alter table public.pedidos_proveedor        enable row level security;
alter table public.pedido_proveedor_lineas  enable row level security;

-- Se leen desde cualquier sucursal a proposito: un dueno tiene que poder mirar
-- que le pidio al proveedor el otro local antes de pedir lo mismo.
drop policy if exists pedidos_proveedor_select on public.pedidos_proveedor;
create policy pedidos_proveedor_select on public.pedidos_proveedor
  for select to authenticated using (public.tiene_rol(array['dueno','contador']));

drop policy if exists pedido_proveedor_lineas_select on public.pedido_proveedor_lineas;
create policy pedido_proveedor_lineas_select on public.pedido_proveedor_lineas
  for select to authenticated using (public.tiene_rol(array['dueno','contador']));

-- Escritura, ninguna: la unica puerta son las funciones de arriba. Sin esto se
-- podria marcar un pedido como recibido sin que entre un solo par al deposito.
grant select on public.pedidos_proveedor       to authenticated;
grant select on public.pedido_proveedor_lineas to authenticated;

revoke execute on function public.guardar_pedido_proveedor(uuid, uuid, uuid, jsonb, date, numeric, text) from public, anon;
revoke execute on function public.cambiar_estado_pedido_proveedor(uuid, text, text) from public, anon;
revoke execute on function public.recibir_pedido_proveedor(uuid, jsonb, jsonb, date, text, text, text) from public, anon;
revoke execute on function public.precio_sugerido(uuid, numeric, numeric, numeric) from public, anon;

grant execute on function public.guardar_pedido_proveedor(uuid, uuid, uuid, jsonb, date, numeric, text) to authenticated;
grant execute on function public.cambiar_estado_pedido_proveedor(uuid, text, text) to authenticated;
grant execute on function public.recibir_pedido_proveedor(uuid, jsonb, jsonb, date, text, text, text) to authenticated;
grant execute on function public.precio_sugerido(uuid, numeric, numeric, numeric) to authenticated;
