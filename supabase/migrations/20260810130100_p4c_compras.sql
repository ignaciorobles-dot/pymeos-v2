-- P4c (2 de 2) - Compras de mercaderia.
--
-- Lo que hace una compra, y por que es una sola funcion y no varios inserts:
-- entra mercaderia al stock, se actualiza el costo, se le paga al proveedor o
-- se le queda debiendo, y si se pago en efectivo sale plata del cajon. Si eso
-- se pudiera armar por partes desde el navegador existiria la compra que sumo
-- stock y no quedo guardada, o la que quedo guardada y nunca entro al deposito.
-- Es la misma decision que ya se tomo en registrar_venta.
--
-- Tres cosas que conviene tener escritas antes de leer el codigo:
--
--  * Una compra NO es un gasto. La mercaderia para revender es stock que
--    despues se vende; el alquiler y la luz son gastos. Si la misma factura se
--    anota en los dos lados, el resultado del mes queda restado dos veces. Por
--    eso son dos modulos y no uno.
--
--  * El costo que queda en la variante es el ULTIMO costo pagado, no un
--    promedio. Es lo que el negocio usa para poner precio ("me sale X, lo vendo
--    a Y"), y es lo unico que se puede explicar sin una planilla. Pisar el costo
--    no toca la ganancia de las ventas viejas: venta_lineas.costo_unitario
--    quedo congelado al vender, justamente para esto.
--
--  * La sucursal de la compra es la sucursal en la que esta trabajando el
--    equipo. Manda el equipo, no la persona. La mercaderia entra al deposito
--    donde se esta parado.

create table if not exists public.compras (
  id                 uuid primary key default gen_random_uuid(),
  numero             bigint not null,
  sucursal_id        uuid not null references public.sucursales(id),
  proveedor_id       uuid not null references public.proveedores(id),
  usuario_id         uuid not null references public.usuarios(user_id),
  fecha              date not null default current_date,

  -- Datos del comprobante que emitio el proveedor. Son de el, no nuestros.
  tipo_comprobante   text not null default 'factura_a',
  punto_venta        text,
  numero_comprobante text,

  total              numeric(12,2) not null default 0,
  estado             text not null default 'registrada' check (estado in ('registrada','anulada')),
  nota               text,
  created_at         timestamptz not null default now(),
  anulada_at         timestamptz,
  anulada_por        uuid references public.usuarios(user_id),
  motivo_anulacion   text,

  constraint compras_numero_por_sucursal unique (sucursal_id, numero),
  constraint compras_tipo_comprobante_valido check (
    tipo_comprobante in ('factura_a','factura_b','factura_c','remito','ticket','otro')
  ),
  constraint compras_anulacion_completa check (
    (estado = 'registrada' and anulada_at is null and anulada_por is null)
    or (estado = 'anulada' and anulada_at is not null and anulada_por is not null)
  )
);

comment on table public.compras is
  'Ingreso de mercaderia. Una compra nunca se borra: se anula, y la anulacion saca el stock que habia entrado y revierte la deuda.';
comment on column public.compras.numero is
  'Correlativo interno por sucursal, para poder nombrar la compra. No tiene nada que ver con el numero de la factura del proveedor.';
comment on column public.compras.tipo_comprobante is
  'Lo que entrego el proveedor. Todavia no decide nada fiscal: cuando se integre el sistema de facturacion, este es el campo que va a mirar.';

-- La misma factura del mismo proveedor no se carga dos veces. Es el error mas
-- caro de este modulo: duplica stock y duplica deuda de una sola vez.
--
-- El coalesce del punto de venta no es decorativo: sin el, dos facturas sin
-- punto de venta cargado no chocarian nunca, porque en Postgres dos NULL no son
-- iguales entre si.
create unique index if not exists compras_comprobante_unico
  on public.compras (proveedor_id, tipo_comprobante, coalesce(lower(btrim(punto_venta)), ''), lower(btrim(numero_comprobante)))
  where estado <> 'anulada' and numero_comprobante is not null;

create index if not exists compras_por_sucursal_fecha
  on public.compras (sucursal_id, fecha desc);
create index if not exists compras_por_proveedor
  on public.compras (proveedor_id, fecha desc);

create table if not exists public.compra_lineas (
  id             uuid primary key default gen_random_uuid(),
  compra_id      uuid not null references public.compras(id) on delete cascade,
  variante_id    uuid not null references public.variantes(id),
  cantidad       integer not null check (cantidad > 0),
  costo_unitario numeric(12,2) not null check (costo_unitario >= 0),
  subtotal       numeric(12,2) generated always as (cantidad * costo_unitario) stored
);

comment on table public.compra_lineas is
  'Apunta a una variante, nunca a un producto: hay que saber que talle entra al deposito.';
comment on column public.compra_lineas.cantidad is
  'Siempre positiva. Devolverle mercaderia a un proveedor es una nota de credito, no una compra en negativo; cuando exista, va aparte.';

create index if not exists compra_lineas_compra_idx on public.compra_lineas (compra_id);
create index if not exists compra_lineas_variante_idx on public.compra_lineas (variante_id);

-- Ahora que existe la tabla, el libro mayor del proveedor puede apuntarle.
alter table public.movimientos_proveedor
  drop constraint if exists movimientos_proveedor_compra_fk;
alter table public.movimientos_proveedor
  add constraint movimientos_proveedor_compra_fk
  foreign key (compra_id) references public.compras(id);

-- ---------------------------------------------------------------------------
-- Registrar
-- ---------------------------------------------------------------------------
/**
 * Unica forma de crear una compra. Entra el stock, se actualiza el costo, se
 * paga o se debe, y sale la plata del cajon si se pago en efectivo. Todo en una
 * transaccion.
 *
 * p_lineas: [{ "variante_id": uuid, "cantidad": int, "costo_unitario": num }]
 * p_pagos:  [{ "medio_pago_id": uuid, "monto": num }]
 *
 * Los pagos pueden sumar menos que el total: lo que falta queda como deuda con
 * el proveedor. Es lo normal en este rubro: se recibe la mercaderia y se paga
 * a 30 dias.
 */
create or replace function public.registrar_compra(
  p_sucursal_id        uuid,
  p_proveedor_id       uuid,
  p_lineas             jsonb,
  p_pagos              jsonb default '[]'::jsonb,
  p_fecha              date default null,
  p_tipo_comprobante   text default 'factura_a',
  p_punto_venta        text default null,
  p_numero_comprobante text default null,
  p_nota               text default null
) returns uuid
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_usuario    uuid := auth.uid();
  v_compra_id  uuid;
  v_numero     bigint;
  v_fecha      date := coalesce(p_fecha, current_date);
  v_total      numeric(12,2) := 0;
  v_pagado     numeric(12,2) := 0;
  v_efectivo   numeric(12,2) := 0;
  v_linea      jsonb;
  v_pago       jsonb;
  v_variante   uuid;
  v_cantidad   integer;
  v_costo      numeric(12,2);
  v_medio      public.medios_pago%rowtype;
  v_monto      numeric(12,2);
  v_proveedor  public.proveedores%rowtype;
  v_turno      uuid;
begin
  if public.mi_rol() is null then
    raise exception 'Necesitas un usuario activo para registrar una compra.';
  end if;
  if not exists (select 1 from public.sucursales where id = p_sucursal_id and activa) then
    raise exception 'La sucursal no existe o esta desactivada. Elegi en que sucursal esta trabajando este equipo, en Configuracion.';
  end if;

  select * into v_proveedor from public.proveedores where id = p_proveedor_id and activo;
  if not found then
    raise exception 'Ese proveedor no existe o esta desactivado.';
  end if;

  if p_lineas is null or jsonb_array_length(p_lineas) = 0 then
    raise exception 'Una compra sin mercaderia no es una compra.';
  end if;
  if v_fecha > current_date then
    raise exception 'La fecha de la compra no puede ser posterior a hoy.';
  end if;

  -- Mismo lock que el numero de ticket: dos personas cargando compras a la vez
  -- en el mismo local no pueden sacar el mismo numero.
  perform pg_advisory_xact_lock(hashtext('compra:' || p_sucursal_id::text));
  select coalesce(max(numero), 0) + 1 into v_numero
    from public.compras where sucursal_id = p_sucursal_id;

  insert into public.compras
    (numero, sucursal_id, proveedor_id, usuario_id, fecha,
     tipo_comprobante, punto_venta, numero_comprobante, total, nota)
  values
    (v_numero, p_sucursal_id, p_proveedor_id, v_usuario, v_fecha,
     coalesce(p_tipo_comprobante, 'factura_a'),
     nullif(btrim(coalesce(p_punto_venta, '')), ''),
     nullif(btrim(coalesce(p_numero_comprobante, '')), ''),
     0,
     nullif(btrim(coalesce(p_nota, '')), ''))
  returning id into v_compra_id;

  for v_linea in select * from jsonb_array_elements(p_lineas) loop
    v_variante := (v_linea->>'variante_id')::uuid;
    v_cantidad := (v_linea->>'cantidad')::integer;
    v_costo    := round((v_linea->>'costo_unitario')::numeric, 2);

    if v_cantidad is null or v_cantidad <= 0 then
      raise exception 'La cantidad de cada linea tiene que ser mayor a cero.';
    end if;
    if v_costo is null or v_costo < 0 then
      raise exception 'El costo unitario no puede ser negativo.';
    end if;
    if not exists (select 1 from public.variantes where id = v_variante and activa) then
      raise exception 'Uno de los productos de la compra no existe o esta desactivado.';
    end if;

    insert into public.compra_lineas (compra_id, variante_id, cantidad, costo_unitario)
    values (v_compra_id, v_variante, v_cantidad, v_costo);

    v_total := v_total + (v_cantidad * v_costo);

    -- El stock se mueve por el libro mayor. La tabla stock no se escribe nunca.
    insert into public.movimientos_stock
      (variante_id, sucursal_id, cantidad, motivo, referencia_id, usuario_id)
    values
      (v_variante, p_sucursal_id, v_cantidad, 'compra', v_compra_id, v_usuario);

    -- Ultimo costo pagado. Ver la nota del encabezado: no toca el pasado.
    update public.variantes set costo = v_costo where id = v_variante;
  end loop;

  -- La compra entera entra como deuda, y despues los pagos la bajan. Se podria
  -- anotar solo lo que quedo debiendo, pero entonces una compra pagada al
  -- contado no dejaria rastro en la cuenta del proveedor y no habria forma de
  -- contestar "cuanto le compramos a este tipo el ano pasado".
  insert into public.movimientos_proveedor
    (proveedor_id, sucursal_id, tipo, monto, compra_id, usuario_id, nota)
  values
    (p_proveedor_id, p_sucursal_id, 'compra', v_total, v_compra_id, v_usuario,
     'Compra ' || v_numero);

  for v_pago in select * from jsonb_array_elements(coalesce(p_pagos, '[]'::jsonb)) loop
    select * into v_medio from public.medios_pago
      where id = (v_pago->>'medio_pago_id')::uuid and activo;
    if not found then
      raise exception 'Ese medio de pago no existe o esta desactivado.';
    end if;
    -- "Cuenta corriente" no es una forma de pagar: es no pagar. Lo que no se
    -- paga ya queda como deuda solo, al final.
    if v_medio.es_cuenta_corriente then
      raise exception 'No hace falta elegir cuenta corriente: lo que no se paga queda como deuda con el proveedor.';
    end if;

    v_monto := round((v_pago->>'monto')::numeric, 2);
    if v_monto is null or v_monto <= 0 then
      raise exception 'Un pago de cero no es un pago.';
    end if;

    insert into public.movimientos_proveedor
      (proveedor_id, sucursal_id, tipo, monto, compra_id, medio_pago_id, usuario_id, nota)
    values
      (p_proveedor_id, p_sucursal_id, 'pago', -v_monto, v_compra_id, v_medio.id, v_usuario,
       'Compra ' || v_numero);

    v_pagado := v_pagado + v_monto;
    if v_medio.afecta_caja then
      v_efectivo := v_efectivo + v_monto;
    end if;
  end loop;

  if v_pagado > v_total then
    raise exception 'Los pagos suman % y la compra es de %. No se puede pagar de mas.', v_pagado, v_total;
  end if;

  -- Lo que queda debiendo es v_total - v_pagado, y sale solo de restar las
  -- filas de arriba. No se anota aparte: dos formas de calcular la misma deuda
  -- terminan dando numeros distintos.

  -- La plata que salio del cajon sale por donde sale todo lo demas.
  if v_efectivo > 0 then
    if not public.tiene_rol(array['dueno']) then
      raise exception 'Pagar una compra en efectivo lo tiene que registrar un dueno. Si no, cargala como deuda y que la pague el.';
    end if;
    if v_fecha <> current_date then
      raise exception 'Una compra pagada en efectivo tiene que ser de hoy: la plata sale del cajon de hoy.';
    end if;

    v_turno := public.turno_abierto_id(p_sucursal_id);
    if v_turno is null then
      raise exception 'La caja de esta sucursal esta cerrada. Abrila antes de pagar una compra en efectivo.';
    end if;
    if public.saldo_esperado_caja(v_turno) - v_efectivo < 0 then
      raise exception 'No hay esa plata en la caja.';
    end if;

    insert into public.movimientos_caja
      (turno_id, sucursal_id, tipo, monto, motivo, usuario_id, referencia_id)
    values
      (v_turno, p_sucursal_id, 'retiro', -v_efectivo,
       'Compra ' || v_numero || ' - ' || v_proveedor.nombre, v_usuario, v_compra_id);
  end if;

  update public.compras set total = v_total where id = v_compra_id;

  return v_compra_id;
end;
$$;

comment on function public.registrar_compra is
  'Unica forma de crear una compra. Entra el stock, actualiza el costo, paga o debe, y toca la caja si se pago en efectivo.';

-- ---------------------------------------------------------------------------
-- Anular
-- ---------------------------------------------------------------------------
/**
 * Anula una compra. No borra nada: saca del stock lo que habia entrado con
 * movimientos nuevos, revierte cada movimiento de la cuenta del proveedor con
 * su contrario, y devuelve al cajon la plata que habia salido.
 *
 * Lo que NO revierte: el costo de la variante. Si el costo cambio despues por
 * otra compra, pisarlo con el anterior seria peor que dejarlo. Se corrige
 * cargando la compra buena.
 */
create or replace function public.anular_compra(p_compra_id uuid, p_motivo text)
returns void
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_usuario  uuid := auth.uid();
  c          public.compras%rowtype;
  v_linea    public.compra_lineas%rowtype;
  v_neto     numeric(12,2);
  v_efectivo numeric(12,2);
  v_turno    uuid;
  v_faltante integer;
begin
  if not public.tiene_rol(array['dueno']) then
    raise exception 'Solo un dueno puede anular una compra.';
  end if;
  if btrim(coalesce(p_motivo, '')) = '' then
    raise exception 'Hay que decir por que se anula.';
  end if;

  select * into c from public.compras where id = p_compra_id;
  if not found then
    raise exception 'Esa compra no existe.';
  end if;
  if c.estado = 'anulada' then
    raise exception 'Esa compra ya estaba anulada.';
  end if;

  -- Si la mercaderia ya se vendio, sacarla del stock lo deja en negativo y el
  -- deposito pasa a mentir. Mejor frenar y que se corrija con un ajuste.
  select count(*) into v_faltante
    from public.compra_lineas l
    join public.stock s
      on s.variante_id = l.variante_id and s.sucursal_id = c.sucursal_id
   where l.compra_id = p_compra_id and s.cantidad < l.cantidad;
  if v_faltante > 0 then
    raise exception 'No se puede anular: parte de esa mercaderia ya no esta en el deposito. Corregi el stock con un ajuste y explica que paso.';
  end if;

  for v_linea in select * from public.compra_lineas where compra_id = p_compra_id loop
    insert into public.movimientos_stock
      (variante_id, sucursal_id, cantidad, motivo, referencia_id, usuario_id, nota)
    values
      (v_linea.variante_id, c.sucursal_id, -v_linea.cantidad, 'ajuste', c.id, v_usuario,
       'Anulacion de compra ' || c.numero || ': ' || btrim(p_motivo));
  end loop;

  -- Todo lo que esta compra le hizo a la cuenta del proveedor, al reves.
  select coalesce(sum(monto), 0) into v_neto
    from public.movimientos_proveedor where compra_id = p_compra_id;
  if v_neto <> 0 then
    insert into public.movimientos_proveedor
      (proveedor_id, sucursal_id, tipo, monto, compra_id, usuario_id, nota)
    values
      (c.proveedor_id, c.sucursal_id, 'anulacion', -v_neto, c.id, v_usuario,
       'Anulacion de compra ' || c.numero || ': ' || btrim(p_motivo));
  end if;

  -- Y la plata que habia salido del cajon vuelve. La caja cuenta las dos
  -- veces, que es como tiene que quedar: salio y volvio.
  select coalesce(sum(-monto), 0) into v_efectivo
    from public.movimientos_caja where referencia_id = p_compra_id and tipo = 'retiro';
  if v_efectivo > 0 then
    v_turno := public.turno_abierto_id(c.sucursal_id);
    if v_turno is null then
      raise exception 'La plata tiene que volver al cajon y la caja esta cerrada. Abrila y anula despues.';
    end if;
    insert into public.movimientos_caja
      (turno_id, sucursal_id, tipo, monto, motivo, usuario_id, referencia_id)
    values
      (v_turno, c.sucursal_id, 'ingreso', v_efectivo,
       'Anulacion de compra ' || c.numero || ': ' || btrim(p_motivo), v_usuario, c.id);
  end if;

  update public.compras
     set estado = 'anulada',
         anulada_at = now(),
         anulada_por = v_usuario,
         motivo_anulacion = btrim(p_motivo)
   where id = p_compra_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
alter table public.compras       enable row level security;
alter table public.compra_lineas enable row level security;

drop policy if exists compras_select_usuarios_activos on public.compras;
create policy compras_select_usuarios_activos on public.compras
  for select to authenticated using (public.mi_rol() is not null);

drop policy if exists compra_lineas_select_usuarios_activos on public.compra_lineas;
create policy compra_lineas_select_usuarios_activos on public.compra_lineas
  for select to authenticated using (public.mi_rol() is not null);

-- Se leen y nada mas. La unica puerta son las dos funciones de arriba: un
-- insert suelto en compras se saltearia el stock, la deuda y la caja de una vez.
grant select on public.compras, public.compra_lineas to authenticated;

revoke execute on function public.registrar_compra(uuid, uuid, jsonb, jsonb, date, text, text, text, text) from public, anon;
revoke execute on function public.anular_compra(uuid, text) from public, anon;
grant execute on function public.registrar_compra(uuid, uuid, jsonb, jsonb, date, text, text, text, text) to authenticated;
grant execute on function public.anular_compra(uuid, text) to authenticated;
