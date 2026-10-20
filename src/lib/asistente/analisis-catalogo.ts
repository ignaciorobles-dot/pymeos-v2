/** Solo propone: ningún parecido de texto autoriza un alta ni un movimiento. */
export type FilaCatalogo = {
  id: string; producto_id: string; talle: string | null; color: string | null;
  sku: string | null; codigo_barras: string | null; activa: boolean;
  productos: { nombre: string; marca: string | null; activo: boolean } | null;
};
export type ConsultaCatalogo = { codigo?: string; descripcion?: string; talle?: string; color?: string };
const normalizar = (v: unknown) => typeof v === "string"
  ? v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() : "";
const codigo = (v: unknown) => typeof v === "string" ? v.trim().toUpperCase() : "";

export function analizarCatalogo(consulta: ConsultaCatalogo, filas: FilaCatalogo[]) {
  const q = normalizar(consulta.descripcion);
  const tokens = [...new Set(q.split(" ").filter(t => t.length > 1))];
  const cod = codigo(consulta.codigo);
  const talle = normalizar(consulta.talle), color = normalizar(consulta.color);
  const candidatos = filas.flatMap(v => {
    if (!v.activa || !v.productos?.activo) return [];
    const nombre = normalizar(v.productos.nombre);
    const texto = new Set(normalizar(`${v.productos.nombre} ${v.productos.marca ?? ""}`).split(" "));
    const exacto = !!cod && [codigo(v.sku), codigo(v.codigo_barras)].includes(cod);
    const coincidentes = tokens.filter(t => texto.has(t)).length;
    const parecido = tokens.length >= 2 && coincidentes >= 2 && coincidentes / tokens.length >= 0.5;
    if (!exacto && !(q && q === nombre) && !parecido) return [];
    const contradicciones: string[] = [];
    if (talle && normalizar(v.talle) !== talle) contradicciones.push("El talle no coincide.");
    if (color && normalizar(v.color) !== color) contradicciones.push("El color no coincide.");
    return [{ variante_id: v.id, producto_id: v.producto_id, nombre: v.productos.nombre,
      marca: v.productos.marca, talle: v.talle, color: v.color, sku: v.sku,
      codigo_barras: v.codigo_barras, coincidencia: exacto ? "codigo_exacto" : "nombre_parecido",
      contradicciones, puntaje: exacto ? 100 : q === nombre ? 90 : Math.round(coincidentes / tokens.length * 70) }];
  }).sort((a, b) => b.puntaje - a.puntaje || a.variante_id.localeCompare(b.variante_id));
  const exactos = candidatos.filter(c => c.coincidencia === "codigo_exacto");
  const sinConflictos = exactos.length === 1 && exactos[0].contradicciones.length === 0;
  return {
    estado: sinConflictos ? "coincidencia_para_confirmar" : candidatos.length ? "revisar_candidatos" : "sin_coincidencias",
    candidatos: candidatos.slice(0, 12), encontrados: candidatos.length, hay_mas: candidatos.length > 12,
    siguiente_paso: sinConflictos
      ? "Confirmar que el código identifica esta variante; el código de un bulto no distribuye talles."
      : candidatos.length ? "Mostrar opciones con modelo, talle y color. No elegir automáticamente ni crear duplicados."
        : "Revisar nombre/modelo/código con el usuario antes de proponer un alta. Ausencia de coincidencia no prueba ausencia del producto.",
    escritura_realizada: false,
  };
}

/** Página plana de variantes: evita truncamiento silencioso del anidado de productos. */
export async function leerCatalogoPaginado(
  pagina: (desde: number, hasta: number) => Promise<{ data: FilaCatalogo[] | null; error: { message: string } | null }>,
) {
  const filas: FilaCatalogo[] = [];
  const vistos = new Set<string>();
  for (let desde = 0; desde < 10000; ) {
    const r = await pagina(desde, desde + 249);
    if (r.error) throw new Error(r.error.message);
    if (!r.data) throw new Error("La consulta no devolvió datos; no se puede afirmar que el catálogo está vacío.");
    if (!r.data.length) return filas;
    for (const fila of r.data) {
      if (vistos.has(fila.id)) throw new Error("El catálogo cambió durante la búsqueda. Volvé a analizarlo antes de crear productos.");
      vistos.add(fila.id); filas.push(fila);
    }
    // Incluso si el servidor impone un límite menor a 250, continuar hasta página vacía.
    desde += r.data.length;
  }
  throw new Error("Catálogo demasiado grande para esta búsqueda. Acotá la consulta; no se confirmó que el producto falte.");
}
