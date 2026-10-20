/**
 * Del comprobante que ya preparo la base, al pedido que espera ARCA.
 *
 * Es corto a proposito. Todo lo dificil ya lo resolvio `preparar_comprobante`:
 * que letra corresponde, que datos del emisor y del receptor van adentro, y
 * cuanto es neto y cuanto IVA en cada renglon. Aca no se decide nada de eso, ni
 * se vuelve a calcular: se traduce.
 *
 * Esa division importa. Si este archivo recalculara el IVA, habria dos lugares
 * distintos diciendo cuanto es, y el dia que difieran gana el que ARCA vio.
 */

/** Nuestras letras, en el nomenclador de ARCA. */
const TIPO_ARCA: Record<string, number> = {
  A: 1,
  B: 6,
  C: 11,
  NCA: 3,
  NCB: 8,
  NCC: 13,
};

/** 99 es "no dio documento", que es lo normal en el mostrador. */
const DOC_ARCA: Record<string, number> = {
  CUIT: 80,
  CUIL: 86,
  PASAPORTE: 94,
  DNI: 96,
  SIN_IDENTIFICAR: 99,
};

/** Condicion del receptor frente al IVA (RG 5616, obligatoria desde 2025). */
const IVA_RECEPTOR_ARCA: Record<string, number> = {
  responsable_inscripto: 1,
  exento: 4,
  consumidor_final: 5,
  monotributista: 6,
  // No es una categoria de ARCA; a los efectos del comprobante termina siendo
  // consumidor final, que es lo mismo que ya asume `preparar_comprobante`.
  no_categorizado: 5,
};

/**
 * Alicuotas: el porcentaje que escribe el negocio, y su codigo en ARCA.
 * Si aparece una que no esta aca, el pedido no sale: mandar un codigo
 * inventado es un rechazo asegurado y mucho mas dificil de leer.
 */
const ALICUOTA_ARCA: Record<string, number> = {
  "0": 3,
  "2.5": 9,
  "5": 8,
  "10.5": 4,
  "21": 5,
  "27": 6,
};

export type Comprobante = {
  id: string;
  tipo: string;
  punto_venta: number;
  fecha: string;
  receptor_tipo_documento: string;
  receptor_documento: string | null;
  receptor_condicion_iva: string;
  neto: number;
  iva: number;
  total: number;
  venta_id: string | null;
  comprobante_origen_id: string | null;
};

export type Linea = {
  alicuota: number;
  neto: number;
  iva: number;
};

/** El comprobante que ajusta una nota de credito, ya emitido. */
export type Origen = { tipo: string; punto_venta: number; numero: number };

const redondear = (n: number) => Math.round(n * 100) / 100;

export function esNotaCredito(tipo: string): boolean {
  return tipo.startsWith("NC");
}

/**
 * Lo que no se puede traducir. Devuelve la lista completa y no el primer
 * problema: si hay tres cosas mal, que se vean juntas.
 */
export function loQueNoSePuedeTraducir(comprobante: Comprobante, lineas: Linea[]): string[] {
  const problemas: string[] = [];

  if (!(comprobante.tipo in TIPO_ARCA)) {
    problemas.push(`No sabemos qué comprobante es "${comprobante.tipo}" para ARCA.`);
  }
  for (const linea of lineas) {
    if (!(String(Number(linea.alicuota)) in ALICUOTA_ARCA)) {
      problemas.push(`Hay un renglón con una alícuota de IVA que ARCA no reconoce (${linea.alicuota}%).`);
      break;
    }
  }
  if (Number(comprobante.total) <= 0) {
    problemas.push("El comprobante no tiene importe.");
  }

  return problemas;
}

/**
 * El cuerpo del pedido.
 *
 * La factura C no discrimina IVA: se manda total igual a neto y sin el detalle.
 * El gateway lo descarta igual si va, pero decirlo aca deja claro que no es un
 * olvido.
 */
export function armarPedido(
  comprobante: Comprobante,
  lineas: Linea[],
  origen: Origen | null,
): Record<string, unknown> {
  const letra = comprobante.tipo.replace("NC", "");
  const discrimina = letra !== "C";

  const pedido: Record<string, unknown> = {
    punto_venta: comprobante.punto_venta,
    tipo_comprobante: TIPO_ARCA[comprobante.tipo],
    concepto: 1, // productos: es una zapatilleria, no se venden servicios
    receptor: {
      doc_tipo: DOC_ARCA[comprobante.receptor_tipo_documento] ?? 99,
      doc_nro: comprobante.receptor_documento ?? "0",
      condicion_iva: IVA_RECEPTOR_ARCA[comprobante.receptor_condicion_iva] ?? 5,
    },
    importe_total: redondear(Number(comprobante.total)),
    importe_neto: discrimina
      ? redondear(Number(comprobante.neto))
      : redondear(Number(comprobante.total)),
    fecha: comprobante.fecha,
    metadata: {
      comprobante_id: comprobante.id,
      venta_id: comprobante.venta_id,
      tipo: comprobante.tipo,
    },
  };

  if (discrimina) {
    // Los renglones se agrupan por alicuota porque ARCA quiere un total por
    // alicuota, no uno por producto. El neto y el IVA de cada renglon ya los
    // calculo la base: aca solo se suman.
    const porAlicuota = new Map<number, { base: number; importe: number }>();
    for (const linea of lineas) {
      const clave = Number(linea.alicuota);
      const acumulado = porAlicuota.get(clave) ?? { base: 0, importe: 0 };
      acumulado.base += Number(linea.neto);
      acumulado.importe += Number(linea.iva);
      porAlicuota.set(clave, acumulado);
    }

    const detalle = [...porAlicuota.entries()].map(([alicuota, montos]) => ({
      id: ALICUOTA_ARCA[String(alicuota)],
      base_imp: redondear(montos.base),
      importe: redondear(montos.importe),
    }));

    if (detalle.length > 0) pedido.iva = detalle;
  }

  // Una nota de credito sin decir que ajusta la rechaza ARCA, y con razon:
  // seria plata que vuelve sin decir de donde.
  if (origen) {
    pedido.comprobantes_asociados = [
      {
        tipo: TIPO_ARCA[origen.tipo],
        punto_venta: origen.punto_venta,
        numero: origen.numero,
      },
    ];
  }

  return pedido;
}
