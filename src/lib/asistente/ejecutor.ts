import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";
import { ACCIONES } from "../../../supabase/functions/asistente/herramientas";
import { prepararCompra, claveBorradores, identidadDocumento, validarRegistroCompra } from "./compra-borrador";
import { analizarCatalogo, leerCatalogoPaginado, type FilaCatalogo } from "./analisis-catalogo";

/**
 * Acá se ejecutan de verdad las herramientas que pide el asistente.
 *
 * La decisión que explica todo este archivo: **el asistente no tiene una puerta
 * propia a la base**. Cada herramienta termina llamando exactamente la misma
 * función (`rpc`) que llama la pantalla correspondiente, desde el navegador de
 * la persona y con su sesión. O sea que hereda su rol y su RLS: si un vendedor
 * no puede dar de alta un proveedor haciendo clic, tampoco puede pidiéndoselo
 * al asistente, porque la base lo rechaza igual.
 *
 * La alternativa habría sido ejecutar del lado del servidor con la clave
 * secreta. Eso convertiría al asistente en un usuario con permisos de dios, y
 * cualquier frase bien armada valdría más que el sistema de roles entero.
 *
 * La otra regla: ninguna herramienta recibe `sucursal_id`. Lo pone este archivo
 * con la sucursal configurada en el equipo. Manda el equipo, no la persona, y
 * mucho menos el asistente.
 */

export type Resultado = { ok: true; datos: unknown } | { ok: false; error: string };

type Entrada = Record<string, unknown>;

/** Las que mueven plata o stock no se ejecutan solas: esperan el Confirmar. */
export function necesitaConfirmacion(nombre: string): boolean {
  return ACCIONES.has(nombre);
}

const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const opcional = (v: unknown) => {
  const t = texto(v);
  return t === "" ? null : t;
};

/** PostgREST corta el `or(...)` en las comas y los paréntesis: se van. */
function paraFiltro(t: string): string {
  return t.replace(/[,()%]/g, " ").trim();
}

function sinAcentos(t: string): string {
  return t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

const SELECT_CATALOGO =
  "id, nombre, marca, activo, " +
  "variantes ( id, talle, color, sku, codigo_barras, precio, costo, activa, stock ( sucursal_id, cantidad ) )";

type VarianteCruda = {
  id: string;
  talle: string | null;
  color: string | null;
  sku: string | null;
  codigo_barras: string | null;
  precio: number;
  costo: number | null;
  activa: boolean;
  stock: { sucursal_id: string; cantidad: number }[];
};

type ProductoCrudo = {
  id: string;
  nombre: string;
  marca: string | null;
  activo: boolean;
  variantes: VarianteCruda[];
};

async function buscarProductos(entrada: Entrada, sucursalId: string): Promise<Resultado> {
  const consulta = texto(entrada.texto);
  const { data, error } = await supa
    .from("productos")
    .select(SELECT_CATALOGO)
    .eq("activo", true)
    .order("nombre");

  if (error) return { ok: false, error: error.message };

  // El filtro se hace acá y no en la base porque la búsqueda tiene que cruzar
  // producto y variante a la vez ("nike 42" es nombre + talle), y eso en
  // PostgREST son dos consultas anidadas que se pisan entre sí.
  const terminos = sinAcentos(consulta).split(/\s+/).filter(Boolean);
  const filas: unknown[] = [];

  for (const p of (data ?? []) as unknown as ProductoCrudo[]) {
    for (const v of p.variantes ?? []) {
      if (!v.activa) continue;
      const pajar = sinAcentos(
        [p.nombre, p.marca, v.talle, v.color, v.sku, v.codigo_barras].filter(Boolean).join(" "),
      );
      if (!terminos.every((t) => pajar.includes(t))) continue;

      filas.push({
        variante_id: v.id,
        producto: p.nombre,
        marca: p.marca,
        talle: v.talle,
        color: v.color,
        sku: v.sku,
        codigo_barras: v.codigo_barras,
        precio: Number(v.precio),
        ultimo_costo: v.costo === null ? null : Number(v.costo),
        stock_aca: v.stock?.find((s) => s.sucursal_id === sucursalId)?.cantidad ?? 0,
      });
    }
  }

  return {
    ok: true,
    datos: {
      encontrados: filas.length,
      // Un tope: si alguien busca "a" no tiene sentido mandarle el catálogo
      // entero al modelo, se paga por token y no sirve para decidir nada.
      variantes: filas.slice(0, 25),
      hay_mas: filas.length > 25,
    },
  };
}

async function buscarClientes(entrada: Entrada): Promise<Resultado> {
  const q = paraFiltro(texto(entrada.texto));
  let consulta = supa
    .from("clientes")
    .select("id, nombre, telefono, documento, email, saldo")
    .eq("activo", true);

  if (q) consulta = consulta.or(`nombre.ilike.%${q}%,documento.ilike.%${q}%,telefono.ilike.%${q}%`);

  const { data, error } = await consulta.order("nombre").limit(20);
  if (error) return { ok: false, error: error.message };
  return { ok: true, datos: { clientes: data ?? [] } };
}

async function buscarProveedores(entrada: Entrada): Promise<Resultado> {
  const q = paraFiltro(texto(entrada.texto));
  let consulta = supa
    .from("proveedores")
    .select("id, nombre, cuit, condicion_iva, telefono, email, saldo")
    .eq("activo", true);

  if (q) consulta = consulta.or(`nombre.ilike.%${q}%,cuit.ilike.%${q}%`);

  const { data, error } = await consulta.order("nombre").limit(20);
  if (error) return { ok: false, error: error.message };
  return { ok: true, datos: { proveedores: data ?? [] } };
}

async function listasDelSistema(): Promise<Resultado> {
  const [medios, categorias] = await Promise.all([
    supa
      .from("medios_pago")
      .select("id, nombre, recargo_porcentaje, es_cuenta_corriente, afecta_caja")
      .eq("activo", true)
      .order("orden"),
    supa.from("categorias_gasto").select("id, nombre").eq("activa", true).order("orden"),
  ]);

  const error = medios.error ?? categorias.error;
  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    datos: { medios_pago: medios.data ?? [], categorias_gasto: categorias.data ?? [] },
  };
}

