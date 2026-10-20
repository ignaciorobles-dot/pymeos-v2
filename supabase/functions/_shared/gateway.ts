/**
 * El cliente del gateway de ARCA. Es el mini-SDK que trae la guía
 * (`INTEGRACION.md`), con dos diferencias que importan:
 *
 *   1. Corre acá y no en el navegador. La guía asume una app con servidor;
 *      PymeOS es un SPA y todo lo que empieza con VITE_ es público. Una clave
 *      `sk_prod_...` en el bundle es que cualquiera pueda emitir facturas con
 *      el CUIT del negocio. Vive como secret de Supabase y no sale de acá.
 *
 *   2. Reintenta los 500. La guía lo pide explícitamente ("error del gateway,
 *      reintentar con backoff"), y como esto lo dispara alguien que está
 *      atendiendo a un cliente, conviene que el reintento sea nuestro y no
 *      suyo.
 *
 * Lo que NO hace: esperar la factura. El gateway contesta 202 con un `job_id` y
 * emite por atrás. Preguntar por el resultado es otra llamada, y quién la hace
 * lo decide `index.ts`.
 */

export type Cuenta = { base: string; slug: string; key: string };

export type EstadoJob = "pending" | "retrying" | "emitted" | "error";

export type Job = {
  job_id: string;
  status: EstadoJob;
  cae?: string | null;
  cae_vto?: string | null;
  nro_comprobante?: number | null;
  punto_venta?: number | null;
  qr_url?: string | null;
  error_code?: string | null;
  error_type?: string | null;
  error_detail?: string | null;
};

export type Resultado<T> =
  | { ok: true; datos: T }
  | { ok: false; status: number; codigo: string; mensaje: string };

const TIEMPO_LIMITE_MS = 15_000;
/** La guía dice backoff y no dice cuánto. Tres intentos y afuera: del otro lado hay alguien esperando. */
const ESPERAS_MS = [1_000, 4_000, 10_000];

/**
 * Saca las cuentas del secret. Es un mapa slug → clave y no una clave sola
 * porque los dos locales pueden facturar con CUIT distinto, y en ese caso son
 * dos cuentas en el gateway. Con el mapa, sumar un local es cambiar un secret;
 * con una clave sola, sería tocar el código.
 */
/**
 * Cuando la sucursal dice esto, se le pega al gateway por la ruta generica y la
 * clave sola decide de que cuenta es. Sirve cuando hay una sola cuenta y todavia
 * no sabemos su nombre corto, que es como arranco casi siempre: la clave la
 * consegues antes que el slug.
 */
export const CUENTA_UNICA = "*";

export function leerCuenta(slug: string): Cuenta | null {
  const base = (Deno.env.get("ARCA_BASE_URL") ?? "").replace(/\/+$/, "");
  const crudo = Deno.env.get("ARCA_API_KEYS") ?? "";
  if (!base || !crudo) return null;

  let mapa: Record<string, string>;
  try {
    mapa = JSON.parse(crudo);
  } catch {
    // A propósito no se loguea el contenido: es un secret.
    console.error("facturar: ARCA_API_KEYS no es un JSON válido");
    return null;
  }

  // Si el slug tiene su clave propia, esa gana. Si no, se prueba con la cuenta
  // unica: asi sumar un segundo CUIT mas adelante es agregar una entrada al
  // secret, sin tocar las sucursales que ya andaban.
  const key = mapa[slug] ?? mapa[CUENTA_UNICA];
  if (!key) return null;

  return { base, slug: mapa[slug] ? slug : CUENTA_UNICA, key };
}

/**
 * La URL con el slug adentro es la que recomienda la guía: si la clave no es de
 * ese local, el gateway contesta 403 en vez de trabajar sobre el local
 * equivocado. Un error ruidoso es mejor que una factura a nombre de otro.
 *
 * Con la cuenta unica no se puede hacer esa comprobacion, porque justamente no
 * sabemos el nombre del tenant. Se usa la ruta generica y la clave decide. Es
 * mas debil: conviene cargar el slug de verdad cuando se sepa.
 */
const urlDe = (cuenta: Cuenta, camino: string) =>
  cuenta.slug === CUENTA_UNICA
    ? `${cuenta.base}/v1${camino}`
    : `${cuenta.base}/t/${cuenta.slug}/v1${camino}`;

