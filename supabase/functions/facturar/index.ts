import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  armarPedido,
  esNotaCredito,
  loQueNoSePuedeTraducir,
  type Comprobante,
  type Linea,
  type Origen,
} from "../_shared/arca.ts";
import { consultar, CUENTA_UNICA, emitir, leerCuenta, probar } from "../_shared/gateway.ts";
import { aplicarResultado } from "../_shared/comprobantes.ts";

/**
 * Le pide el CAE a ARCA por el gateway.
 *
 * Esto es exactamente lo que la migracion de facturacion dejo anotado que
 * faltaba: "el dia que se conecte ARCA, lo unico que cambia es quien llama a
 * registrar_cae". El comprobante se prepara igual que siempre desde la pantalla
 * (`preparar_comprobante`), y esta funcion se ocupa del viaje a ARCA.
 *
 * Vive del lado del servidor y no en el navegador por una sola razon, la misma
 * que ya esta escrita en la funcion del asistente: la clave del gateway no
 * puede llegar al front. Todo lo que empieza con VITE_ es publico, y una clave
 * de facturacion regalada es que cualquiera emita comprobantes con el CUIT del
 * negocio.
 *
 * Tres acciones:
 *   pedir_cae — manda el comprobante preparado y anota el trabajo del gateway
 *   consultar — pregunta si ya salio, y lo cierra con registrar_cae
 *   probar    — dice si la sucursal esta bien configurada, sin emitir nada
 *
 * Para desplegarla:
 *   supabase functions deploy facturar
 *   supabase secrets set ARCA_BASE_URL=https://<tu-gateway-fiscal>/api
 *   supabase secrets set ARCA_API_KEYS='{"mi-slug":"sk_homolog_..."}'
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function responder(cuerpo: unknown, status: number) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const COLUMNAS = `
  id, tipo, punto_venta, fecha, receptor_tipo_documento, receptor_documento,
  receptor_condicion_iva, neto, iva, total, venta_id, comprobante_origen_id,
  sucursal_id, estado, numero, cae, cae_vencimiento, qr_url, observacion,
  job_id, intento, idempotency_key, revision_huella
`;

/** Lo que ve el navegador. Nunca la fila cruda: no necesita el slug ni la clave. */
// deno-lint-ignore no-explicit-any
const paraLaPantalla = (c: any) => ({
  comprobante_id: c.id,
  estado: c.estado,
  tipo: c.tipo,
  punto_venta: c.punto_venta,
  numero: c.numero,
  cae: c.cae,
  cae_vencimiento: c.cae_vencimiento,
  qr_url: c.qr_url,
  observacion: c.observacion,
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return responder({ error: "Método no permitido" }, 405);

  const URL_BASE = Deno.env.get("SUPABASE_URL");
  // Los proyectos viejos traen SUPABASE_SERVICE_ROLE_KEY y los nuevos
  // SUPABASE_SECRET_KEY. Sin el `??` esto falla con un 401 que parece un
  // problema de sesión del usuario y no lo es.
  const CLAVE_SERVICIO =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

  if (!URL_BASE || !CLAVE_SERVICIO) {
    return responder({ error: "El servidor no tiene configurada la clave de servicio. Avisale a Joaquín." }, 500);
  }

  const admin = createClient(URL_BASE, CLAVE_SERVICIO, { auth: { persistSession: false } });

  // --- Quién pide ----------------------------------------------------------
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return responder({ error: "Se cerró la sesión. Volvé a entrar." }, 401);

  // Se pregunta a Auth con un fetch en vez de admin.auth.getUser(token): con las
  // claves nuevas esa función devuelve "Auth session missing" aunque el token
  // venga perfecto. Un GET a /auth/v1/user no tiene esa ambigüedad.
  const rtaAuth = await fetch(`${URL_BASE}/auth/v1/user`, {
    headers: { apikey: CLAVE_SERVICIO, Authorization: `Bearer ${token}` },
  });
  if (!rtaAuth.ok) {
    console.error("facturar: /auth/v1/user", rtaAuth.status);
    return responder({ error: "Se venció tu sesión. Cerrá sesión, volvé a entrar y probá de nuevo." }, 401);
  }
  const authUser = (await rtaAuth.json()) as { id?: string };
  if (!authUser?.id) return responder({ error: "Se cerró la sesión. Volvé a entrar." }, 401);

  const { data: quienPide, error: errQuien } = await admin
    .from("usuarios")
    .select("nombre, rol, activo")
    .eq("user_id", authUser.id)
    .maybeSingle();

  if (errQuien) {
    console.error("facturar: no se pudo leer usuarios", errQuien);
    return responder({ error: "Hubo un problema en el servidor. Avisale a Joaquín." }, 500);
  }
  if (!quienPide) return responder({ error: "Tu usuario no está dado de alta en el sistema." }, 403);
  if (!quienPide.activo) return responder({ error: "Tu usuario está desactivado." }, 403);

  // Los mismos roles que ya exige `registrar_cae` en la base. Se repite acá
  // para cortar antes de salir a la red, no para reemplazarla: la que manda
  // sigue siendo la base.
  if (!["dueno", "vendedor", "contador"].includes(quienPide.rol)) {
    return responder({ error: "No tenés permiso para facturar." }, 403);
  }

  let cuerpo: { accion?: string; comprobante_id?: string; sucursal_id?: string };
  try {
    cuerpo = await req.json();
  } catch {
    return responder({ error: "Cuerpo inválido" }, 400);
  }

  switch (cuerpo.accion) {
    case "pedir_cae":
      if (!["dueno", "contador"].includes(quienPide.rol)) return responder({ error: "Solo dueño o contador autoriza la emisión." }, 403);
      return await accionPedirCae(admin, cuerpo.comprobante_id, authUser.id, cuerpo.sucursal_id);
    case "consultar":
      return await accionConsultar(admin, cuerpo.comprobante_id);
    case "probar":
      return await accionProbar(admin, cuerpo.sucursal_id);
    default:
      return responder({ error: "Acción desconocida." }, 400);
  }
});

