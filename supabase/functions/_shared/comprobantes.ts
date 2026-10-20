import type { Job } from "./gateway.ts";

/**
 * Guardar lo que contesto ARCA, en un solo lugar.
 *
 * Hay tres caminos por los que puede llegar la respuesta: la pantalla
 * preguntando mientras el cajero espera, el aviso del gateway, y el barrido
 * revisando los que quedaron colgados. Los tres tienen que hacer exactamente lo
 * mismo, asi que hacen esto.
 *
 * Y "lo mismo" no es un update: es llamar a `registrar_cae`, que es donde vive
 * la regla (que el CAE tenga 14 numeros, que el comprobante estuviera
 * esperando, y que una nota de credito con CAE deje sin efecto a su original).
 * Escribir el estado por afuera de esa funcion seria dejar esa regla sin
 * aplicar justo en el camino automatico, que es el que mas veces va a correr.
 */

export type Cierre = "sigue_esperando" | "emitido" | "rechazado" | "no_se_pudo";

export async function aplicarResultado(
  // deno-lint-ignore no-explicit-any
  admin: any,
  comprobanteId: string,
  job: Job,
): Promise<Cierre> {
  // Todavia esta trabajando. "retrying" NO es un error: el gateway esta
  // reintentando solo contra ARCA. Marcarlo como rechazado haria que alguien
  // salga a arreglar algo que se arregla solo.
  if (job.status === "pending" || job.status === "retrying") return "sigue_esperando";

  if (job.status === "emitted") {
    // El QR va aparte porque `registrar_cae` no lo conoce: es dato del
    // comprobante impreso, no de la autorizacion. Se guarda antes, asi el
    // comprobante nunca queda emitido sin su QR.
    if (job.qr_url) {
      await admin.from("comprobantes").update({ qr_url: job.qr_url }).eq("id", comprobanteId);
    }

    const { error } = await admin.rpc("registrar_cae", {
      p_comprobante_id: comprobanteId,
      p_numero: job.nro_comprobante,
      p_cae: job.cae,
      p_cae_vencimiento: job.cae_vto,
    });

    if (error) {
      // Que ARCA haya autorizado y nosotros no podamos anotarlo es lo peor que
      // puede pasar acá: la factura existe para ARCA y no para el sistema. Se
      // deja pendiente a propósito para que el barrido lo reintente, y se
      // loguea fuerte para que alguien lo vea.
      console.error("comprobantes: ARCA autorizó pero no se pudo registrar el CAE", comprobanteId, error);
      return "no_se_pudo";
    }
    return "emitido";
  }

  // ARCA rechazó. El motivo se guarda tal cual vino: el que diagnostica
  // necesita el texto original, no nuestra interpretación.
  const motivo = [job.error_code, job.error_detail].filter(Boolean).join(" — ") || "ARCA rechazó el comprobante.";

  const { error } = await admin.rpc("rechazar_comprobante", {
    p_comprobante_id: comprobanteId,
    p_motivo: motivo,
  });

  if (error) {
    // Puede ser simplemente que otro camino ya lo cerró: `rechazar_comprobante`
    // solo acepta un comprobante que estaba esperando.
    console.error("comprobantes: no se pudo marcar el rechazo", comprobanteId, error);
    return "no_se_pudo";
  }
  return "rechazado";
}
