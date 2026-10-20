-- Autorizado por el usuario: backend local. NO aplicar sin prueba de staging.
-- Una sola transacción: catálogo + compra + impuestos + pagos. Sin emisión fiscal.
alter table public.compras add column if not exists subtotal_mercaderia numeric(12,2);
alter table public.compras add column if not exists iva_compra numeric(12,2) not null default 0;
alter table public.compras add column if not exists percepciones_compra numeric(12,2) not null default 0;
alter table public.compras add column if not exists asistente_solicitud jsonb;
alter table public.compras add constraint compras_impuestos_no_negativos
  check (iva_compra >= 0 and percepciones_compra >= 0);

create or replace function public.normalizar_numero_compra(v text)
returns text language sql immutable strict set search_path = '' as $$
  select case when btrim(v) ~ '^[0-9]+$'
    then coalesce(nullif(ltrim(btrim(v), '0'), ''), '0') else lower(btrim(v)) end
$$;
revoke all on function public.normalizar_numero_compra(text) from public, anon;
grant execute on function public.normalizar_numero_compra(text) to authenticated;

-- Si existen duplicados históricos, esta creación falla y requiere conciliación:
-- nunca se borran compras ni se fusionan saldos durante la migración.
create unique index compras_comprobante_canonico
on public.compras(proveedor_id, tipo_comprobante,
  coalesce(public.normalizar_numero_compra(punto_venta), ''),
  public.normalizar_numero_compra(numero_comprobante))
where estado <> 'anulada' and numero_comprobante is not null;