async function estadoCaja(sucursalId: string): Promise<Resultado> {
  const { data: turno, error } = await supa
    .from("turnos_caja")
    .select("id, numero, monto_apertura, abierto_por, abierto_at")
    .eq("sucursal_id", sucursalId)
    .eq("estado", "abierto")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!turno) {
    return {
      ok: true,
      datos: { abierta: false, aviso: "La caja está cerrada: no se puede cobrar en efectivo." },
    };
  }

  const t = turno as { id: string; numero: number; monto_apertura: number; abierto_por: string; abierto_at: string };
  const [{ data: saldo }, { data: quien }] = await Promise.all([
    supa.rpc("saldo_esperado_caja", { p_turno_id: t.id }),
    supa.from("usuarios").select("nombre").eq("user_id", t.abierto_por).maybeSingle(),
  ]);

  return {
    ok: true,
    datos: {
      abierta: true,
      turno_numero: t.numero,
      abierta_por: (quien as { nombre?: string } | null)?.nombre ?? null,
      abierta_at: t.abierto_at,
      monto_apertura: Number(t.monto_apertura),
      deberia_haber: Number(saldo ?? 0),
    },
  };
}

async function ultimasVentas(entrada: Entrada, sucursalId: string): Promise<Resultado> {
  const pedido = num(entrada.limite) || 15;
  const limite = Math.min(Math.max(Math.round(pedido), 1), 50);

  const { data, error } = await supa
    .from("ventas")
    .select("id, numero, created_at, estado, total, usuario_id")
    .eq("sucursal_id", sucursalId)
    .order("created_at", { ascending: false })
    .limit(limite);

  if (error) return { ok: false, error: error.message };

  const { data: gente } = await supa.from("usuarios").select("user_id, nombre");
  const nombres = Object.fromEntries(
    ((gente ?? []) as { user_id: string; nombre: string }[]).map((u) => [u.user_id, u.nombre]),
  );

  const filas = ((data ?? []) as {
    id: string;
    numero: number;
    created_at: string;
    estado: string;
    total: number;
    usuario_id: string | null;
  }[]).map((v) => ({
    venta_id: v.id,
    numero: v.numero,
    fecha: v.created_at,
    estado: v.estado,
    total: Number(v.total),
    vendio: v.usuario_id ? (nombres[v.usuario_id] ?? null) : null,
  }));

  return { ok: true, datos: { ventas: filas } };
}

