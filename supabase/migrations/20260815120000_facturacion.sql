-- Facturacion: el registro de comprobantes emitidos.
--
-- Que hace y que no hace, porque es la parte donde equivocarse sale caro:
--
-- Esta migracion NO pide el CAE a ARCA. No hay certificado, no hay web service,
-- y hasta que no lo haya cualquier numero que inventemos seria un comprobante
-- falso. Lo que hace es preparar el comprobante completo (letra, punto de venta,
-- datos del emisor y del receptor, neto e IVA renglon por renglon) y dejarlo
-- esperando. Cuando el sistema del contador devuelve numero, CAE y vencimiento,
-- se registran con `registrar_cae` y recien ahi el comprobante existe.
--
-- Por eso `numero` nace en null y hay un CHECK que impide que un comprobante
-- quede en estado emitido sin numero, sin CAE y sin vencimiento. El dia que se
-- conecte ARCA, lo unico que cambia es quien llama a `registrar_cae`.
--
-- Los datos del emisor y del receptor se copian adentro del comprobante en vez
-- de leerse por join. Un comprobante es una foto de un momento: si el cliente
-- despues cambia de razon social, la factura vieja tiene que seguir diciendo lo
-- que decia. Lo mismo con los renglones.

create table if not exists public.comprobantes (
  id                    uuid primary key default gen_random_uuid(),
  sucursal_id           uuid not null references public.sucursales(id),
  venta_id              uuid references public.ventas(id),
  comprobante_origen_id uuid references public.comprobantes(id),
  cliente_id            uuid references public.clientes(id),

  tipo                  text not null,
  punto_venta           integer not null,
  numero                bigint,
  fecha                 date not null default (now() at time zone 'America/Argentina/Cordoba')::date,

  emisor_nombre         text not null,
  emisor_cuit           text not null,
  emisor_condicion_iva  text not null,
  emisor_direccion      text,

  receptor_nombre          text not null,
  receptor_tipo_documento  text not null default 'SIN_IDENTIFICAR',
  receptor_documento       text,
  receptor_condicion_iva   text not null default 'consumidor_final',
  receptor_direccion       text,

  neto                  numeric(14,2) not null default 0,
  iva                   numeric(14,2) not null default 0,
  total                 numeric(14,2) not null default 0,

  estado                text not null default 'pendiente',
  cae                   text,
  cae_vencimiento       date,
  observacion           text,
  motivo                text,

  usuario_id            uuid references auth.users(id),
  created_at            timestamptz not null default now(),
  emitido_at            timestamptz,

  constraint comprobantes_tipo_valido
    check (tipo in ('A', 'B', 'C', 'NCA', 'NCB', 'NCC')),
  constraint comprobantes_estado_valido
    check (estado in ('pendiente', 'emitido', 'rechazado', 'anulado')),
  constraint comprobantes_punto_venta_positivo
    check (punto_venta > 0),
  constraint comprobantes_emitido_completo
    check (
      estado <> 'emitido'
      or (numero is not null and cae is not null and cae_vencimiento is not null and emitido_at is not null)
    ),
  constraint comprobantes_rechazado_con_motivo
    check (estado <> 'rechazado' or coalesce(btrim(observacion), '') <> ''),
  -- Una nota de credito sin comprobante de origen no es una nota de credito.
  constraint comprobantes_nota_credito_con_origen
    check (tipo not like 'NC%' or comprobante_origen_id is not null)
);

create table if not exists public.comprobante_lineas (
  id              uuid primary key default gen_random_uuid(),
  comprobante_id  uuid not null references public.comprobantes(id) on delete cascade,
  orden           integer not null default 0,
  descripcion     text not null,
  cantidad        numeric(12,2) not null,
  precio_unitario numeric(14,2) not null,
  alicuota        numeric(5,2) not null default 21,
  neto            numeric(14,2) not null,
  iva             numeric(14,2) not null,
  subtotal        numeric(14,2) not null,
  constraint comprobante_lineas_con_descripcion check (coalesce(btrim(descripcion), '') <> ''),
  constraint comprobante_lineas_cantidad_no_cero check (cantidad <> 0)
);

-- Dos comprobantes con el mismo numero en el mismo punto de venta es el error
-- que ARCA no perdona. El indice lo hace imposible.
create unique index if not exists comprobantes_numero_unico
  on public.comprobantes (sucursal_id, tipo, punto_venta, numero)
  where numero is not null;

