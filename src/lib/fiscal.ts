/**
 * Categorías de ARCA. Están acá y no en una tabla editable a propósito: no las
 * define el negocio, las define ARCA. Si mañana cambian, se cambia acá y en la
 * migración que tiene el mismo CHECK — los dos lados tienen que decir lo mismo.
 *
 * El valor que se guarda es sin acentos ni mayúsculas; lo que se lee en pantalla
 * es el `label`. Nunca guardar el label.
 */
export type CondicionIva =
  | "consumidor_final"
  | "responsable_inscripto"
  | "monotributista"
  | "exento"
  | "no_categorizado";

export type TipoDocumento = "DNI" | "CUIT" | "CUIL" | "PASAPORTE" | "SIN_IDENTIFICAR";

export const CONDICIONES_IVA: { valor: CondicionIva; label: string }[] = [
  { valor: "consumidor_final", label: "Consumidor final" },
  { valor: "responsable_inscripto", label: "Responsable inscripto" },
  { valor: "monotributista", label: "Monotributista" },
  { valor: "exento", label: "Exento" },
  { valor: "no_categorizado", label: "No categorizado" },
];

/**
 * Las que puede tener el que emite, que son menos que las del que recibe: un
 * negocio no factura siendo consumidor final. Espejo del CHECK
 * `sucursales_condicion_iva_valida`.
 */
export const CONDICIONES_EMISOR: { valor: CondicionIva; label: string }[] = CONDICIONES_IVA.filter(
  (c) =>
    c.valor === "responsable_inscripto" || c.valor === "monotributista" || c.valor === "exento",
);

export const TIPOS_DOCUMENTO: { valor: TipoDocumento; label: string }[] = [
  { valor: "DNI", label: "DNI" },
  { valor: "CUIT", label: "CUIT" },
  { valor: "CUIL", label: "CUIL" },
  { valor: "PASAPORTE", label: "Pasaporte" },
  { valor: "SIN_IDENTIFICAR", label: "Sin identificar" },
];

export function labelCondicion(v: string | null | undefined): string {
  return CONDICIONES_IVA.find((c) => c.valor === v)?.label ?? "—";
}

/** Al consumidor final no se le pide nada. Al resto no se le puede facturar sin CUIT. */
export function requiereCuit(condicion: string): boolean {
  return condicion !== "consumidor_final" && condicion !== "no_categorizado";
}

/**
 * Misma regla que el CHECK de la base, escrita en castellano. La base es la que
 * manda; esto existe para que el error salga antes de mandar el insert y se lea
 * como una explicación y no como un mensaje de Postgres.
 */
export function validarFiscal(datos: {
  condicion_iva: string;
  tipo_documento: string;
  documento: string;
}): string | null {
  if (!requiereCuit(datos.condicion_iva)) return null;

  const etiqueta = labelCondicion(datos.condicion_iva).toLowerCase();
  if (datos.tipo_documento !== "CUIT") {
    return `A un ${etiqueta} hay que facturarle con CUIT, no con ${datos.tipo_documento}.`;
  }
  if (!/^\d{11}$/.test(datos.documento.replace(/[-\s.]/g, ""))) {
    return "El CUIT son 11 números, sin guiones.";
  }
  return null;
}

/** Deja el CUIT como lo espera la base: solo números. "20-12345678-9" → "20123456789". */
export function limpiarDocumento(documento: string, tipo: string): string {
  return tipo === "CUIT" || tipo === "CUIL" ? documento.replace(/[-\s.]/g, "") : documento.trim();
}

/**
 * Qué comprobante corresponde. Espejo exacto de `public.tipo_comprobante`: sirve
 * para mostrarlo mientras se carga el cliente, sin ida y vuelta a la base.
 *
 * `null` = la sucursal todavía no tiene cargada su condición ante ARCA. No se
 * adivina: se avisa que falta configurarla.
 */
export function tipoComprobante(
  condicionEmisor: string | null,
  condicionReceptor: string,
): "A" | "B" | "C" | null {
  if (condicionEmisor === "monotributista") return "C";
  if (condicionEmisor === "responsable_inscripto") {
    return condicionReceptor === "responsable_inscripto" ||
      condicionReceptor === "monotributista"
      ? "A"
      : "B";
  }
  return null;
}