/** El `hasta` que escribe una persona incluye ese día entero. */
function diaSiguiente(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function resumenDelPeriodo(entrada: Entrada, sucursalId: string): Promise<Resultado> {
  const desde = texto(entrada.desde);
  const hasta = texto(entrada.hasta);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    return { ok: false, error: "Las fechas tienen que venir como AAAA-MM-DD." };
  }
  const corte = diaSiguiente(hasta);

  const [ventas, gastos, compras, pagos, medios] = await Promise.all([
    supa
      .from("ventas")
      .select("total")
      .eq("sucursal_id", sucursalId)
      .eq("estado", "completada")
      .gte("created_at", desde)
      .lt("created_at", corte),
    supa
      .from("gastos")
      .select("monto")
      .eq("sucursal_id", sucursalId)
      .eq("anulado", false)
      .gte("fecha", desde)
      .lte("fecha", hasta),
    supa
      .from("compras")
      .select("total")
      .eq("sucursal_id", sucursalId)
      .eq("estado", "registrada")
      .gte("fecha", desde)
      .lte("fecha", hasta),
    // Los pagos no tienen sucursal propia: la heredan de la venta. El `!inner`
    // convierte el join en filtro, así no vuelven pagos de la otra sucursal.
    supa
      .from("pagos")
      .select("monto, medio_pago_id, ventas!inner(sucursal_id, estado, created_at)")
      .eq("ventas.sucursal_id", sucursalId)
      .eq("ventas.estado", "completada")
      .gte("ventas.created_at", desde)
      .lt("ventas.created_at", corte),
    supa.from("medios_pago").select("id, nombre"),
  ]);

  const error = ventas.error ?? gastos.error ?? compras.error ?? pagos.error ?? medios.error;
  if (error) return { ok: false, error: error.message };

  const sumar = (filas: unknown[], campo: string) =>
    filas.reduce<number>((a, f) => a + Number((f as Record<string, unknown>)[campo] ?? 0), 0);

  const nombreMedio = Object.fromEntries(
    ((medios.data ?? []) as { id: string; nombre: string }[]).map((m) => [m.id, m.nombre]),
  );
  const porMedio: Record<string, number> = {};
  for (const p of (pagos.data ?? []) as { monto: number; medio_pago_id: string }[]) {
    const clave = nombreMedio[p.medio_pago_id] ?? "otro";
    porMedio[clave] = (porMedio[clave] ?? 0) + Number(p.monto);
  }

  return {
    ok: true,
    datos: {
      desde,
      hasta,
      cantidad_ventas: (ventas.data ?? []).length,
      total_ventas: sumar(ventas.data ?? [], "total"),
      total_gastos: sumar(gastos.data ?? [], "monto"),
      total_compras: sumar(compras.data ?? [], "total"),
      cobrado_por_medio: porMedio,
      aclaracion:
        "Compras y gastos son cosas distintas y no se suman entre sí: la mercadería es compra, lo que se consume es gasto.",
    },
  };
}

// --- Las que mueven plata o stock ------------------------------------------
// Todas pasan antes por la tarjeta de confirmación. Acá ya se da por hecho que
// alguien apretó Confirmar.

function lineasVenta(entrada: Entrada) {
  return (Array.isArray(entrada.lineas) ? entrada.lineas : []).map((l) => {
    const linea = l as Entrada;
    const fila: Record<string, unknown> = {
      variante_id: texto(linea.variante_id),
      cantidad: Math.round(num(linea.cantidad)),
    };
    if (typeof linea.precio_unitario === "number") fila.precio_unitario = num(linea.precio_unitario);
    return fila;
  });
}