-- Una venta se factura una sola vez. Los rechazados no cuentan: esos hay que
-- volver a intentarlos.
create unique index if not exists comprobantes_venta_unica
  on public.comprobantes (venta_id)
  where venta_id is not null
    and tipo in ('A', 'B', 'C')
    and estado in ('pendiente', 'emitido');

create index if not exists comprobantes_sucursal_idx on public.comprobantes (sucursal_id, fecha desc, created_at desc);
create index if not exists comprobantes_estado_idx   on public.comprobantes (estado, created_at desc);
create index if not exists comprobantes_cliente_idx  on public.comprobantes (cliente_id);
create index if not exists comprobantes_origen_idx   on public.comprobantes (comprobante_origen_id);
create index if not exists comprobante_lineas_idx    on public.comprobante_lineas (comprobante_id, orden);

alter table public.comprobantes       enable row level security;
alter table public.comprobante_lineas enable row level security;

drop policy if exists comprobantes_select_usuarios_activos on public.comprobantes;
create policy comprobantes_select_usuarios_activos
  on public.comprobantes for select to authenticated
  using (public.mi_rol() is not null);

drop policy if exists comprobante_lineas_select_usuarios_activos on public.comprobante_lineas;
create policy comprobante_lineas_select_usuarios_activos
  on public.comprobante_lineas for select to authenticated
  using (public.mi_rol() is not null);

grant select on public.comprobantes       to authenticated;
grant select on public.comprobante_lineas to authenticated;


