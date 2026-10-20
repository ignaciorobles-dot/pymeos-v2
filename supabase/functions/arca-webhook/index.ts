import { createClient } from "jsr:@supabase/supabase-js@2";
import { aplicarResultado } from "../_shared/comprobantes.ts";

/**
 * Por acá avisa el gateway cuando ARCA le contestó.
 *
 * Sin esto igual funciona todo: la pantalla pregunta cada tres segundos y el
 * barrido cierra los que quedaron colgados. Esto solo lo hace instantáneo, y el
 * gateway avisa una sola vez y no insiste, así que nunca puede ser el único
 * camino. El estado del trabajo del lado del gateway sigue siendo la verdad.
 *
 * LO IMPORTANTE DE ESTE ARCHIVO, Y NO ES UN DETALLE:
 *
 * Esta función NO la llama un usuario logueado, la llama un servidor. No hay
 * sesión que verificar, así que hay que desplegarla con --no-verify-jwt, y eso
 * significa que la URL queda abierta a internet. Lo único que separa un aviso
 * real de uno inventado es la firma HMAC. Si esa verificación se saca o se
 * hace mal, cualquiera puede escribirle un CAE falso a una venta.
 *
 * Para desplegarla:
 *   supabase functions deploy arca-webhook --no-verify-jwt
 *   supabase secrets set ARCA_WEBHOOK_SECRET=...
 *
 * Y del lado del gateway hay que cargar la fila en su tabla `webhooks` con esta
 * URL y el mismo secret: no hay pantalla para hacerlo, va a mano.
 */

const CABECERA_FIRMA = "x-arca-signature";

function responder(cuerpo: unknown, status: number) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Comparación en tiempo constante.
 *
 * Comparar con === corta apenas encuentra el primer carácter distinto, y esa
 * diferencia de tiempo, medida muchas veces, deja adivinar la firma carácter
 * por carácter. Acá se recorre todo siempre.
 */
function igualesEnTiempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

async function firmaDe(secreto: string, cuerpoCrudo: string): Promise<string> {
  const clave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secreto),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const firma = await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(cuerpoCrudo));
  const hex = [...new Uint8Array(firma)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return responder({ error: "Método no permitido" }, 405);

  const URL_BASE = Deno.env.get("SUPABASE_URL");
  const CLAVE_SERVICIO =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  const SECRETO = Deno.env.get("ARCA_WEBHOOK_SECRET");

  if (!URL_BASE || !CLAVE_SERVICIO) return responder({ error: "Sin configurar" }, 500);
  if (!SECRETO) {
    // Sin secreto no se puede verificar nada, y sin verificar no se escribe.
    // Antes aceptar de menos que escribir un CAE que no vino de ARCA.
    console.error("arca-webhook: falta ARCA_WEBHOOK_SECRET");
    return responder({ error: "Sin configurar" }, 503);
  }

  // El cuerpo se lee CRUDO y no se parsea todavía. La firma se calculó sobre
  // estos bytes exactos: parsear y volver a serializar cambia los espacios y el
  // orden, y la firma deja de dar.
  const crudo = await req.text();

  const recibida = req.headers.get(CABECERA_FIRMA) ?? "";
  const esperada = await firmaDe(SECRETO, crudo);
  if (!igualesEnTiempoConstante(esperada, recibida)) {
    console.error("arca-webhook: firma inválida");
    return responder({ error: "Firma inválida" }, 401);
  }

  let aviso: {
    event?: string;
    job_id?: string;
    cae?: string;
    cae_vto?: string;
    nro_comprobante?: number;
    qr_url?: string;
    error_code?: string;
    error_detail?: string;
  };
  try {
    aviso = JSON.parse(crudo);
  } catch {
    return responder({ error: "Cuerpo inválido" }, 400);
  }

  if (!aviso.job_id) return responder({ error: "Sin job_id" }, 400);

  const admin = createClient(URL_BASE, CLAVE_SERVICIO, { auth: { persistSession: false } });

  const { data: fila } = await admin
    .from("comprobantes")
    .select("id, estado")
    .eq("job_id", aviso.job_id)
    .maybeSingle();

  // Un aviso de un trabajo que no conocemos no es un error del gateway: puede
  // ser de otro sistema que factura contra la misma cuenta. Se contesta 200
  // igual para que no lo reintente al pedo.
  if (!fila) return responder({ ok: true, ignorado: true }, 200);

  await aplicarResultado(admin, fila.id, {
    job_id: aviso.job_id,
    status: aviso.event === "invoice.emitted" ? "emitted" : "error",
    cae: aviso.cae,
    cae_vto: aviso.cae_vto,
    nro_comprobante: aviso.nro_comprobante,
    qr_url: aviso.qr_url,
    error_code: aviso.error_code,
    error_detail: aviso.error_detail,
  });

  // Rápido y 200: el gateway espera tres segundos y reintenta una sola vez.
  return responder({ ok: true }, 200);
});