function listaPagos(entrada: Entrada) {
  return (Array.isArray(entrada.pagos) ? entrada.pagos : []).map((p) => {
    const pago = p as Entrada;
    return { medio_pago_id: texto(pago.medio_pago_id), monto: num(pago.monto) };
  });
}

async function llamar(fn: string, args: Record<string, unknown>): Promise<Resultado> {
  const { data, error } = await supa.rpc(fn, args);
  if (error) return { ok: false, error: error.message };
  return { ok: true, datos: data ?? { hecho: true } };
}

export async function ejecutarHerramienta(
  nombre: string,
  entrada: Entrada,
  sucursalId: string,
): Promise<Resultado> {
  switch (nombre) {
    case "analizar_catalogo_compra": {
      const consultas = Array.isArray(entrada.renglones) ? entrada.renglones : [];
      if (!consultas.length || consultas.length > 30) return { ok: false, error: "Analizá entre 1 y 30 renglones por vez." };
      try {
        const filas = await leerCatalogoPaginado(async (desde, hasta) => {
          const { data, error } = await supa.from("variantes")
            .select("id, producto_id, talle, color, sku, codigo_barras, activa, productos!inner(nombre, marca, activo)")
            .eq("activa", true).eq("productos.activo", true).order("id").range(desde, hasta);
          return { data: data as unknown as FilaCatalogo[] | null, error };
        });
        return { ok: true, datos: { resultados: consultas.map((l, i) => {
          const v = l && typeof l === "object" ? l as Entrada : {};
          return { renglon: i + 1, ...analizarCatalogo({ codigo: texto(v.codigo), descripcion: texto(v.descripcion),
            talle: texto(v.talle), color: texto(v.color) }, filas) };
        }), aviso: "Solo propuestas; no se crearon productos ni se modificó stock. Los candidatos requieren revisión." } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "No se pudo completar la búsqueda. No des por ausente ningún producto." };
      }
    }
    case "guardar_borrador_compra":
    case "consultar_borradores_compra": {
      try {
        const { data, error } = await supa.auth.getUser();
        if (error || !data.user) return { ok: false, error: "Volvé a iniciar sesión para acceder a tus borradores." };
        const clave = claveBorradores(data.user.id, sucursalId);
        const guardados = JSON.parse(localStorage.getItem(clave) ?? "[]");
        if (!Array.isArray(guardados)) throw new Error("Borradores inválidos");
        if (nombre === "consultar_borradores_compra") return { ok: true, datos: { borradores: guardados, alcance: "Solo este navegador, usuario y sucursal. No son compras registradas." } };
        const revision = prepararCompra(entrada);
        if (revision.borrador.documento !== "compra") return { ok: false, error: "No se guardó como compra: es un documento de venta/cambio o falta clasificarlo." };
        const identidad = identidadDocumento(revision.borrador);
        if (!identidad) return { ok: false, error: "Faltan CUIT, tipo, punto de venta o número para identificar el borrador sin duplicarlo." };
        const anteriores = guardados.filter(b => b.identidad !== identidad);
        if (anteriores.length >= 20) return { ok: false, error: "Ya hay 20 borradores locales. No se sobrescribieron ni borraron los anteriores." };
        const nuevo = { identidad, actualizado: new Date().toISOString(), ...revision };
        localStorage.setItem(clave, JSON.stringify([...anteriores, nuevo]));
        return { ok: true, datos: { ...nuevo, alcance: "Guardado solo en este navegador para este usuario y sucursal. Sin altas de catálogo, stock, pagos ni deuda." } };
      } catch {
        return { ok: false, error: "No se pudo leer o guardar el borrador local. No se registró compra ni stock. Conservá la factura." };
      }
    }
    case "buscar_productos":
      return buscarProductos(entrada, sucursalId);
    case "buscar_clientes":
      return buscarClientes(entrada);
    case "buscar_proveedores":
      return buscarProveedores(entrada);
    case "listas_del_sistema":
      return listasDelSistema();
    case "estado_caja":
      return estadoCaja(sucursalId);
    case "ultimas_ventas":
      return ultimasVentas(entrada, sucursalId);
    case "resumen_del_periodo":
      return resumenDelPeriodo(entrada, sucursalId);

    case "registrar_venta": {
      const res = await llamar("registrar_venta", {
        p_sucursal_id: sucursalId,
        p_lineas: lineasVenta(entrada),
        p_pagos: listaPagos(entrada),
        p_cliente_id: opcional(entrada.cliente_id),
        p_descuento: num(entrada.descuento),
        p_nota: opcional(entrada.nota),
        p_venta_origen_id: null,
      });
      if (!res.ok) return res;
      // Devolver el número de ticket y no el uuid: es lo que le sirve a la
      // persona para buscarla después, y lo que va a repetir el asistente.
      const { data: venta } = await supa
        .from("ventas")
        .select("numero, total")
        .eq("id", res.datos as string)
        .maybeSingle();
      return { ok: true, datos: { venta_id: res.datos, ...(venta ?? {}) } };
    }

    case "registrar_pago_cuenta":
      return llamar("registrar_pago_cuenta", {
        p_cliente_id: texto(entrada.cliente_id),
        p_sucursal_id: sucursalId,
        p_monto: num(entrada.monto),
        p_medio_pago_id: opcional(entrada.medio_pago_id),
        p_nota: opcional(entrada.nota),
      });

    case "registrar_gasto":
      return llamar("registrar_gasto", {
        p_sucursal_id: sucursalId,
        p_categoria_id: texto(entrada.categoria_id),
        p_detalle: texto(entrada.detalle),
        p_monto: num(entrada.monto),
        p_fecha: opcional(entrada.fecha) ?? new Date().toISOString().slice(0, 10),
        p_paga_caja: entrada.paga_caja === true,
      });

    case "registrar_compra": {
      const errorValidacion = validarRegistroCompra(entrada);
      if (errorValidacion) return { ok: false, error: errorValidacion };
      return llamar("registrar_compra_asistida", {
        p_sucursal_id: sucursalId,
        p_documento: entrada,
      });
    }

    case "pagar_proveedor":
      return llamar("pagar_proveedor", {
        p_proveedor_id: texto(entrada.proveedor_id),
        p_sucursal_id: sucursalId,
        p_monto: num(entrada.monto),
        p_medio_pago_id: texto(entrada.medio_pago_id),
        p_nota: opcional(entrada.nota),
      });

    case "crear_cliente": {
      const { data, error } = await supa
        .from("clientes")
        .insert({
          nombre: texto(entrada.nombre),
          telefono: opcional(entrada.telefono),
          email: opcional(entrada.email),
          documento: opcional(entrada.documento),
        })
        .select("id, nombre")
        .single();
      if (error) return { ok: false, error: error.message };
      return { ok: true, datos: data };
    }

    case "crear_proveedor": {
      const { data, error } = await supa
        .from("proveedores")
        .insert({
          nombre: texto(entrada.nombre),
          cuit: opcional(entrada.cuit),
          condicion_iva: opcional(entrada.condicion_iva) ?? "responsable_inscripto",
          telefono: opcional(entrada.telefono),
          email: opcional(entrada.email),
        })
        .select("id, nombre")
        .single();
      if (error) return { ok: false, error: error.message };
      return { ok: true, datos: data };
    }

    case "abrir_caja":
      return llamar("abrir_caja", {
        p_sucursal_id: sucursalId,
        p_monto_apertura: num(entrada.monto_apertura),
      });

    case "cerrar_caja": {
      const { data: turno, error } = await supa
        .from("turnos_caja")
        .select("id")
        .eq("sucursal_id", sucursalId)
        .eq("estado", "abierto")
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!turno) return { ok: false, error: "No hay ninguna caja abierta en esta sucursal." };
      return llamar("cerrar_caja", {
        p_turno_id: (turno as { id: string }).id,
        p_monto_contado: num(entrada.monto_contado),
        p_nota: opcional(entrada.nota) ?? "",
      });
    }

    case "registrar_movimiento_caja":
      return llamar("registrar_movimiento_caja", {
        p_sucursal_id: sucursalId,
        p_tipo: texto(entrada.tipo) === "ingreso" ? "ingreso" : "retiro",
        p_monto: num(entrada.monto),
        p_motivo: texto(entrada.motivo),
      });

    case "anular_venta":
      return llamar("anular_venta", {
        p_venta_id: texto(entrada.venta_id),
        p_motivo: texto(entrada.motivo),
      });

    case "anular_compra":
      return llamar("anular_compra", {
        p_compra_id: texto(entrada.compra_id),
        p_motivo: texto(entrada.motivo),
      });

    case "anular_gasto":
      return llamar("anular_gasto", {
        p_gasto_id: texto(entrada.gasto_id),
        p_motivo: texto(entrada.motivo),
      });

    case "ajustar_cuenta":
      return llamar("ajustar_cuenta", {
        p_cliente_id: texto(entrada.cliente_id),
        p_sucursal_id: sucursalId,
        p_monto: num(entrada.monto),
        p_nota: texto(entrada.nota),
      });

    case "ajustar_saldo_proveedor":
      return llamar("ajustar_saldo_proveedor", {
        p_proveedor_id: texto(entrada.proveedor_id),
        p_sucursal_id: sucursalId,
        p_monto: num(entrada.monto),
        p_motivo: texto(entrada.motivo),
      });

    default:
      // No debería pasar nunca: el catálogo de herramientas lo define el
      // servidor. Si pasa, es un error nuestro y se dice así.
      return { ok: false, error: `El sistema no conoce la herramienta "${nombre}".` };
  }
}