-- Prepara el comprobante de una venta y lo deja esperando el CAE.
--
-- La letra no se elige: la decide la combinacion entre lo que es la sucursal
-- ante ARCA y lo que es el cliente. Si la sucursal todavia no tiene cargados
-- CUIT, condicion y punto de venta, no se adivina nada: se avisa que falta.
--
-- Los precios del sistema son finales, con el IVA adentro. Para la A y la B el
-- neto sale de dividir; para la C no hay IVA que discriminar y el neto es el
-- total. El descuento y el recargo de la venta entran como renglones propios
-- para que el total del comprobante de exactamente igual al de la venta.
create or replace function public.preparar_comprobante(p_venta_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_venta        record;
  v_suc          record;
  v_tipo         text;
  v_id           uuid;
  v_rec_nombre   text;
  v_rec_doc_tipo text;
  v_rec_doc      text;
  v_rec_cond     text;
  v_rec_dir      text;
  v_alicuota     numeric(5,2);
begin
  if not public.tiene_rol(array['dueno', 'vendedor']) then
    raise exception 'No tenes permiso para facturar.';
  end if;

  select * into v_venta from public.ventas where id = p_venta_id;
  if v_venta.id is null then
    raise exception 'Esa venta no existe.';
  end if;
  if v_venta.estado <> 'completada' then
    raise exception 'Solo se factura una venta completada. Esta esta %.', v_venta.estado;
  end if;

  if exists (
    select 1 from public.comprobantes c
    where c.venta_id = p_venta_id
      and c.tipo in ('A', 'B', 'C')
      and c.estado in ('pendiente', 'emitido')
  ) then
    raise exception 'Esa venta ya tiene un comprobante. Si quedo mal, hace una nota de credito.';
  end if;

  select * into v_suc from public.sucursales where id = v_venta.sucursal_id;
  if v_suc.cuit is null or v_suc.condicion_iva is null or v_suc.punto_venta is null then
    raise exception 'A la sucursal % le faltan datos fiscales: CUIT, condicion ante ARCA y punto de venta. Cargalos en Configuracion.', v_suc.nombre;
  end if;

  -- Una venta sin cliente es una venta a consumidor final: no falta un dato,
  -- es lo que pasa en el mostrador todo el dia.
  if v_venta.cliente_id is not null then
    select c.nombre, c.tipo_documento, nullif(btrim(coalesce(c.documento, '')), ''),
           c.condicion_iva, c.direccion
      into v_rec_nombre, v_rec_doc_tipo, v_rec_doc, v_rec_cond, v_rec_dir
      from public.clientes c
     where c.id = v_venta.cliente_id;
  end if;

  v_rec_nombre   := coalesce(v_rec_nombre, 'Consumidor final');
  v_rec_doc_tipo := coalesce(v_rec_doc_tipo, 'SIN_IDENTIFICAR');
  v_rec_cond     := coalesce(v_rec_cond, 'consumidor_final');

  v_tipo := public.tipo_comprobante(v_suc.condicion_iva, v_rec_cond);
  if v_tipo is null then
    raise exception 'Con la condicion "%" la sucursal no puede emitir comprobantes.', v_suc.condicion_iva;
  end if;

  -- A un responsable inscripto o a un monotributista se le factura A, y para
  -- eso hace falta el CUIT. Sin eso el comprobante lo rechaza ARCA.
  if v_tipo = 'A' and (v_rec_doc_tipo <> 'CUIT' or v_rec_doc !~ '^\d{11}$') then
    raise exception 'A % hay que facturarle con CUIT de 11 numeros. Completa los datos fiscales del cliente.', v_rec_nombre;
  end if;

  v_alicuota := case when v_tipo = 'C' then 0 else 21 end;

  insert into public.comprobantes (
    sucursal_id, venta_id, cliente_id, tipo, punto_venta,
    emisor_nombre, emisor_cuit, emisor_condicion_iva, emisor_direccion,
    receptor_nombre, receptor_tipo_documento, receptor_documento,
    receptor_condicion_iva, receptor_direccion, usuario_id
  ) values (
    v_venta.sucursal_id, p_venta_id, v_venta.cliente_id, v_tipo, v_suc.punto_venta,
    v_suc.nombre, v_suc.cuit, v_suc.condicion_iva, v_suc.direccion,
    v_rec_nombre, v_rec_doc_tipo, v_rec_doc,
    v_rec_cond, v_rec_dir, auth.uid()
  )
  returning id into v_id;

  insert into public.comprobante_lineas (
    comprobante_id, orden, descripcion, cantidad, precio_unitario, alicuota, neto, iva, subtotal
  )
  select
    v_id,
    row_number() over (order by p.nombre, v.talle, v.color),
    p.nombre
      || case when v.talle is not null then ' talle ' || v.talle else '' end
      || case when v.color is not null then ' ' || v.color else '' end,
    vl.cantidad,
    vl.precio_unitario,
    v_alicuota,
    round(vl.subtotal / (1 + v_alicuota / 100), 2),
    vl.subtotal - round(vl.subtotal / (1 + v_alicuota / 100), 2),
    vl.subtotal
  from public.venta_lineas vl
  join public.variantes v on v.id = vl.variante_id
  join public.productos p on p.id = v.producto_id
  where vl.venta_id = p_venta_id;

  if coalesce(v_venta.descuento, 0) <> 0 then
    insert into public.comprobante_lineas (
      comprobante_id, orden, descripcion, cantidad, precio_unitario, alicuota, neto, iva, subtotal
    ) values (
      v_id, 900, 'Descuento', 1, -v_venta.descuento, v_alicuota,
      -round(v_venta.descuento / (1 + v_alicuota / 100), 2),
      -(v_venta.descuento - round(v_venta.descuento / (1 + v_alicuota / 100), 2)),
      -v_venta.descuento
    );
  end if;

  if coalesce(v_venta.recargo, 0) <> 0 then
    insert into public.comprobante_lineas (
      comprobante_id, orden, descripcion, cantidad, precio_unitario, alicuota, neto, iva, subtotal
    ) values (
      v_id, 901, 'Recargo por forma de pago', 1, v_venta.recargo, v_alicuota,
      round(v_venta.recargo / (1 + v_alicuota / 100), 2),
      v_venta.recargo - round(v_venta.recargo / (1 + v_alicuota / 100), 2),
      v_venta.recargo
    );
  end if;

  update public.comprobantes c
     set neto  = t.neto,
         iva   = t.iva,
         total = t.total
    from (
      select coalesce(sum(neto), 0) as neto,
             coalesce(sum(iva), 0) as iva,
             coalesce(sum(subtotal), 0) as total
        from public.comprobante_lineas where comprobante_id = v_id
    ) t
   where c.id = v_id;

  return v_id;
end;
$fn$;


-- Prepara la nota de credito de un comprobante emitido.
--
-- No borra ni corrige el original: un comprobante emitido no se toca. La nota
-- de credito es un comprobante nuevo, con los mismos renglones, que lo deja sin
-- efecto cuando ella misma consigue su CAE.
create or replace function public.preparar_nota_credito(
  p_comprobante_id uuid,
  p_motivo         text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_orig record;
  v_id   uuid;
begin
  if not public.tiene_rol(array['dueno']) then
    raise exception 'Solo el dueno puede hacer una nota de credito.';
  end if;
  if coalesce(btrim(p_motivo), '') = '' then
    raise exception 'Escribi por que se anula el comprobante.';
  end if;

  select * into v_orig from public.comprobantes where id = p_comprobante_id;
  if v_orig.id is null then
    raise exception 'Ese comprobante no existe.';
  end if;
  if v_orig.estado <> 'emitido' then
    raise exception 'Solo se acredita un comprobante emitido. Este esta %.', v_orig.estado;
  end if;
  if v_orig.tipo like 'NC%' then
    raise exception 'Una nota de credito no se acredita.';
  end if;
  if exists (
    select 1 from public.comprobantes c
    where c.comprobante_origen_id = p_comprobante_id
      and c.estado in ('pendiente', 'emitido')
  ) then
    raise exception 'Ese comprobante ya tiene una nota de credito.';
  end if;

  insert into public.comprobantes (
    sucursal_id, venta_id, comprobante_origen_id, cliente_id, tipo, punto_venta,
    emisor_nombre, emisor_cuit, emisor_condicion_iva, emisor_direccion,
    receptor_nombre, receptor_tipo_documento, receptor_documento,
    receptor_condicion_iva, receptor_direccion,
    neto, iva, total, motivo, usuario_id
  ) values (
    v_orig.sucursal_id, v_orig.venta_id, v_orig.id, v_orig.cliente_id,
    'NC' || v_orig.tipo, v_orig.punto_venta,
    v_orig.emisor_nombre, v_orig.emisor_cuit, v_orig.emisor_condicion_iva, v_orig.emisor_direccion,
    v_orig.receptor_nombre, v_orig.receptor_tipo_documento, v_orig.receptor_documento,
    v_orig.receptor_condicion_iva, v_orig.receptor_direccion,
    v_orig.neto, v_orig.iva, v_orig.total, btrim(p_motivo), auth.uid()
  )
  returning id into v_id;

  insert into public.comprobante_lineas (
    comprobante_id, orden, descripcion, cantidad, precio_unitario, alicuota, neto, iva, subtotal
  )
  select v_id, orden, descripcion, cantidad, precio_unitario, alicuota, neto, iva, subtotal
    from public.comprobante_lineas
   where comprobante_id = p_comprobante_id;

  return v_id;
end;
$fn$;


-- Registra lo que devuelve ARCA. Mientras no haya integracion, lo carga a mano
-- quien factura desde el sistema del contador; el dia que haya web service, la
-- Edge Function llama a esto mismo.
create or replace function public.registrar_cae(
  p_comprobante_id  uuid,
  p_numero          bigint,
  p_cae             text,
  p_cae_vencimiento date
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_c record;
begin
  if not public.tiene_rol(array['dueno', 'vendedor', 'contador']) then
    raise exception 'No tenes permiso para registrar un CAE.';
  end if;

  select * into v_c from public.comprobantes where id = p_comprobante_id;
  if v_c.id is null then
    raise exception 'Ese comprobante no existe.';
  end if;
  if v_c.estado not in ('pendiente', 'rechazado') then
    raise exception 'Ese comprobante ya esta %.', v_c.estado;
  end if;
  if p_numero is null or p_numero <= 0 then
    raise exception 'El numero de comprobante tiene que ser mayor a cero.';
  end if;
  if btrim(coalesce(p_cae, '')) !~ '^\d{14}$' then
    raise exception 'El CAE son 14 numeros, tal cual lo devuelve ARCA.';
  end if;
  if p_cae_vencimiento is null then
    raise exception 'Falta la fecha de vencimiento del CAE.';
  end if;

  update public.comprobantes
     set numero          = p_numero,
         cae             = btrim(p_cae),
         cae_vencimiento = p_cae_vencimiento,
         estado          = 'emitido',
         observacion     = null,
         emitido_at      = now()
   where id = p_comprobante_id;

  -- Una nota de credito recien deja sin efecto al original cuando ella misma
  -- tiene CAE. Antes de eso no vale nada.
  if v_c.tipo like 'NC%' and v_c.comprobante_origen_id is not null then
    update public.comprobantes
       set estado = 'anulado',
           motivo = coalesce(motivo, v_c.motivo)
     where id = v_c.comprobante_origen_id;
  end if;
end;
$fn$;


-- Lo que ARCA rechaza queda registrado con el motivo. No se borra: sirve para
-- saber por que hubo que rehacerlo.
create or replace function public.rechazar_comprobante(
  p_comprobante_id uuid,
  p_motivo         text
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.tiene_rol(array['dueno', 'vendedor', 'contador']) then
    raise exception 'No tenes permiso para tocar los comprobantes.';
  end if;
  if coalesce(btrim(p_motivo), '') = '' then
    raise exception 'Escribi que dijo ARCA.';
  end if;
  if not exists (select 1 from public.comprobantes where id = p_comprobante_id and estado = 'pendiente') then
    raise exception 'Solo se marca como rechazado un comprobante que estaba esperando el CAE.';
  end if;

  update public.comprobantes
     set estado = 'rechazado', observacion = btrim(p_motivo)
   where id = p_comprobante_id;
end;
$fn$;


-- El libro de IVA de un mes, ventas y compras en la misma lista.
--
-- De las compras solo da credito fiscal la factura A: en la B y en la C el IVA
-- viene adentro del precio y no se puede computar. Por eso las otras aparecen
-- con neto igual al total e IVA cero, que es lo que realmente son para el
-- contador.
create or replace function public.libro_iva(
  p_desde       date,
  p_hasta       date,
  p_sucursal_id uuid default null
)
returns table (
  origen      text,
  fecha       date,
  tipo        text,
  comprobante text,
  contraparte text,
  documento   text,
  neto        numeric,
  iva         numeric,
  total       numeric
)
language sql
stable
security definer
set search_path = public
as $fn$
  select
    'venta'::text,
    c.fecha,
    c.tipo,
    lpad(c.punto_venta::text, 5, '0') || '-' || lpad(coalesce(c.numero, 0)::text, 8, '0'),
    c.receptor_nombre,
    c.receptor_documento,
    case when c.tipo like 'NC%' then -c.neto  else c.neto  end,
    case when c.tipo like 'NC%' then -c.iva   else c.iva   end,
    case when c.tipo like 'NC%' then -c.total else c.total end
  from public.comprobantes c
  where public.mi_rol() is not null
    and c.estado in ('emitido', 'anulado')
    and c.fecha between p_desde and p_hasta
    and (p_sucursal_id is null or c.sucursal_id = p_sucursal_id)

  union all

  select
    'compra'::text,
    co.fecha,
    upper(right(co.tipo_comprobante, 1)),
    coalesce(nullif(btrim(co.punto_venta), ''), '-') || '-' || coalesce(nullif(btrim(co.numero_comprobante), ''), '-'),
    pr.nombre,
    pr.cuit,
    case when co.tipo_comprobante = 'factura_a' then round(co.total / 1.21, 2) else co.total end,
    case when co.tipo_comprobante = 'factura_a' then co.total - round(co.total / 1.21, 2) else 0 end,
    co.total
  from public.compras co
  join public.proveedores pr on pr.id = co.proveedor_id
  where public.mi_rol() is not null
    and co.estado = 'registrada'
    and co.tipo_comprobante in ('factura_a', 'factura_b', 'factura_c')
    and co.fecha between p_desde and p_hasta
    and (p_sucursal_id is null or co.sucursal_id = p_sucursal_id)

  order by 2 desc, 4;
$fn$;


revoke execute on function public.preparar_comprobante(uuid)                     from public, anon;
revoke execute on function public.preparar_nota_credito(uuid, text)              from public, anon;
revoke execute on function public.registrar_cae(uuid, bigint, text, date)        from public, anon;
revoke execute on function public.rechazar_comprobante(uuid, text)               from public, anon;
revoke execute on function public.libro_iva(date, date, uuid)                    from public, anon;

grant execute on function public.preparar_comprobante(uuid)                      to authenticated;
grant execute on function public.preparar_nota_credito(uuid, text)               to authenticated;
grant execute on function public.registrar_cae(uuid, bigint, text, date)         to authenticated;
grant execute on function public.rechazar_comprobante(uuid, text)                to authenticated;
grant execute on function public.libro_iva(date, date, uuid)                     to authenticated;
