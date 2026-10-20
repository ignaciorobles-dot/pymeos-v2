import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  armarSystem,
  MAX_BODY_BYTES,
  MAX_TOKENS,
  MODELO,
  sanitizarContexto,
  TOOLS,
  TOPE_DIARIO_POR_DEFECTO,
  validarMessages,
} from "./herramientas.ts";

/**
 * El asistente habla con Claude a través de acá y nunca directo.
 *
 * El motivo es uno solo y no se negocia: la clave de Anthropic vive como secret
 * de Supabase y jamás puede llegar al navegador. Todo lo que se pone en el
 * frontend es público, incluidas las variables VITE_. Una clave de API en el
 * bundle es una clave regalada, y la factura la paga el negocio.
 *
 * De paso, poner el intermediario acá deja el lugar natural para las otras dos
 * cosas que tampoco pueden vivir en el cliente: quién tiene permiso de usarlo
 * (cualquier usuario activo, con su rol) y cuánto puede gastar por día.
 *
 * Para desplegarla:
 *   supabase functions deploy asistente
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return responder({ error: "Método no permitido" }, 405);

  const URL_BASE = Deno.env.get("SUPABASE_URL");
  // Los proyectos viejos traen SUPABASE_SERVICE_ROLE_KEY y los nuevos
  // SUPABASE_SECRET_KEY. Sin el `??` esto falla con un 401 que parece un
  // problema de sesión del usuario y no lo es.
  const CLAVE_SERVICIO =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  const CLAVE_ANTHROPIC = Deno.env.get("ANTHROPIC_API_KEY");

  if (!URL_BASE || !CLAVE_SERVICIO) {
    return responder({ error: "El servidor no tiene configurada la clave de servicio. Avisale a Joaquín." }, 500);
  }
  if (!CLAVE_ANTHROPIC) {
    // 503 y no 500: no está roto, está sin configurar. La diferencia importa
    // cuando alguien tiene que decidir si esto se arregla o se espera.
    return responder({ error: "El asistente todavía no está configurado en este servidor." }, 503);
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
    console.error("asistente: /auth/v1/user", rtaAuth.status, await rtaAuth.text().catch(() => ""));
    return responder({ error: "Se venció tu sesión. Cerrá sesión, volvé a entrar y probá de nuevo." }, 401);
  }
  const authUser = (await rtaAuth.json()) as { id?: string };
  if (!authUser?.id) return responder({ error: "Se cerró la sesión. Volvé a entrar." }, 401);

  const { data: quienPide, error: errQuien } = await admin
    .from("usuarios")
    .select("nombre, rol, activo")
    .eq("user_id", authUser.id)
    .maybeSingle();

  // Los tres casos van separados a propósito: un fallo del servidor nunca se le
  // echa encima al usuario como si fuera falta de permisos.
  if (errQuien) {
    console.error("asistente: no se pudo leer usuarios", errQuien);
    return responder({ error: "Hubo un problema en el servidor. Avisale a Joaquín." }, 500);
  }
  if (!quienPide) return responder({ error: "Tu usuario no está dado de alta en el sistema." }, 403);
  if (!quienPide.activo) return responder({ error: "Tu usuario está desactivado." }, 403);

  // Acá no se filtra por rol. El asistente es para todos, y lo que cada uno
  // puede hacer lo decide la base cuando la herramienta se ejecuta, con la
  // sesión de esa persona. Poner una segunda lista de permisos en este archivo
  // sería mantener dos veces la misma regla, y tarde o temprano dirían cosas
  // distintas.

  // --- Cuánto le queda -----------------------------------------------------
  const tope = Number(Deno.env.get("TOPE_ASISTENTE_DIA") ?? TOPE_DIARIO_POR_DEFECTO);
  const { data: restantes, error: errTope } = await admin.rpc("consumir_credito_asistente", {
    p_usuario_id: authUser.id,
    p_tope: Number.isFinite(tope) && tope > 0 ? Math.floor(tope) : TOPE_DIARIO_POR_DEFECTO,
  });

  if (errTope) {
    // El único error esperable es haber llegado al tope, y ese mensaje ya viene
    // escrito en castellano desde la base. Cualquier otro es nuestro.
    const llegoAlTope = /tope de \d+ mensajes/i.test(errTope.message ?? "");
    if (llegoAlTope) return responder({ error: errTope.message }, 429);
    console.error("asistente: consumir_credito_asistente", errTope);
    return responder({ error: "Hubo un problema en el servidor. Avisale a Joaquín." }, 500);
  }

  // --- Lo que mandó el navegador -------------------------------------------
  const crudo = await req.text();
  if (crudo.length > MAX_BODY_BYTES) {
    return responder({ error: "El mensaje es demasiado grande. Si es una foto, sacala más chica." }, 413);
  }

  let cuerpo: { messages?: unknown; contexto?: unknown };
  try {
    cuerpo = JSON.parse(crudo);
  } catch {
    return responder({ error: "Cuerpo inválido" }, 400);
  }

  const revision = validarMessages(cuerpo.messages);
  if (!revision.ok) return responder({ error: revision.error }, 400);

  const contexto = sanitizarContexto(cuerpo.contexto);
  // El nombre y el rol NO se toman de lo que mandó el navegador: se pisan con
  // lo que dice la base. El resto (sucursal, negocio, fecha) es del equipo y no
  // define permisos, así que puede venir de ahí.
  contexto.nombre = quienPide.nombre ?? contexto.nombre;
  contexto.rol = quienPide.rol ?? contexto.rol;

  // --- Claude --------------------------------------------------------------
  const rtaIA = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": CLAVE_ANTHROPIC,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: MAX_TOKENS,
      // Pensar cuando hace falta y no cuando no. En una cuenta de caja no gasta
      // nada; en "revisá si me conviene este proveedor" se toma el tiempo.
      thinking: { type: "adaptive" },
      system: armarSystem(contexto),
      tools: TOOLS,
      messages: revision.messages,
    }),
  });

  if (!rtaIA.ok) {
    const detalle = await rtaIA.text().catch(() => "");
    console.error("asistente: api.anthropic.com", rtaIA.status, detalle);
    // El detalle queda en el log. A la persona que está atendiendo un cliente
    // no le sirve un JSON de error, le sirve saber si reintentar o no.
    if (rtaIA.status === 429) {
      return responder({ error: "El asistente está saturado en este momento. Probá en un minuto." }, 429);
    }
    return responder({ error: "El asistente no pudo contestar. Probá de nuevo." }, 502);
  }

  const respuesta = (await rtaIA.json()) as {
    content?: unknown[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  // Los tokens se anotan pero no se esperan con ansiedad: si esto falla,
  // perdimos un dato de costo, no la respuesta de alguien que está trabajando.
  admin
    .rpc("anotar_tokens_asistente", {
      p_usuario_id: authUser.id,
      p_entrada: respuesta.usage?.input_tokens ?? 0,
      p_salida: respuesta.usage?.output_tokens ?? 0,
    })
    .then(({ error }) => {
      if (error) console.error("asistente: anotar_tokens_asistente", error);
    });

  return responder(
    {
      content: respuesta.content ?? [],
      stop_reason: respuesta.stop_reason ?? null,
      restantes: typeof restantes === "number" ? restantes : null,
    },
    200,
  );
});
