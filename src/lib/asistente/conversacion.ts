import { useRef, useState } from "react";
import { supa } from "@/lib/supabase";
import { useSesion, useSucursalOperativa } from "@/lib/sesion";
import {
  describirHerramienta,
  ejecutarHerramienta,
  necesitaConfirmacion,
  type Descripcion,
} from "./ejecutor";
import { MAX_MENSAJES } from "../../../supabase/functions/asistente/herramientas";

/**
 * La conversación con el asistente, con la regla que la define entera:
 *
 *   **ninguna acción que mueva plata o stock se ejecuta sola.**
 *
 * Cuando el modelo pide una de esas, el bucle se detiene acá y espera a que una
 * persona lea la tarjeta y apriete Confirmar. Hasta ese momento no se llamó a la
 * base: lo único que existe es una intención.
 *
 * Las consultas (buscar un producto, mirar la caja) sí corren solas. Frenar una
 * búsqueda para pedir permiso no protege nada y vuelve al asistente inservible.
 *
 * La otra regla, más chica pero igual de importante: **una acción que falló no
 * se reintenta sola**. Reintentar un cobro es la forma más simple de cobrarlo
 * dos veces.
 *
 * Las funciones de acá adentro son funciones comunes y no `useCallback` a
 * propósito: `procesar` y `seguir` se llaman entre sí, y memorizarlas obliga a
 * que cada una dependa de la otra. Como todo el estado que necesitan viaja por
 * parámetro, no hay nada que memorizar.
 */

type Bloque = Record<string, unknown>;
type Mensaje = { role: "user" | "assistant"; content: Bloque[] };

export type Adjunto = { tipo: "imagen" | "pdf"; media_type: string; datos: string; nombre: string };

export type Pendiente = {
  sucursalId: string | null;
  usuarioId: string | null;
  id: string;
  nombre: string;
  entrada: Bloque;
  descripcion: Descripcion;
};

/** Lo que quedó a mitad de camino esperando que la persona decida. */
type Cola = { historial: Mensaje[]; restantes: Bloque[]; resultados: Bloque[] };

