/** Preparación sin efectos contables. null significa desconocido, nunca cero. */
export type VariantePropuesta = {
  variante_id?: string;
  talle: string | null;
  color: string | null;
  cantidad: number | null;
};
export type Renglon = {
  codigo: string;
  descripcion: string;
  unidades: number | null;
  costo_unitario: number | null;
  variantes: VariantePropuesta[];
};
export type CompraBorrador = {
  documento: "compra" | "venta" | "ticket_cambio" | "desconocido";
  proveedor: string;
  cuit: string;
  tipo_comprobante: string;
  punto_venta: string;
  numero_comprobante: string;
  fecha: string;
  total_unidades: number | null;
  subtotal: number | null;
  iva: number | null;
  percepciones: number | null;
  total: number | null;
  lineas: Renglon[];
};

const limpio = (v: unknown) => typeof v === "string" ? v.trim() : "";
const monto = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const entero = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
const objeto = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const centavos = (v: number) => Math.round(v * 100);

export function prepararCompra(entrada: unknown) {
  const e = objeto(entrada);
  const documento = ["compra", "venta", "ticket_cambio"].includes(limpio(e.documento))
    ? e.documento as CompraBorrador["documento"] : "desconocido";
  const lineas: Renglon[] = (Array.isArray(e.lineas) ? e.lineas : []).slice(0, 200).map(item => {
    const l = objeto(item);
    return {
      codigo: limpio(l.codigo), descripcion: limpio(l.descripcion),
      unidades: entero(l.unidades), costo_unitario: monto(l.costo_unitario),
      variantes: (Array.isArray(l.variantes) ? l.variantes : []).slice(0, 200).map(item => {
        const v = objeto(item);
        return { variante_id: limpio(v.variante_id) || undefined,
          talle: limpio(v.talle) || null, color: limpio(v.color) || null,
          cantidad: entero(v.cantidad) };
      }),
    };
  });
  const borrador: CompraBorrador = {
    documento, proveedor: limpio(e.proveedor), cuit: limpio(e.cuit),
    tipo_comprobante: limpio(e.tipo_comprobante), punto_venta: limpio(e.punto_venta),
    numero_comprobante: limpio(e.numero_comprobante), fecha: limpio(e.fecha),
    total_unidades: entero(e.total_unidades), subtotal: monto(e.subtotal), iva: monto(e.iva),
    percepciones: monto(e.percepciones), total: monto(e.total), lineas,
  };
  const pendientes: string[] = [];
  if (documento !== "compra") pendientes.push("Confirmar que es una compra al proveedor: un ticket de venta o cambio no ingresa stock.");
  if (!borrador.proveedor || borrador.cuit.replace(/\D/g, "").length !== 11) pendientes.push("Identificar proveedor y CUIT para buscar duplicados.");
  if (!borrador.tipo_comprobante || !/^\d{1,5}$/.test(borrador.punto_venta) || !/^\d{1,8}$/.test(borrador.numero_comprobante)) pendientes.push("Completar tipo, punto de venta y número de comprobante.");
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(borrador.fecha) ? new Date(`${borrador.fecha}T12:00:00Z`) : null;
  if (!fecha || Number.isNaN(fecha.getTime()) || fecha.toISOString().slice(0, 10) !== borrador.fecha) pendientes.push("Completar una fecha válida del comprobante.");
  if (!lineas.length) pendientes.push("Faltan los renglones de mercadería.");
  let unidades = 0;
  let subtotalCentavos = 0;
  lineas.forEach((l, i) => {
    const etiqueta = `Renglón ${i + 1} (${l.codigo || l.descripcion || "sin identificar"})`;
    if (!l.descripcion) pendientes.push(`${etiqueta}: falta descripción.`);
    if (l.unidades === null) pendientes.push(`${etiqueta}: confirmar unidades, no bultos.`);
    if (l.costo_unitario === null) pendientes.push(`${etiqueta}: falta costo unitario.`);
    unidades += l.unidades ?? 0;
    subtotalCentavos += centavos((l.unidades ?? 0) * (l.costo_unitario ?? 0));
    if (!l.variantes.length) pendientes.push(`${etiqueta}: falta distribución por talle y color; no crear variante genérica.`);
    const combinaciones = new Set<string>();
    let distribuidas = 0;
    l.variantes.forEach(v => {
      if (!v.talle || !v.color || v.cantidad === null) pendientes.push(`${etiqueta}: completar talle, color y cantidad de cada variante.`);
      if (!v.variante_id) pendientes.push(`${etiqueta}: buscar o dar de alta la variante confirmada en el catálogo.`);
      const clave = JSON.stringify([v.talle?.toLowerCase(), v.color?.toLowerCase()]);
      if (combinaciones.has(clave)) pendientes.push(`${etiqueta}: combinación de talle/color repetida.`);
      combinaciones.add(clave);
      distribuidas += v.cantidad ?? 0;
    });
    if (l.variantes.length && distribuidas !== l.unidades) pendientes.push(`${etiqueta}: las variantes suman ${distribuidas}, no ${l.unidades ?? "la cantidad pendiente"}.`);
  });
  if (borrador.total_unidades === null || unidades !== borrador.total_unidades) pendientes.push("Conciliar las unidades totales con los renglones.");
  if (borrador.subtotal === null || centavos(borrador.subtotal) !== subtotalCentavos) pendientes.push("Conciliar el subtotal con cantidades × costos.");
  if ([borrador.subtotal, borrador.iva, borrador.percepciones, borrador.total].some(v => v === null)) {
    pendientes.push("Completar subtotal, IVA, percepciones y total; desconocido no equivale a cero.");
  } else if (centavos(borrador.subtotal!) + centavos(borrador.iva!) + centavos(borrador.percepciones!) !== centavos(borrador.total!)) {
    pendientes.push("El total no coincide con subtotal + IVA + percepciones.");
  }
  const preguntas_usuario = lineas.flatMap((l, i) => {
    const preguntas: string[] = [];
    if (l.unidades === null) preguntas.push("¿Cuántas unidades recibiste, sin contar los bultos como unidades?");
    if (l.costo_unitario === null) preguntas.push("¿Cuál es el costo por unidad de este renglón?");
    if (!l.variantes.length || l.variantes.some(v => !v.talle || !v.color || v.cantidad === null)
      || l.variantes.reduce((n, v) => n + (v.cantidad ?? 0), 0) !== l.unidades) {
      preguntas.push(`¿Cómo se reparten ${l.unidades ?? "las"} unidades por talle y color? Podés escribir: color / talle: cantidad, usando las etiquetas o un conteo.`);
    }
    return preguntas.length ? [{ renglon: i + 1, codigo: l.codigo, descripcion: l.descripcion, preguntas }] : [];
  });
  const tareas_sistema = [
    ...(lineas.some(l => l.variantes.some(v => !v.variante_id)) ? ["Resolver las variantes contra el catálogo; proponer altas solo después de revisar coincidencias."] : []),
    "Verificar comprobante existente antes de confirmar; registrar neto, IVA y percepciones por separado.",
  ];
  return { borrador, pendientes: [...new Set(pendientes)], unidades_leidas: unidades,
    preguntas_usuario, tareas_sistema,
    estado: pendientes.length ? "pendiente" : "listo_para_revision",
    stock_modificado: false, compra_registrada: false };
}