// deno-lint-ignore no-explicit-any
type Admin = any;

async function accionPedirCae(admin: Admin, comprobanteId: string | undefined, actorId: string, sucursalId: string | undefined) {
  if (!comprobanteId) return responder({ error: "Falta decir qué comprobante." }, 400);

  const { data: comprobante, error: errLeer } = await admin
    .from("comprobantes")
    .select(COLUMNAS)
    .eq("id", comprobanteId)
    .maybeSingle();

  if (errLeer) {
    console.error("facturar: no se pudo leer el comprobante", errLeer);
    return responder({ error: "Hubo un problema en el servidor. Avisale a Joaquín." }, 500);
  }
  if (!comprobante) return responder({ error: "Ese comprobante no existe." }, 404);
  if (!sucursalId || sucursalId !== comprobante.sucursal_id) return responder({ error: "Elegí la sucursal del comprobante." }, 409);

  if (comprobante.estado === "emitido") {
    return responder({ ...paraLaPantalla(comprobante), aviso: "Ese comprobante ya tiene CAE." }, 200);
  }
  if (!["pendiente", "rechazado"].includes(comprobante.estado)) {
    return responder({ error: `Ese comprobante está ${comprobante.estado}.` }, 409);
  }

  // Ya se pidió y todavía no volvió. Pedirlo de nuevo sería arriesgarse a dos
  // facturas, así que en vez de pedir, se pregunta por el que ya está en camino.
  //
  // Esto no es un detalle: si la pantalla se cansó de esperar (ARCA a veces
  // tarda más de lo que nadie mira) el comprobante queda pendiente, y sin el
  // barrido programado nadie más vuelve a preguntar. Que el mismo botón sirva
  // para traer el resultado es lo que evita que quede colgado para siempre.
  if (comprobante.estado === "pendiente" && comprobante.job_id) {
    return await accionConsultar(admin, comprobanteId);
  }
  if (comprobante.idempotency_key || comprobante.job_id) {
    return responder({ error: "Este envío requiere conciliación con Gateway. No se creará otro pedido." }, 409);
  }

  const { data: sucursal } = await admin
    .from("sucursales")
    .select("nombre, arca_slug")
    .eq("id", comprobante.sucursal_id)
    .maybeSingle();


  const { data: lineas } = await admin
    .from("comprobante_lineas")
    .select("alicuota, neto, iva")
    .eq("comprobante_id", comprobanteId);

  const problemas = loQueNoSePuedeTraducir(comprobante as Comprobante, (lineas ?? []) as Linea[]);
  if (problemas.length > 0) return responder({ error: problemas[0], falta: problemas }, 422);

  // Si es nota de crédito, hay que decirle a ARCA qué comprobante ajusta.
  let origen: Origen | null = null;
  if (esNotaCredito(comprobante.tipo)) {
    const { data: original } = await admin
      .from("comprobantes")
      .select("tipo, punto_venta, numero, estado")
      .eq("id", comprobante.comprobante_origen_id)
      .maybeSingle();

    if (!original?.numero) {
      return responder(
        { error: "El comprobante que se quiere acreditar todavía no tiene número de ARCA." },
        422,
      );
    }
    origen = { tipo: original.tipo, punto_venta: original.punto_venta, numero: original.numero };
  }

  // Si la sucursal no dice a que cuenta factura, se prueba con la unica. Es el
  // caso normal cuando hay un solo CUIT: la clave sola ya identifica al tenant y
  // no hay nada que elegir.
  const cuenta = leerCuenta(sucursal?.arca_slug || CUENTA_UNICA);
  if (!cuenta) {
    // 503 y no 500: no está roto, está sin configurar.
    return responder(
      { error: "Este servidor no tiene cargada la clave del sistema de facturación. El CAE se puede registrar a mano." },
      503,
    );
  }

  // La base reserva una sola vez y verifica la versión revisada bajo bloqueo.
  // Si la respuesta se pierde, la reserva NO se borra ni se cambia su clave.
  const { data: idempotencyKey, error: reservaError } = await admin.rpc("reservar_envio_fiscal", {
    p_id: comprobanteId, p_actor: actorId, p_sucursal_id: sucursalId, p_huella: comprobante.revision_huella,
  });
  if (reservaError || !idempotencyKey) return responder({ error: reservaError?.message ?? "No se pudo reservar el envío." }, 409);

  const pedido = armarPedido(comprobante as Comprobante, (lineas ?? []) as Linea[], origen);
  const rta = await emitir(cuenta, idempotencyKey, pedido);

  if (!rta.ok) {
    return responder({ error: `Envío reservado, resultado por conciliar con Gateway. No vuelvas a emitir. ${rta.mensaje}`, error_code: rta.codigo }, 502);
  }

  if (!rta.datos.job_id || typeof rta.datos.job_id !== "string") return responder({ error: "Gateway no devolvió un identificador. Envío por conciliar; no se repetirá." }, 502);
  const { error: guardarError } = await admin.from("comprobantes").update({ job_id: rta.datos.job_id }).eq("id", comprobanteId);
  if (guardarError) return responder({ error: "Gateway recibió el pedido pero no pudimos guardar la referencia. Requiere conciliación; no vuelvas a emitir." }, 502);

  const { data: actualizado } = await admin
    .from("comprobantes")
    .select(COLUMNAS)
    .eq("id", comprobanteId)
    .maybeSingle();

  return responder(paraLaPantalla(actualizado ?? comprobante), 202);
}