async function pedir<T>(
  cuenta: Cuenta,
  camino: string,
  init: RequestInit,
): Promise<Resultado<T>> {
  let ultimo: Resultado<T> = {
    ok: false,
    status: 0,
    codigo: "sin_respuesta",
    mensaje: "El sistema de facturación no respondió.",
  };

  for (let intento = 0; intento < ESPERAS_MS.length; intento++) {
    let rta: Response;
    try {
      rta = await fetch(urlDe(cuenta, camino), {
        ...init,
        headers: { Authorization: `Bearer ${cuenta.key}`, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      });
    } catch (e) {
      // Timeout o red caída. Es de los que vale la pena reintentar.
      console.error("facturar: no se pudo llegar al gateway", String(e));
      ultimo = {
        ok: false,
        status: 0,
        codigo: "sin_respuesta",
        mensaje: "No se pudo contactar al sistema de facturación.",
      };
      await new Promise((r) => setTimeout(r, ESPERAS_MS[intento]));
      continue;
    }

    const texto = await rta.text();
    let cuerpo: Record<string, unknown> = {};
    try {
      cuerpo = texto ? JSON.parse(texto) : {};
    } catch {
      cuerpo = {};
    }

    if (rta.ok) return { ok: true, datos: cuerpo as T };

    const error = (cuerpo.error ?? {}) as { code?: string; message?: string };
    ultimo = {
      ok: false,
      status: rta.status,
      codigo: error.code ?? `http_${rta.status}`,
      mensaje: error.message ?? texto.slice(0, 300),
    };

    // 4xx es nuestro: el payload está mal, la clave está mal o no existe.
    // Reintentarlo da exactamente lo mismo, solo que más tarde.
    if (rta.status < 500) return ultimo;

    console.error("facturar: el gateway devolvió", rta.status, ultimo.codigo);
    await new Promise((r) => setTimeout(r, ESPERAS_MS[intento]));
  }

  return ultimo;
}

/**
 * Encola la emisión. La clave de idempotencia es lo que evita que un doble
 * click, una recarga o un reintento nuestro terminen en dos facturas: si el
 * gateway ya vio esa clave, devuelve el mismo trabajo y no crea otro.
 */
export function emitir(
  cuenta: Cuenta,
  idempotencyKey: string,
  pedido: unknown,
): Promise<Resultado<{ job_id: string; status: EstadoJob }>> {
  return pedir(cuenta, "/invoices", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(pedido),
  });
}

/** Cómo viene ese trabajo. Es la fuente de verdad, incluso si llegó el webhook. */
export function consultar(cuenta: Cuenta, jobId: string): Promise<Resultado<Job>> {
  return pedir(cuenta, `/invoices/${jobId}`, { method: "GET" });
}

/**
 * "¿Está bien configurado esto?", sin emitir nada.
 *
 * La guía avisa que el gateway no tiene endpoint de salud, así que se le
 * pregunta por un trabajo que no existe y se lee la respuesta:
 *
 *   404 → la clave sirve y el gateway está vivo. Es el caso bueno.
 *   401 → la clave está mal cargada o la revocaron.
 *   403 → la clave es de otro local.
 *
 * Preguntar por un id inexistente no toca nada ni gasta numeración: es la forma
 * más barata de saber si el día que haya que facturar va a andar.
 */
export async function probar(cuenta: Cuenta): Promise<{ ok: boolean; mensaje: string }> {
  const rta = await consultar(cuenta, "00000000-0000-0000-0000-000000000000");

  if (rta.ok) return { ok: true, mensaje: "Conectado." };
  if (rta.status === 404) return { ok: true, mensaje: "Conectado. La facturación está lista." };
  if (rta.status === 401) {
    return { ok: false, mensaje: "La clave de facturación no es válida o fue dada de baja." };
  }
  if (rta.status === 403) {
    return { ok: false, mensaje: "La clave cargada es de otro local. Revisá la conexión de esta sucursal." };
  }
  if (rta.status === 0) {
    return { ok: false, mensaje: "El sistema de facturación no responde." };
  }
  return { ok: false, mensaje: `El sistema de facturación contestó un error (${rta.codigo}).` };
}