create or replace function public.registrar_compra_asistida(p_sucursal_id uuid, p_documento jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  u uuid := auth.uid();
  rol text := public.mi_rol();
  d jsonb := p_documento;
  proveedor public.proveedores%rowtype;
  previa public.compras%rowtype;
  l jsonb; nuevo jsonb; pago jsonb; medio public.medios_pago%rowtype;
  producto uuid; variante uuid; existentes uuid[]; item public.variantes%rowtype;
  lineas jsonb := '[]'::jsonb;
  cantidad integer; costo numeric; precio numeric;
  subtotal numeric := 0; iva numeric; percepciones numeric; total numeric;
  pagado numeric := 0; efectivo numeric := 0; importe numeric;
  compra uuid; turno uuid; numero bigint;
  pv text; comprobante text; tipo text; fecha date;
  campo text; nombre text; marca text; talle text; color text;
begin
  if u is null or rol is null then raise exception 'Necesitás un usuario activo.'; end if;
  if not exists(select 1 from public.sucursales where id = p_sucursal_id and activa) then
    raise exception 'Falta una sucursal operativa activa.';
  end if;
  if jsonb_typeof(d) is distinct from 'object' or d->>'documento' is distinct from 'compra' then
    raise exception 'Solo una compra a proveedor puede ingresar stock.';
  end if;
  tipo := d->>'tipo_comprobante'; pv := d->>'punto_venta'; comprobante := d->>'numero_comprobante';
  if tipo is null or tipo not in ('factura_a','factura_b','factura_c','remito','ticket','otro')
     or pv is null or pv !~ '^[0-9]{1,5}$' or comprobante is null or comprobante !~ '^[0-9]{1,8}$' then
    raise exception 'Faltan tipo, punto de venta y número válidos del proveedor.';
  end if;
  pv := public.normalizar_numero_compra(pv); comprobante := public.normalizar_numero_compra(comprobante);
  d := jsonb_set(jsonb_set(d, '{punto_venta}', to_jsonb(pv)), '{numero_comprobante}', to_jsonb(comprobante));
  if coalesce(d->>'fecha','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Falta fecha válida.'; end if;
  fecha := (d->>'fecha')::date;
  if fecha > current_date then raise exception 'La fecha no puede ser futura.'; end if;
  select * into proveedor from public.proveedores where id = (d->>'proveedor_id')::uuid and activo;
  if not found then raise exception 'Proveedor inexistente o inactivo; buscá o creá el proveedor primero.'; end if;
  if proveedor.cuit is null then raise exception 'Falta CUIT del proveedor para detectar duplicados.'; end if;
  if (select count(*) from public.proveedores where cuit = proveedor.cuit) > 1 then
    raise exception 'Hay proveedores con el mismo CUIT. Revisalos antes de registrar la compra.';
  end if;
  -- Orden de locks: factura, catálogo, turno, compra/sucursal (RPC existente).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('factura-compra:' || proveedor.cuit || ':' || tipo || ':' || pv || ':' || comprobante, 0));
  select * into previa from public.compras
   where proveedor_id = proveedor.id and tipo_comprobante = tipo
     and public.normalizar_numero_compra(punto_venta) = pv
     and public.normalizar_numero_compra(numero_comprobante) = comprobante
   order by created_at desc limit 1 for update;
  if found then
    if previa.estado = 'anulada' then raise exception 'La factura ya existe anulada; requiere revisión manual.'; end if;
    if previa.sucursal_id <> p_sucursal_id or previa.asistente_solicitud is distinct from d then
      raise exception 'La factura ya está registrada con otros datos. No se repitió stock ni pagos.';
    end if;
    return jsonb_build_object('compra_id', previa.id, 'numero', previa.numero, 'total', previa.total,
      'ya_registrada', true, 'stock_duplicado', false);
  end if;
  foreach campo in array array['total_documento','iva','percepciones'] loop
    if coalesce(d->>campo,'') !~ '^[0-9]+(\.[0-9]{1,2})?$' then
      raise exception 'Importe inválido o desconocido: %.', campo;
    end if;
  end loop;
  total := (d->>'total_documento')::numeric; iva := (d->>'iva')::numeric; percepciones := (d->>'percepciones')::numeric;
  if total <= 0 or total > 9999999999.99 then raise exception 'Total fuera de rango.'; end if;
  if jsonb_typeof(d->'lineas') is distinct from 'array' or jsonb_array_length(d->'lineas') not between 1 and 200 then
    raise exception 'Se necesitan entre 1 y 200 variantes.';
  end if;
  if jsonb_typeof(d->'pagos') is distinct from 'array' then raise exception 'Confirmá pagos; [] significa todo a cuenta.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('catalogo-compra-asistida', 0));
  for l in select value from jsonb_array_elements(d->'lineas') loop
    if coalesce(l->>'cantidad','') !~ '^[1-9][0-9]*$' or coalesce(l->>'costo_unitario','') !~ '^[0-9]+(\.[0-9]{1,2})?$' then
      raise exception 'Falta cantidad entera positiva o costo confirmado por variante.';
    end if;
    cantidad := (l->>'cantidad')::integer; costo := (l->>'costo_unitario')::numeric;
    if cantidad > 1000000 or costo > 9999999999.99 then raise exception 'Cantidad o costo fuera de rango.'; end if;
    if nullif(l->>'variante_id','') is not null then
      if l ? 'nueva_variante' and l->'nueva_variante' <> 'null'::jsonb then raise exception 'Elegí variante existente o nueva, no ambas.'; end if;
      variante := (l->>'variante_id')::uuid;
      if not exists(select 1 from public.variantes v join public.productos p on p.id=v.producto_id
        where v.id=variante and v.activa and p.activo) then raise exception 'Variante inexistente o inactiva.'; end if;
    else
      if rol <> 'dueno' then raise exception 'Solo un dueño puede crear productos o variantes.'; end if;
      nuevo := l->'nueva_variante';
      if jsonb_typeof(nuevo) is distinct from 'object' then raise exception 'Falta la variante del renglón.'; end if;
      talle := nullif(btrim(nuevo->>'talle'),''); color := nullif(btrim(nuevo->>'color'),'');
      if talle is null or color is null then raise exception 'Faltan talle/color; no se inventan variantes genéricas.'; end if;
      if coalesce(nuevo->>'precio_venta','') !~ '^[0-9]+(\.[0-9]{1,2})?$' then raise exception 'Falta precio de venta confirmado.'; end if;
      precio := (nuevo->>'precio_venta')::numeric;
      if precio <= 0 or precio > 9999999999.99 then raise exception 'Precio de venta inválido.'; end if;
      if nullif(nuevo->>'producto_id','') is not null then
        producto := (nuevo->>'producto_id')::uuid;
        if not exists(select 1 from public.productos where id=producto and activo) then raise exception 'Modelo inexistente o inactivo.'; end if;
      else
        nombre := nullif(btrim(nuevo->>'nombre'),''); marca := nullif(btrim(nuevo->>'marca'),'');
        if nombre is null then raise exception 'Falta nombre del modelo.'; end if;
        select array_agg(id) into existentes from public.productos
          where lower(btrim(public.productos.nombre))=lower(nombre)
            and lower(btrim(coalesce(public.productos.marca,'')))=lower(coalesce(marca,''));
        if coalesce(cardinality(existentes),0)>1 then raise exception 'Hay modelos homónimos; elegí producto_id.'; end if;
        producto := existentes[1];
        if producto is null then
          insert into public.productos(nombre,marca) values(nombre,marca) returning id into producto;
        elsif not exists(select 1 from public.productos where id=producto and activo) then
          raise exception 'El modelo existe inactivo; no se duplicó.';
        end if;
      end if;
      select array_agg(id) into existentes from public.variantes where producto_id=producto
        and lower(btrim(coalesce(public.variantes.talle,'')))=lower(talle)
        and lower(btrim(coalesce(public.variantes.color,'')))=lower(color);
      if coalesce(cardinality(existentes),0)>1 then raise exception 'Variantes ambiguas; elegí una variante_id.'; end if;
      variante := existentes[1];
      if variante is null then
        insert into public.variantes(producto_id,talle,color,sku,codigo_barras,precio,costo)
          values(producto,talle,color,nullif(btrim(nuevo->>'sku'),''),nullif(btrim(nuevo->>'codigo_barras'),''),precio,costo)
          returning id into variante;
      else
        select * into item from public.variantes where id=variante;
        if not item.activa or item.precio <> precio
          or (nullif(nuevo->>'sku','') is not null and item.sku is distinct from nuevo->>'sku')
          or (nullif(nuevo->>'codigo_barras','') is not null and item.codigo_barras is distinct from nuevo->>'codigo_barras') then
          raise exception 'La variante ya existe con otros datos; revisala sin sobrescribirla.';
        end if;
      end if;
    end if;
    if exists(select 1 from jsonb_array_elements(lineas) x where x->>'variante_id'=variante::text) then
      raise exception 'La misma variante figura dos veces; consolidá cantidades antes de confirmar.';
    end if;
    subtotal := subtotal + cantidad*costo;
    lineas := lineas || jsonb_build_array(jsonb_build_object('variante_id',variante,'cantidad',cantidad,'costo_unitario',costo));
  end loop;
  if subtotal <= 0 or subtotal+iva+percepciones <> total then raise exception 'El subtotal, IVA y percepciones no coinciden con el total.'; end if;
  for pago in select value from jsonb_array_elements(d->'pagos') loop
    if coalesce(pago->>'monto','') !~ '^[0-9]+(\.[0-9]{1,2})?$' then raise exception 'Pago inválido.'; end if;
    importe := (pago->>'monto')::numeric;
    select * into medio from public.medios_pago where id=(pago->>'medio_pago_id')::uuid and activo;
    if not found or medio.es_cuenta_corriente or importe <= 0 then raise exception 'Medio o importe de pago inválido.'; end if;
    pagado := pagado+importe;
    if medio.afecta_caja then efectivo := efectivo+importe; end if;
  end loop;
  if pagado>total then raise exception 'No se puede pagar más que el total.'; end if;
  if efectivo>0 then
    if rol <> 'dueno' or fecha<>current_date then raise exception 'El efectivo requiere dueño y fecha de hoy.'; end if;
    select id into turno from public.turnos_caja where sucursal_id=p_sucursal_id and estado='abierto' for update;
    if turno is null then raise exception 'La caja está cerrada.'; end if;
    if public.saldo_esperado_caja(turno)<efectivo then raise exception 'No hay suficiente efectivo.'; end if;
  end if;
  -- Reutiliza el motor de stock y saldo existente. Sus errores revierten también las altas.
  compra := public.registrar_compra(p_sucursal_id,proveedor.id,lineas,'[]'::jsonb,fecha,tipo,pv,comprobante,d->>'nota');
  update public.compras set subtotal_mercaderia=subtotal,iva_compra=iva,percepciones_compra=percepciones,
    total=total,asistente_solicitud=d where id=compra returning compras.numero into numero;
  if iva+percepciones>0 then
    insert into public.movimientos_proveedor(proveedor_id,sucursal_id,tipo,monto,compra_id,usuario_id,nota)
      values(proveedor.id,p_sucursal_id,'compra',iva+percepciones,compra,u,'IVA y percepciones de compra '||numero);
  end if;
  for pago in select value from jsonb_array_elements(d->'pagos') loop
    insert into public.movimientos_proveedor(proveedor_id,sucursal_id,tipo,monto,compra_id,medio_pago_id,usuario_id,nota)
      values(proveedor.id,p_sucursal_id,'pago',-(pago->>'monto')::numeric,compra,(pago->>'medio_pago_id')::uuid,u,'Compra '||numero);
  end loop;
  if efectivo>0 then
    insert into public.movimientos_caja(turno_id,sucursal_id,tipo,monto,motivo,usuario_id,referencia_id)
      values(turno,p_sucursal_id,'retiro',-efectivo,'Compra '||numero||' - '||proveedor.nombre,u,compra);
  end if;
  return jsonb_build_object('compra_id',compra,'numero',numero,'subtotal',subtotal,'iva',iva,
    'percepciones',percepciones,'total',total,'pagado',pagado,'pendiente',total-pagado,
    'ya_registrada',false,'variantes',lineas);
end;
$$;
revoke all on function public.registrar_compra_asistida(uuid,jsonb) from public,anon;
grant execute on function public.registrar_compra_asistida(uuid,jsonb) to authenticated;
