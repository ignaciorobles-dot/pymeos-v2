-- Condición frente al IVA y tipo de documento del cliente.
--
-- Por qué acá y no en una tabla de listas como categorías o colores: esta lista
-- no la inventa el negocio, la fija ARCA. Si el dueño pudiera agregar "monotributo
-- social" o borrar "exento", el sistema empezaría a emitir comprobantes contra
-- categorías que no existen. Por eso va como CHECK: se cambia con una migración,
-- que es exactamente lo que hay que hacer cuando ARCA cambia algo.
--
-- Los valores se guardan sin acentos ni mayúsculas para no depender de la
-- intercalación de la base; el texto lindo lo pone la pantalla.

alter table public.clientes
  add column if not exists condicion_iva text not null default 'consumidor_final',
  add column if not exists tipo_documento text not null default 'DNI';

-- El default es consumidor final a propósito: es lo que es el 95% de quien entra
-- al local, y hace que todo lo ya cargado quede en un estado válido y verdadero.

alter table public.clientes
  drop constraint if exists clientes_condicion_iva_valida;
alter table public.clientes
  add constraint clientes_condicion_iva_valida check (
    condicion_iva in (
      'consumidor_final',
      'responsable_inscripto',
      'monotributista',
      'exento',
      'no_categorizado'
    )
  );

alter table public.clientes
  drop constraint if exists clientes_tipo_documento_valido;
alter table public.clientes
  add constraint clientes_tipo_documento_valido check (
    tipo_documento in ('DNI', 'CUIT', 'CUIL', 'PASAPORTE', 'SIN_IDENTIFICAR')
  );

-- Un responsable inscripto o un monotributista sin CUIT no se puede facturar.
-- Frenarlo en la carga es mucho más barato que descubrirlo cuando el comprobante
-- se rechaza. Al consumidor final no se le exige nada: es el caso del mostrador.
alter table public.clientes
  drop constraint if exists clientes_cuit_obligatorio_si_factura;
alter table public.clientes
  add constraint clientes_cuit_obligatorio_si_factura check (
    condicion_iva in ('consumidor_final', 'no_categorizado')
    or (tipo_documento = 'CUIT' and documento is not null and documento ~ '^[0-9]{11}$')
  );

comment on column public.clientes.condicion_iva is
  'Categoría del cliente ante ARCA. Decide qué tipo de comprobante le corresponde.';
comment on column public.clientes.tipo_documento is
  'Qué documento es el de la columna documento. CUIT obligatorio si se le factura.';

-- Índice para la pantalla de facturación: "todos los responsables inscriptos"
-- es la consulta que se hace al cierre del mes.
create index if not exists clientes_por_condicion_iva
  on public.clientes (condicion_iva)
  where activo;

-- La sucursal también tiene condición frente al IVA (es la que emite). Hoy está
-- vacía en las dos, pero cuando se cargue tiene que hablar el mismo idioma que
-- la del cliente: si una dice 'responsable_inscripto' y la otra "Responsable
-- Inscripto", la comparación de abajo falla en silencio y sale la factura mal.
alter table public.sucursales
  drop constraint if exists sucursales_condicion_iva_valida;
alter table public.sucursales
  add constraint sucursales_condicion_iva_valida check (
    condicion_iva is null
    or condicion_iva in ('responsable_inscripto', 'monotributista', 'exento')
  );

/**
 * Qué comprobante le toca a cada cliente.
 *
 * La regla no depende solo del cliente: depende también de quién emite. Un
 * monotributista emite siempre C, sin importar a quién le venda. Un responsable
 * inscripto emite A cuando el que compra también discrimina IVA (RI o
 * monotributista) y B cuando no (consumidor final, exento).
 *
 * Devuelve null cuando la sucursal todavía no tiene cargada su condición: es
 * preferible que la pantalla diga "falta configurar" antes que inventar una A.
 *
 * IMMUTABLE porque para los mismos dos textos siempre da lo mismo; así se puede
 * usar en un select sin costo.
 */
create or replace function public.tipo_comprobante(
  p_condicion_emisor text,
  p_condicion_receptor text
) returns text
language sql
immutable
as $$
  select case
    when p_condicion_emisor is null then null
    when p_condicion_emisor = 'monotributista' then 'C'
    when p_condicion_emisor = 'responsable_inscripto' then
      case
        when p_condicion_receptor in ('responsable_inscripto', 'monotributista') then 'A'
        else 'B'
      end
    else null
  end;
$$;

revoke execute on function public.tipo_comprobante(text, text) from public;
grant execute on function public.tipo_comprobante(text, text) to authenticated, service_role;
