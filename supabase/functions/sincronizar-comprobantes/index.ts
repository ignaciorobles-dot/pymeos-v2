import { createClient } from "jsr:@supabase/supabase-js@2";
import { consultar, CUENTA_UNICA, leerCuenta } from "../_shared/gateway.ts";
import { aplicarResultado } from "../_shared/comprobantes.ts";

/**
 * El barrido: cierra los comprobantes que quedaron esperando.
 *
 * Por qué existe, si ya está el webhook y la pantalla preguntando: porque un
 * local no es una app web donde alguien mira la pantalla hasta que carga. El
 * cajero cobra, aprieta facturar, y se da vuelta a atender al que sigue. Si en
 * ese minuto se pierde el aviso del gateway, ese comprobante se queda en
 * "pendiente" para siempre y nadie se entera hasta que lo pide el contador.
 *
 * Esto corre cada minuto y pregunta por los que llevan más de uno esperando.
 * No emite nada: solo pregunta y guarda lo que ya decidió ARCA.
 *
 * Para desplegarla:
 *   supabase functions deploy sincronizar-comprobantes --no-verify-jwt
 *   supabase secrets set CRON_SECRET=...
 *
 * Y programarla cada minuto desde Cron en el panel de Supabase, mandando el
 * header x-cron-secret.
 */

/** De a poco: si hay cien colgados, se cierran en varias vueltas y no en una que se corta por tiempo. */
const POR_VUELTA = 25;

/** Menos de un minuto no tiene sentido preguntar: el gateway todavía ni lo miró. */
const ESPERA_MINIMA_MS = 60_000;

function responder(cuerpo: unknown, status: number) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const URL_BASE = Deno.env.get("SUPABASE_URL");
  const CLAVE_SERVICIO =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  const SECRETO = Deno.env.get("CRON_SECRET");

  if (!URL_BASE || !CLAVE_SERVICIO) return responder({ error: "Sin configurar" }, 500);
  if (!SECRETO) {
    console.error("sincronizar-comprobantes: falta CRON_SECRET");
    return responder({ error: "Sin configurar" }, 503);
  }

  // Mismo criterio que el `x-worker-secret` con el que el gateway protege su
  // propio worker: esta función se despliega sin sesión, así que el secreto es
  // lo único que la separa de internet.
  if (req.headers.get("x-cron-secret") !== SECRETO) {
    return responder({ error: "No autorizado" }, 401);
  }

  const admin = createClient(URL_BASE, CLAVE_SERVICIO, { auth: { persistSession: false } });

  const desde = new Date(Date.now() - ESPERA_MINIMA_MS).toISOString();
  // El slug vive en la sucursal, no en el comprobante: un comprobante sabe de
  // qué local es, y el local sabe con qué cuenta factura.
  const { data: pendientes, error } = await admin
    .from("comprobantes")
    .select("id, job_id, sucursales ( arca_slug )")
    .eq("estado", "pendiente")
    .not("job_id", "is", null)
    .lt("created_at", desde)
    .order("created_at", { ascending: true })
    .limit(POR_VUELTA);

  if (error) {
    console.error("sincronizar-comprobantes: no se pudo leer la cola", error);
    return responder({ error: "No se pudo leer la cola" }, 500);
  }

  let emitidos = 0;
  let rechazados = 0;

  for (const fila of pendientes ?? []) {
    // deno-lint-ignore no-explicit-any
    const slug = (fila as any).sucursales?.arca_slug as string | undefined;
    // Sin slug, la cuenta unica: es con la que se pidio.
    const cuenta = leerCuenta(slug || CUENTA_UNICA);
    if (!cuenta) continue;

    const rta = await consultar(cuenta, fila.job_id!);
    // Que el gateway no conteste ahora no dice nada de la factura. Queda
    // pendiente y se vuelve a intentar en la próxima vuelta.
    if (!rta.ok) continue;

    const cierre = await aplicarResultado(admin, fila.id, rta.datos);
    if (cierre === "emitido") emitidos++;
    if (cierre === "rechazado") rechazados++;
  }

  return responder({ revisados: pendientes?.length ?? 0, emitidos, rechazados }, 200);
});