// ---------------------------------------------------------------------------
// La tarjeta de confirmación
// ---------------------------------------------------------------------------
//
// Nada que mueva plata o stock se ejecuta sin que alguien lea antes, en
// castellano y con los montos, qué es exactamente lo que va a pasar.
//
// Y se lee con NOMBRES, no con ids. Un uuid no se puede revisar: si el
// asistente se equivocó de cliente, la única forma de que la persona lo note es
// que la tarjeta diga "Pérez, Juan" y no "3f2a...". Por eso acá se hacen
// consultas extra aunque cuesten un instante: la tarjeta es la última defensa
// antes de que la plata se mueva, y una tarjeta que no se entiende no defiende
// nada.

export type Descripcion = { titulo: string; lineas: string[]; peligro: boolean };

/** Las que no se arreglan con otro movimiento: se muestran distinto. */
const IRREVERSIBLES = new Set([
  "anular_venta",
  "anular_compra",
  "anular_gasto",
  "cerrar_caja",
  "ajustar_cuenta",
  "ajustar_saldo_proveedor",
]);

async function nombreDe(tabla: string, id: unknown): Promise<string> {
  const clave = texto(id);
  if (!clave) return "(sin especificar)";
  const { data } = await supa.from(tabla).select("nombre").eq("id", clave).maybeSingle();
  return (data as { nombre?: string } | null)?.nombre ?? "(no se encontró)";
}