/** El borrador es privado al usuario y sucursal, no una compra ni un permiso. */
export function claveBorradores(usuarioId: string, sucursalId: string) {
  if (!usuarioId || !sucursalId) throw new Error("Falta usuario o sucursal para guardar el borrador.");
  return `pymeos:compras-borrador:v1:${usuarioId}:${sucursalId}`;
}

export function identidadDocumento(b: CompraBorrador) {
  if (!b.cuit || !b.tipo_comprobante || !b.punto_venta || !b.numero_comprobante) return null;
  return [b.cuit.replace(/\D/g, ""), b.tipo_comprobante.toLowerCase(),
    b.punto_venta.replace(/^0+(?=\d)/, ""), b.numero_comprobante.replace(/^0+(?=\d)/, "")].join(":");
}

/** Defensa de ejecución: el prompt no alcanza para proteger importes y unidades. */
export function validarRegistroCompra(entrada: Record<string, unknown>): string | null {
  if (entrada.documento !== "compra") return "Solo una compra confirmada al proveedor puede ingresar stock.";
  const total = monto(entrada.total_documento);
  const iva = monto(entrada.iva);
  const percepciones = monto(entrada.percepciones);
  if (total === null || iva === null || percepciones === null) return "Faltan total del documento, IVA o percepciones. Conservá la compra como borrador.";
  if (!limpio(entrada.proveedor_id) || !/^\d{1,5}$/.test(limpio(entrada.punto_venta)) || !/^\d{1,8}$/.test(limpio(entrada.numero_comprobante))) return "Falta proveedor, punto de venta o número de comprobante.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(limpio(entrada.fecha))) return "Falta fecha del comprobante.";
  if (!Array.isArray(entrada.pagos)) return "Confirmá cómo se paga; [] significa a cuenta corriente.";
  if (!Array.isArray(entrada.lineas) || !entrada.lineas.length) return "Faltan las variantes de la compra.";
  let suma = 0;
  for (const item of entrada.lineas) {
    const l = objeto(item);
    const cantidad = entero(l.cantidad);
    const costo = monto(l.costo_unitario);
    if (cantidad === null || costo === null) return "Cada renglón necesita cantidad entera positiva y costo confirmado.";
    const nueva = objeto(l.nueva_variante);
    if (limpio(l.variante_id) && Object.keys(nueva).length) return "Elegí variante existente o nueva, no ambas.";
    if (!limpio(l.variante_id)) {
      if ((!limpio(nueva.producto_id) && !limpio(nueva.nombre)) || !limpio(nueva.talle) || !limpio(nueva.color) || (monto(nueva.precio_venta) ?? 0) <= 0)
        return "Para el alta faltan modelo, talle, color o precio de venta confirmado. No se inventan.";
    }
    suma += cantidad * centavos(costo);
  }
  if (suma + centavos(iva) + centavos(percepciones) !== centavos(total)) return "Subtotal + IVA + percepciones no coinciden con el total del comprobante. No se registró la compra.";
  let pagado = 0;
  for (const item of entrada.pagos) {
    const p = objeto(item); const importe = monto(p.monto);
    if (!limpio(p.medio_pago_id) || importe === null || importe <= 0) return "Falta medio de pago o importe positivo.";
    pagado += centavos(importe);
  }
  if (pagado > centavos(total)) return "Los pagos superan el total del comprobante.";
  return null;
}
