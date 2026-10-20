/**
 * El QR que ARCA obliga a imprimir en el comprobante (RG 4892).
 *
 * No es un adorno ni un link nuestro: es un dato con formato fijo que define
 * ARCA. Cualquiera escanea ese QR, cae en la pagina de verificacion de ARCA, y
 * ahi le dice si el comprobante existe y si los importes coinciden. Un
 * comprobante sin QR esta incompleto.
 *
 * Hay dos formas de conseguirlo, y por eso este archivo existe:
 *
 *   1. Cuando el CAE lo trajo el gateway, viene el QR armado en `qr_url` y no
 *      hay nada que calcular. Ese es el camino bueno.
 *   2. Cuando alguien cargo el CAE a mano (desde el sistema del contador), no
 *      hay `qr_url`, porque el que lo cargo copio tres numeros y nada mas. Ahi
 *      hay que armarlo con la especificacion.
 *
 * Sin el caso 2, todo comprobante cargado a mano saldria impreso sin QR, que es
 * justamente el que mas riesgo tiene de salir mal.
 */

/** Nuestras letras en el nomenclador de ARCA, igual que del lado del servidor. */
const TIPO_ARCA: Record<string, number> = {
  A: 1,
  B: 6,
  C: 11,
  NCA: 3,
  NCB: 8,
  NCC: 13,
};

const DOC_ARCA: Record<string, number> = {
  CUIT: 80,
  CUIL: 86,
  PASAPORTE: 94,
  DNI: 96,
  SIN_IDENTIFICAR: 99,
};

export type ParaQr = {
  tipo: string;
  punto_venta: number;
  numero: number | null;
  fecha: string;
  emisor_cuit: string;
  receptor_tipo_documento: string;
  receptor_documento: string | null;
  total: number;
  cae: string | null;
  qr_url: string | null;
};

/**
 * La URL que va adentro del QR.
 *
 * `null` cuando el comprobante todavia no tiene CAE ni numero: no hay nada que
 * verificar, y un QR que lleva a "no existe" es peor que no tener QR.
 */
export function urlDelQr(c: ParaQr): string | null {
  // Si el gateway ya lo armo, se usa ese. Es el mismo que ARCA acepto.
  if (c.qr_url) return c.qr_url;

  if (!c.cae || c.numero === null) return null;

  const tipo = TIPO_ARCA[c.tipo];
  if (!tipo) return null;

  // Los nombres y el orden son los que fija ARCA. Los numeros van como numeros
  // y no como texto: la pagina de verificacion rechaza el string.
  const datos: Record<string, unknown> = {
    ver: 1,
    fecha: c.fecha.slice(0, 10),
    cuit: Number(c.emisor_cuit.replace(/\D/g, "")),
    ptoVta: c.punto_venta,
    tipoCmp: tipo,
    nroCmp: c.numero,
    importe: Number(c.total),
    moneda: "PES",
    ctz: 1,
    tipoDocRec: DOC_ARCA[c.receptor_tipo_documento] ?? 99,
    nroDocRec: Number((c.receptor_documento ?? "0").replace(/\D/g, "")) || 0,
    // "E" es CAE. El otro valor posible es "A", de CAEA, que se usa cuando se
    // factura sin conexion y pidiendo la autorizacion por adelantado. Nosotros
    // siempre pedimos el CAE en el momento.
    tipoCodAut: "E",
    codAut: Number(c.cae),
  };

  // btoa no maneja acentos, pero acá no hay: son todos números y códigos.
  const base64 = btoa(JSON.stringify(datos));
  return `https://www.afip.gob.ar/fe/qr/?p=${base64}`;
}