async function detalleLineas(lineas: unknown, conCosto: boolean) {
  const items = Array.isArray(lineas) ? (lineas as Entrada[]) : [];
  const ids = items.map((l) => texto(l.variante_id)).filter(Boolean);
  const { data } = ids.length ? await supa
    .from("variantes")
    .select("id, talle, color, precio, productos ( nombre, marca )")
    .in("id", ids) : { data: [] };

  type Fila = {
    id: string;
    talle: string | null;
    color: string | null;
    precio: number;
    productos: { nombre: string; marca: string | null } | null;
  };
  const porId = new Map(((data ?? []) as unknown as Fila[]).map((v) => [v.id, v]));

  let total = 0;
  const filas = items.map((l) => {
    const v = porId.get(texto(l.variante_id));
    const cantidad = Math.round(num(l.cantidad));
    const unitario = conCosto
      ? num(l.costo_unitario)
      : typeof l.precio_unitario === "number"
        ? num(l.precio_unitario)
        : Number(v?.precio ?? 0);
    total += cantidad * unitario;

    const nueva = l.nueva_variante as Entrada | undefined;
    const que = nueva
      ? `ALTA PROPUESTA: ${texto(nueva.nombre) || "modelo existente"} · ${texto(nueva.marca)} · talle ${texto(nueva.talle)} · ${texto(nueva.color)} · precio de venta ${formatARS(num(nueva.precio_venta))}`
      : v
      ? [v.productos?.nombre, v.productos?.marca, v.talle, v.color].filter(Boolean).join(" · ")
      : "(artículo no encontrado)";
    return `${cantidad} x ${que} a ${formatARS(unitario)} cada uno`;
  });

  return { filas, total };
}

