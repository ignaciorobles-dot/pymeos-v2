import { supa } from "@/lib/supabase";

/**
 * Pedirle el CAE a ARCA, desde el navegador.
 *
 * El comprobante ya lo prepara la base (`preparar_comprobante`). Esto es el
 * paso siguiente: mandarlo al gateway de ARCA y esperar el número y el CAE.
 *
 * Todo pasa por la Edge Function `facturar`. Acá no hay ninguna clave del
 * gateway ni la va a haber: lo que se pone en el front es público, y una clave
 * de facturación suelta es que cualquiera emita comprobantes con el CUIT del
 * negocio.
 *
 * Lo otro que hay que tener en la cabeza: ARCA no contesta al toque. Se pide,
 * el comprobante queda esperando, y el CAE aparece hasta un minuto después. Por
 * eso son dos funciones y no una: `pedirCae` pide, y `esperarCae` se queda
 * preguntando. Si esta pantalla se cierra en el medio no se pierde nada: el
 * barrido del servidor lo cierra igual.
 */

const URL_FUNCION = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/facturar`;

export type EstadoComprobante = "pendiente" | "emitido" | "rechazado" | "anulado";

export type ResultadoCae = {
  comprobante_id: string;
  estado: EstadoComprobante;
  tipo: string;
  punto_venta: number;
  numero: number | null;
  cae: string | null;
  cae_vencimiento: string | null;
  qr_url: string | null;
  observacion: string | null;
  aviso?: string;
};

export type Respuesta<T> =
  | { ok: true; datos: T }
  | { ok: false; error: string; falta?: string[] };

async function llamar<T>(cuerpo: Record<string, unknown>): Promise<Respuesta<T>> {
  const { data } = await supa.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { ok: false, error: "Se cerró la sesión. Volvé a entrar." };

  let rta: Response;
  try {
    rta = await fetch(URL_FUNCION, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(cuerpo),
    });
  } catch {
    return { ok: false, error: "No hay conexión con el servidor." };
  }

  const respuesta = (await rta.json().catch(() => ({}))) as Record<string, unknown>;
  if (rta.ok) return { ok: true, datos: respuesta as T };

  return {
    ok: false,
    error: String(respuesta.error ?? "No se pudo pedir el CAE."),
    falta: Array.isArray(respuesta.falta) ? (respuesta.falta as string[]) : undefined,
  };
}

/** Manda el comprobante preparado a ARCA. Vuelve enseguida, todavía sin CAE. */
export function pedirCae(comprobanteId: string, sucursalId: string) {
  return llamar<ResultadoCae>({ accion: "pedir_cae", comprobante_id: comprobanteId, sucursal_id: sucursalId });
}

export function consultarCae(comprobanteId: string) {
  return llamar<ResultadoCae>({ accion: "consultar", comprobante_id: comprobanteId });
}

/** Dice si esta sucursal puede facturar por sistema, sin emitir nada. */
export function probarConexion(sucursalId: string) {
  return llamar<{ ok: boolean; mensaje: string; falta?: string[] }>({
    accion: "probar",
    sucursal_id: sucursalId,
  });
}

const ESPERA_MS = 3_000;
const LIMITE_MS = 90_000;

/**
 * Se queda preguntando hasta que ARCA conteste.
 *
 * Si se cumple el tiempo y todavía no contestó, **no es un error**: el pedido
 * sigue en camino y el barrido lo va a cerrar aunque se cierre esta pantalla.
 * Por eso devuelve el último estado conocido en vez de fallar — que la pantalla
 * diga "está tardando", no "no se pudo".
 */
export async function esperarCae(
  comprobanteId: string,
  alCambiar?: (c: ResultadoCae) => void,
): Promise<ResultadoCae | null> {
  const limite = Date.now() + LIMITE_MS;
  let ultimo: ResultadoCae | null = null;

  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, ESPERA_MS));
    const rta = await consultarCae(comprobanteId);
    if (rta.ok) {
      ultimo = rta.datos;
      alCambiar?.(ultimo);
      if (ultimo.estado !== "pendiente") return ultimo;
    }
  }

  return ultimo;
}

/**
 * Qué decirle a la persona según por qué falló.
 *
 * El caso que importa es `cert_not_authorized_wsfe`, que es el que más pasa y
 * el que peor se entiende: no está roto el sistema, falta un trámite en ARCA
 * que es aparte de sacar el certificado. Si el mensaje no lo explica, alguien
 * pierde una tarde buscando el error en el lugar equivocado.
 */
export function explicarRechazo(observacion: string | null): string {
  const texto = observacion ?? "";

  if (texto.includes("cert_not_authorized_wsfe")) {
    return "El certificado del local todavía no está habilitado en ARCA para facturar. Es un trámite aparte de sacar el certificado, y hasta que no se haga no sale ninguna factura. No es un problema del sistema.";
  }
  if (texto.includes("arca_down") || texto.includes("max_attempts_exceeded")) {
    return "ARCA no respondió después de varios intentos. Cuando vuelva, se puede pedir el CAE de nuevo.";
  }
  if (texto.includes("10246")) {
    return "ARCA pide la condición frente al IVA del cliente. Revisá la ficha del cliente y pedí el CAE de nuevo.";
  }
  if (texto.includes("sin_respuesta")) {
    return "No se pudo contactar al sistema de facturación. Probá de nuevo en un minuto, o registrá el CAE a mano.";
  }
  return texto;
}
