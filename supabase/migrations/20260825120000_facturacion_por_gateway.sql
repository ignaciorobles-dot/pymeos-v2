-- Facturacion: pedirle el CAE a ARCA en vez de tipearlo a mano.
--
-- La migracion de facturacion dejo esto escrito, y es exactamente lo que se
-- viene a hacer:
--
--   "El dia que se conecte ARCA, lo unico que cambia es quien llama a
--    registrar_cae."
--
-- Asi que no se toca el modelo. El comprobante se sigue preparando igual
-- (`preparar_comprobante` decide la letra, copia emisor y receptor, arma los
-- renglones con su IVA), sigue naciendo en 'pendiente', y sigue terminando en
-- 'emitido' por `registrar_cae`. Lo unico que cambia es que ahora el numero y
-- el CAE los trae una Edge Function desde el gateway de ARCA, en vez de
-- copiarlos alguien del sistema del contador.
--
-- El camino manual NO se saca. Si el gateway se cae o ARCA no contesta, el
-- contador tiene que poder cargar el CAE a mano igual que hasta ahora: es la
-- diferencia entre facturar con demora y no facturar.
--
-- Lo que agrega esta migracion:
--   1. Donde anotar a que cuenta del gateway factura cada sucursal.
--   2. Donde anotar el pedido que se le hizo al gateway, para poder preguntar
--      despues por el resultado sin volver a pedirlo.
--   3. Que el servidor pueda cerrar un comprobante, porque el aviso de ARCA
--      llega cuando no hay ninguna persona logueada.


-- 1. A que cuenta del gateway factura cada sucursal ------------------------
--
-- Va en la sucursal y no en una constante porque los dos locales pueden
-- facturar con el mismo CUIT (una sola cuenta, y cada uno manda su punto de
-- venta) o cada uno con el suyo (dos cuentas, dos certificados, dos tramites
-- distintos ante ARCA). Con la columna aca, los dos casos son el mismo codigo.
alter table public.sucursales
  add column if not exists arca_slug text;

-- NO es unico, y eso es lo importante: el caso real de este negocio es un solo
-- CUIT para los dos locales, o sea la misma cuenta repetida en las dos filas,
-- cada una con su punto de venta. Lo que no se puede repetir es el punto de
-- venta, y de eso ya se ocupa `sucursales.punto_venta`, que si es unico.

comment on column public.sucursales.arca_slug is
  'Cuenta de esta sucursal en el gateway de ARCA. Dos locales del mismo CUIT comparten cuenta y se diferencian por el punto de venta. Sin esto, el CAE se carga a mano.';


-- 2. El pedido que se le hizo al gateway -----------------------------------
--
-- El gateway no contesta la factura: contesta un numero de trabajo y sigue
-- hablando con ARCA por atras. El CAE aparece como un minuto despues. Por eso
-- hace falta guardar a que trabajo corresponde este comprobante: si no, no hay
-- forma de preguntar por el resultado, y volver a pedirlo seria arriesgarse a
-- que salgan dos facturas.
alter table public.comprobantes
  add column if not exists job_id text,
  add column if not exists idempotency_key text,
  add column if not exists intento integer not null default 0,
  add column if not exists qr_url text;

comment on column public.comprobantes.job_id is
  'El trabajo del gateway que va a traer el CAE de este comprobante. Null = no se pidio por sistema.';
comment on column public.comprobantes.idempotency_key is
  'Lo que evita que un reintento salga como una segunda factura. La arma el servidor, nunca el navegador.';
comment on column public.comprobantes.intento is
  'Cuantas veces se le pidio al gateway. Sube en cada reintento porque el gateway no reabre un pedido rechazado: hay que pedirlo con una clave nueva.';
comment on column public.comprobantes.qr_url is
  'El QR de verificacion de ARCA que va impreso en el comprobante.';