async function accionConsultar(admin: Admin, comprobanteId: string | undefined) {
  if (!comprobanteId) return responder({ error: "Falta decir qué comprobante." }, 400);

  const { data: comprobante } = await admin
    .from("comprobantes")
    .select(COLUMNAS)
    .eq("id", comprobanteId)
    .maybeSingle();

  if (!comprobante) return responder({ error: "Ese comprobante no existe." }, 404);

  // Ya terminó, o nunca se pidió por sistema. En los dos casos no hay a quién
  // preguntarle.
  if (comprobante.estado !== "pendiente" || !comprobante.job_id) {
    return responder(paraLaPantalla(comprobante), 200);
  }

  const { data: sucursal } = await admin
    .from("sucursales")
    .select("arca_slug")
    .eq("id", comprobante.sucursal_id)
    .maybeSingle();

  // Igual que al pedirlo: sin slug se pregunta con la cuenta unica. Si aca se
  // exigiera el slug, el comprobante se pediria bien y nunca se enteraria de
  // que salio: ARCA lo autoriza y la pantalla sigue diciendo que espera.
  const cuenta = leerCuenta(sucursal?.arca_slug || CUENTA_UNICA);
  if (!cuenta) return responder(paraLaPantalla(comprobante), 200);

  const rta = await consultar(cuenta, comprobante.job_id);
  // Que el gateway no conteste ahora no dice nada de la factura: sigue
  // pendiente y se vuelve a preguntar.
  if (!rta.ok) return responder(paraLaPantalla(comprobante), 200);

  await aplicarResultado(admin, comprobanteId, rta.datos);

  const { data: despues } = await admin
    .from("comprobantes")
    .select(COLUMNAS)
    .eq("id", comprobanteId)
    .maybeSingle();

  return responder(paraLaPantalla(despues ?? comprobante), 200);
}

async function accionProbar(admin: Admin, sucursalId: string | undefined) {
  if (!sucursalId) return responder({ error: "Falta decir qué sucursal probar." }, 400);

  const { data: sucursal } = await admin
    .from("sucursales")
    .select("nombre, cuit, condicion_iva, punto_venta, arca_slug")
    .eq("id", sucursalId)
    .maybeSingle();

  if (!sucursal) return responder({ error: "Esa sucursal no existe." }, 404);

  // Primero lo que falta de este lado: no tiene sentido salir a la red para
  // enterarse de que el punto de venta está vacío.
  const falta: string[] = [];
  if (!sucursal.cuit) falta.push("Falta el CUIT.");
  if (!sucursal.condicion_iva) falta.push("Falta la condición frente al IVA.");
  if (!sucursal.punto_venta) falta.push("Falta el punto de venta ante ARCA.");
  if (falta.length > 0) return responder({ ok: false, mensaje: falta.join(" "), falta }, 200);

  const cuenta = leerCuenta(sucursal.arca_slug || CUENTA_UNICA);
  if (!cuenta) {
    return responder(
      { ok: false, mensaje: "Este servidor todavía no tiene cargada la clave del sistema de facturación." },
      200,
    );
  }

  return responder(await probar(cuenta), 200);
}