async function detallePagos(pagos: unknown): Promise<string[]> {
  const items = Array.isArray(pagos) ? (pagos as Entrada[]) : [];
  if (items.length === 0) return [];
  const { data } = await supa.from("medios_pago").select("id, nombre");
  const nombres = new Map(
    ((data ?? []) as { id: string; nombre: string }[]).map((m) => [m.id, m.nombre]),
  );
  return items.map(
    (p) =>
      `Paga con ${nombres.get(texto(p.medio_pago_id)) ?? "(medio desconocido)"}: ${formatARS(num(p.monto))}`,
  );
}

export async function describirHerramienta(nombre: string, entrada: Entrada): Promise<Descripcion> {
  const peligro = IRREVERSIBLES.has(nombre);
  const armar = (titulo: string, lineas: string[]): Descripcion => ({ titulo, lineas, peligro });

  switch (nombre) {
    case "guardar_borrador_compra": {
      const r = prepararCompra(entrada);
      return armar("Guardar borrador local, sin ingresar stock", [
        `Proveedor: ${r.borrador.proveedor}`,
        `Comprobante: ${r.borrador.punto_venta}-${r.borrador.numero_comprobante}`,
        `Unidades leídas: ${r.unidades_leidas}`,
        `Total del documento: ${r.borrador.total === null ? "pendiente" : formatARS(r.borrador.total)}`,
        ...r.pendientes,
        "Se guarda en este navegador, separado por usuario y sucursal. No se comparte ni carga al sistema contable.",
        "Si ya hay un borrador del mismo comprobante, se reemplaza con esta revisión.",
      ]);
    }
    case "registrar_venta": {
      const { filas, total } = await detalleLineas(entrada.lineas, false);
      const pagos = await detallePagos(entrada.pagos);
      const descuento = num(entrada.descuento);
      const lineas = [...filas];
      if (descuento > 0) lineas.push(`Descuento: ${formatARS(descuento)}`);
      lineas.push(`Total: ${formatARS(total - descuento)}`);
      lineas.push(...pagos);
      if (entrada.cliente_id) {
        lineas.push(`Cliente: ${await nombreDe("clientes", entrada.cliente_id)}`);
      }
      return armar("Registrar una venta", lineas);
    }

    case "registrar_compra": {
      const { filas, total } = await detalleLineas(entrada.lineas, true);
      const pagos = await detallePagos(entrada.pagos);
      const lineas = [
        `Proveedor: ${await nombreDe("proveedores", entrada.proveedor_id)}`,
        ...filas,
        `Subtotal mercadería: ${formatARS(total)}`,
        `IVA: ${formatARS(num(entrada.iva))}`,
        `Percepciones: ${formatARS(num(entrada.percepciones))}`,
        `Total del documento: ${formatARS(num(entrada.total_documento))}`,
        `Comprobante: ${texto(entrada.tipo_comprobante)} ${texto(entrada.punto_venta)}-${texto(entrada.numero_comprobante)} · ${texto(entrada.fecha)}`,
      ];
      if (pagos.length === 0) {
        lineas.push("No se paga nada ahora: queda todo anotado en la cuenta del proveedor.");
      } else {
        lineas.push(...pagos);
      }
      lineas.push("Esto entra la mercadería al stock de esta sucursal.");
      return armar("Registrar una compra", lineas);
    }

    case "registrar_pago_cuenta":
      return armar("Cobrar lo que debe un cliente", [
        `Cliente: ${await nombreDe("clientes", entrada.cliente_id)}`,
        `Monto: ${formatARS(num(entrada.monto))}`,
        `Cobrado con: ${await nombreDe("medios_pago", entrada.medio_pago_id)}`,
      ]);

    case "pagar_proveedor":
      return armar("Pagarle a un proveedor", [
        `Proveedor: ${await nombreDe("proveedores", entrada.proveedor_id)}`,
        `Monto: ${formatARS(num(entrada.monto))}`,
        `Pagado con: ${await nombreDe("medios_pago", entrada.medio_pago_id)}`,
      ]);

    case "registrar_gasto":
      return armar("Registrar un gasto", [
        `Categoría: ${await nombreDe("categorias_gasto", entrada.categoria_id)}`,
        `Detalle: ${texto(entrada.detalle) || "(sin detalle)"}`,
        `Monto: ${formatARS(num(entrada.monto))}`,
        entrada.paga_caja === true
          ? "Sale de la caja: baja el efectivo del cajón."
          : "No sale de la caja.",
      ]);

    case "crear_cliente":
      return armar("Dar de alta un cliente", [
        `Nombre: ${texto(entrada.nombre)}`,
        `Teléfono: ${texto(entrada.telefono) || "sin dato"}`,
        `Documento: ${texto(entrada.documento) || "sin dato"}`,
      ]);

    case "crear_proveedor":
      return armar("Dar de alta un proveedor", [
        `Nombre: ${texto(entrada.nombre)}`,
        `CUIT: ${texto(entrada.cuit) || "sin dato"}`,
      ]);

    case "abrir_caja":
      return armar("Abrir la caja", [
        `Plata con la que arranca el cajón: ${formatARS(num(entrada.monto_apertura))}`,
      ]);

    case "cerrar_caja":
      return armar("Cerrar la caja", [
        `Plata contada en el cajón: ${formatARS(num(entrada.monto_contado))}`,
        "El turno queda cerrado con la diferencia y tu nombre.",
        "Con la caja cerrada no se puede cobrar en efectivo hasta abrirla de nuevo.",
      ]);

    case "registrar_movimiento_caja":
      return armar(
        texto(entrada.tipo) === "ingreso" ? "Meter plata en la caja" : "Sacar plata de la caja",
        [`Monto: ${formatARS(num(entrada.monto))}`, `Motivo: ${texto(entrada.motivo)}`],
      );

    case "anular_venta":
      return armar("Anular una venta", [
        "La venta queda anulada, vuelve el stock y se revierte lo cobrado.",
        `Motivo: ${texto(entrada.motivo)}`,
        "Esto no se deshace.",
      ]);

    case "anular_compra":
      return armar("Anular una compra", [
        "Sale del stock la mercadería que había entrado y se revierte lo que se le debe al proveedor.",
        `Motivo: ${texto(entrada.motivo)}`,
        "Esto no se deshace.",
      ]);

    case "anular_gasto":
      return armar("Anular un gasto", [
        `Motivo: ${texto(entrada.motivo)}`,
        "Si se había pagado por caja, la plata vuelve al cajón.",
        "Esto no se deshace.",
      ]);

    case "ajustar_cuenta": {
      const monto = num(entrada.monto);
      return armar("Corregir a mano el saldo de un cliente", [
        `Cliente: ${await nombreDe("clientes", entrada.cliente_id)}`,
        monto >= 0
          ? `Le sumamos ${formatARS(monto)} a lo que debe.`
          : `Le bajamos ${formatARS(Math.abs(monto))} de lo que debe.`,
        `Motivo: ${texto(entrada.nota)}`,
        "Queda como un movimiento a la vista, con tu nombre.",
      ]);
    }

    case "ajustar_saldo_proveedor": {
      const monto = num(entrada.monto);
      return armar("Corregir a mano lo que se le debe a un proveedor", [
        `Proveedor: ${await nombreDe("proveedores", entrada.proveedor_id)}`,
        monto >= 0
          ? `Le sumamos ${formatARS(monto)} a la deuda.`
          : `Le bajamos ${formatARS(Math.abs(monto))} de la deuda.`,
        `Motivo: ${texto(entrada.motivo)}`,
        "Queda como un movimiento a la vista, con tu nombre.",
      ]);
    }

    default:
      // Una acción sin descripción propia no se confirma a ciegas: se muestra
      // crudo lo que pidió. Es feo, pero es honesto.
      return armar(`Ejecutar ${nombre}`, [JSON.stringify(entrada)]);
  }
}