const URL_FUNCION = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/asistente`;

function textoDe(bloques: Bloque[]): string {
  return bloques
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n")
    .trim();
}

export function useAsistente() {
  const { usuario } = useSesion();
  const sucursal = useSucursalOperativa();

  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [pensando, setPensando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restantes, setRestantes] = useState<number | null>(null);
  const [pendiente, setPendiente] = useState<Pendiente | null>(null);

  // La cola vive en un ref y no en el estado porque no se dibuja. Meterla en el
  // estado solo agregaría renders y una carrera más para tener en la cabeza.
  const cola = useRef<Cola | null>(null);

  async function pedirleAClaude(historial: Mensaje[]): Promise<Mensaje | null> {
    const { data } = await supa.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setError("Se cerró la sesión. Volvé a entrar.");
      return null;
    }

    let rta: Response;
    try {
      rta = await fetch(URL_FUNCION, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          // Solo se manda la cola de la conversación. Una charla larga cuesta
          // cada vez más porque se reenvía entera en cada vuelta, y el principio
          // casi nunca es lo que se está discutiendo.
          messages: historial.slice(-MAX_MENSAJES),
          contexto: {
            nombre: usuario?.nombre ?? "",
            rol: usuario?.rol ?? "",
            sucursal: sucursal?.nombre ?? "",
            // El nombre del negocio todavía no vive en la base (en Configuración
            // está escrito a mano). Hasta que exista, el servidor pone "el
            // negocio" y el asistente no dice un nombre inventado.
            negocio: "",
            fecha: new Date().toLocaleDateString("es-AR", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            }),
          },
        }),
      });
    } catch {
      setError("No se pudo llegar al servidor. Fijate la conexión y probá de nuevo.");
      return null;
    }

    const cuerpo = (await rta.json().catch(() => null)) as {
      content?: Bloque[];
      restantes?: number | null;
      error?: string;
    } | null;

    if (!rta.ok) {
      setError(cuerpo?.error ?? "El asistente no pudo contestar. Probá de nuevo.");
      return null;
    }
    if (typeof cuerpo?.restantes === "number") setRestantes(cuerpo.restantes);

    // El contenido se guarda entero y tal cual vino, incluidos los bloques de
    // razonamiento. Con el pensamiento extendido prendido, la API exige que se
    // le devuelvan igual que como los mandó; recortarlos rompe la vuelta
    // siguiente.
    return { role: "assistant", content: cuerpo?.content ?? [] };
  }

  /**
   * Ejecuta las herramientas que pidió el modelo, en orden, y frena en la
   * primera que necesite confirmación.
   */
  async function procesar(historial: Mensaje[], bloques: Bloque[], yaHechos: Bloque[]) {
    const resultados = [...yaHechos];

    for (let i = 0; i < bloques.length; i++) {
      const b = bloques[i];
      const nombre = String(b.name ?? "");
      const idUso = String(b.id ?? "");
      const entrada = (b.input ?? {}) as Bloque;

      if (necesitaConfirmacion(nombre)) {
        cola.current = { historial, restantes: bloques.slice(i + 1), resultados };
        setPendiente({
          sucursalId: sucursal?.id ?? null,
          usuarioId: usuario?.user_id ?? null,
          id: idUso,
          nombre,
          entrada,
          descripcion: await describirHerramienta(nombre, entrada),
        });
        setPensando(false);
        return;
      }

      if (!sucursal) {
        resultados.push({
          type: "tool_result",
          tool_use_id: idUso,
          is_error: true,
          content: "Esta computadora todavía no tiene configurada una sucursal.",
        });
        continue;
      }

      const res = await ejecutarHerramienta(nombre, entrada, sucursal.id);
      resultados.push({
        type: "tool_result",
        tool_use_id: idUso,
        is_error: !res.ok,
        content: res.ok ? JSON.stringify(res.datos) : res.error,
      });
    }

    await seguir([...historial, { role: "user", content: resultados }]);
  }

  async function seguir(historial: Mensaje[]) {
    setMensajes(historial);
    setPensando(true);

    const respuesta = await pedirleAClaude(historial);
    if (!respuesta) {
      setPensando(false);
      return;
    }

    const conRespuesta = [...historial, respuesta];
    setMensajes(conRespuesta);

    const herramientas = respuesta.content.filter((b) => b.type === "tool_use");
    if (herramientas.length === 0) {
      setPensando(false);
      return;
    }

    await procesar(conRespuesta, herramientas, []);
  }

  async function enviar(texto: string, adjuntos: Adjunto[] = []) {
    const limpio = texto.trim();
    if ((!limpio && adjuntos.length === 0) || pensando || pendiente) return;
    setError(null);

    const content: Bloque[] = adjuntos.map((a) =>
      a.tipo === "pdf"
        ? { type: "document", source: { type: "base64", media_type: a.media_type, data: a.datos } }
        : { type: "image", source: { type: "base64", media_type: a.media_type, data: a.datos } },
    );
    content.push({ type: "text", text: limpio || "Leé esta factura y decime qué dice." });

    await seguir([...mensajes, { role: "user", content }]);
  }

  async function confirmar() {
    const accion = pendiente;
    const guardado = cola.current;
    if (!accion || !guardado) return;
    if (!sucursal || accion.sucursalId !== sucursal.id || !usuario || accion.usuarioId !== usuario.user_id) {
      setError("Cambió la sesión o la sucursal. Cancelá esta propuesta y preparala nuevamente antes de confirmar.");
      return;
    }

    setPendiente(null);
    cola.current = null;
    setPensando(true);

    let res;
    try {
      res = await ejecutarHerramienta(accion.nombre, accion.entrada, sucursal.id);
    } catch {
      res = { ok: false as const, error: "No se pudo confirmar el resultado. La operación podría haberse registrado: revisá Compras antes de volver a enviarla." };
    }
    const resultado: Bloque = {
      type: "tool_result",
      tool_use_id: accion.id,
      is_error: !res.ok,
      content: res.ok
        ? JSON.stringify(res.datos)
        : // El "no lo reintentes" va también acá y no solo en el prompt: este es
          // el último texto que el modelo lee antes de decidir qué hacer.
          `${res.error} No lo intentes de nuevo por tu cuenta: contale a la persona qué pasó.`,
    };

    if (!res.ok) {
      // Una operación dependiente nunca sigue después de un resultado fallido o incierto.
      const omitidos = guardado.restantes.map((b) => ({
        type: "tool_result", tool_use_id: String(b.id ?? ""), is_error: true,
        content: "No ejecutada: la operación anterior falló o su resultado es incierto. No reintentar automáticamente.",
      }));
      setMensajes([...guardado.historial, { role: "user", content: [...guardado.resultados, resultado, ...omitidos] }]);
      setError(res.error);
      setPensando(false);
      return;
    }
    try {
      await procesar(guardado.historial, guardado.restantes, [...guardado.resultados, resultado]);
    } finally {
      setPensando(false);
    }
  }

  async function cancelar() {
    const accion = pendiente;
    const guardado = cola.current;
    if (!accion || !guardado) return;

    setPendiente(null);
    cola.current = null;
    setPensando(true);

    // Cancelar una acción cancela también las que venían atrás. Si alguien frena
    // la venta, cobrarla igual sería exactamente lo contrario de lo que pidió.
    const cancelados: Bloque[] = [accion.id, ...guardado.restantes.map((b) => String(b.id ?? ""))]
      .filter(Boolean)
      .map((id) => ({
        type: "tool_result",
        tool_use_id: id,
        content: "La persona canceló. No se hizo nada. Preguntale qué quiere cambiar.",
      }));

    await seguir([
      ...guardado.historial,
      { role: "user", content: [...guardado.resultados, ...cancelados] },
    ]);
  }

  function limpiar() {
    if (pensando) return;
    cola.current = null;
    setPendiente(null);
    setMensajes([]);
    setError(null);
  }

  /** Lo que se dibuja: el texto, sin los bloques internos de herramientas. */
  const burbujas = mensajes
    .map((m, i) => ({ id: i, quien: m.role, texto: textoDe(m.content) }))
    .filter((b) => b.texto !== "");

  return {
    burbujas,
    pensando,
    error,
    restantes,
    pendiente,
    enviar,
    confirmar,
    cancelar,
    limpiar,
    haySucursal: sucursal !== null,
  };
}