-- Un trabajo del gateway es de un solo comprobante. Ademas es por donde entra
-- el aviso del webhook, que no conoce nuestros ids.
create unique index if not exists comprobantes_job_id_unico
  on public.comprobantes (job_id)
  where job_id is not null;

-- Una clave de idempotencia se usa una sola vez. Si se repitiera, el gateway
-- devolveria el trabajo viejo y estariamos esperando un CAE que ya se resolvio.
create unique index if not exists comprobantes_idempotency_key_unica
  on public.comprobantes (idempotency_key)
  where idempotency_key is not null;

-- Los que quedaron esperando: es la cola que revisa el barrido cada minuto.
create index if not exists comprobantes_esperando_cae
  on public.comprobantes (created_at)
  where estado = 'pendiente' and job_id is not null;


-- 3. Que el servidor pueda cerrar un comprobante ---------------------------
--
-- `registrar_cae` y `rechazar_comprobante` piden rol de dueno, vendedor o
-- contador. Eso esta bien cuando lo aprieta una persona, pero el resultado de
-- ARCA no llega asi: llega por un aviso del gateway, o lo levanta el barrido
-- un minuto despues. En los dos casos no hay nadie logueado, `auth.uid()` es
-- null, y `tiene_rol` no puede decir que si.
--
-- Se resuelve reconociendo al servidor explicitamente, y no aflojando el
-- control: el resto de la validacion (que el comprobante exista, que este
-- esperando, que el CAE tenga 14 numeros) queda igual, y `anon` sigue sin
-- poder ejecutar nada.
create or replace function public.es_servicio()
returns boolean
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_claims text := current_setting('request.jwt.claims', true);
begin
  -- Dos formas de preguntar lo mismo, porque hay dos formas de conectarse.
  -- Con las claves viejas (JWT) el rol viene en los claims. Con las nuevas
  -- (`sb_secret_...`), que no son JWT, los claims pueden venir vacios y lo que
  -- queda es el rol que PostgREST activo en la conexion. Si se chequeara solo
  -- lo primero, el dia que el proyecto migre de claves el camino automatico
  -- dejaria de andar sin que nadie entienda por que.
  if coalesce(current_setting('role', true), '') = 'service_role' then
    return true;
  end if;

  if v_claims is null or btrim(v_claims) = '' then
    return false;
  end if;
  return (v_claims::jsonb ->> 'role') = 'service_role';
exception when others then
  -- Un claim ilegible no es el servidor. Ante la duda, que no pase.
  return false;
end;
$fn$;

comment on function public.es_servicio() is
  'true cuando quien llama es el servidor (Edge Function con la clave de servicio) y no una persona.';

revoke execute on function public.es_servicio() from public, anon;
grant execute on function public.es_servicio() to authenticated, service_role;


-- Las dos funciones se reescriben enteras porque no se puede cambiar solo el
-- if. El cuerpo es el mismo de la migracion de facturacion: lo unico que cambia
-- es la primera linea de cada una.
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
  if not (public.es_servicio() or public.tiene_rol(array['dueno', 'vendedor', 'contador'])) then
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
  if not (public.es_servicio() or public.tiene_rol(array['dueno', 'vendedor', 'contador'])) then
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


revoke execute on function public.registrar_cae(uuid, bigint, text, date) from public, anon;
revoke execute on function public.rechazar_comprobante(uuid, text)        from public, anon;
grant execute on function public.registrar_cae(uuid, bigint, text, date)  to authenticated, service_role;
grant execute on function public.rechazar_comprobante(uuid, text)         to authenticated, service_role;


-- Lo que la Edge Function necesita para armar el pedido y anotar el resultado.
-- Se da lo minimo: puede leer el comprobante y sus renglones, y anotarle el
-- trabajo del gateway. El CAE no lo escribe con un update: lo escribe llamando
-- a `registrar_cae`, que es donde vive la regla.
grant select on public.comprobantes       to service_role;
grant select on public.comprobante_lineas to service_role;
grant update (job_id, idempotency_key, intento, qr_url) on public.comprobantes to service_role;
