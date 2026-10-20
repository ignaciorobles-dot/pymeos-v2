import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * Alta y reenvío de invitaciones de empleados. Vive acá y no en el navegador
 * porque invitar gente es una operación de administrador: necesita la clave de
 * servicio, que jamás puede viajar al cliente. Nadie configura contraseñas: se
 * manda un link y cada persona elige la suya.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ROLES = ["dueno", "vendedor", "contador"];

function responder(cuerpo: unknown, status: number) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return responder({ error: "Método no permitido" }, 405);

  // Supabase inyecta la clave de servicio con distinto nombre según cuándo se
  // creó el proyecto: los viejos traen SUPABASE_SERVICE_ROLE_KEY, los nuevos
  // (claves sb_secret_) traen SUPABASE_SECRET_KEY. Sin este `??`, en un
  // proyecto nuevo el cliente admin nace sin clave y todo falla con un 401 que
  // parece un problema de sesión del usuario y no lo es.
  const URL_BASE = Deno.env.get("SUPABASE_URL");
  const CLAVE_SERVICIO =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

  if (!URL_BASE || !CLAVE_SERVICIO) {
    return responder(
      { error: "El servidor no tiene configurada la clave de servicio. Avisale a Joaquín." },
      500,
    );
  }

  const admin = createClient(URL_BASE, CLAVE_SERVICIO, { auth: { persistSession: false } });

  // Quién pide. El JWT ya viene validado por la plataforma, pero eso solo prueba
  // que hay sesión: acá se comprueba que además sea un dueño activo.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return responder({ error: "Se cerró la sesión. Volvé a entrar." }, 401);

  // Se pregunta a Supabase directamente en vez de usar admin.auth.getUser(token):
  // con las claves y los tokens nuevos, esa función devolvía "Auth session
  // missing" aunque el token viniera perfecto. Un GET a /auth/v1/user no tiene
  // esa ambigüedad: o el token vale, o no.
  const rta = await fetch(`${URL_BASE}/auth/v1/user`, {
    headers: { apikey: CLAVE_SERVICIO, Authorization: `Bearer ${token}` },
  });

  // El detalle crudo del endpoint de Auth queda en el log del servidor y no en
  // pantalla: a quien está invitando no le sirve de nada y suele confundir. La
  // acción es siempre la misma —volver a entrar—, así que eso es lo que se dice.
  if (!rta.ok) {
    console.error("invitar-empleado: /auth/v1/user", rta.status, await rta.text().catch(() => ""));
    return responder({ error: "Se venció tu sesión. Cerrá sesión, volvé a entrar y probá de nuevo." }, 401);
  }

  const usuario = (await rta.json()) as { id?: string };
  if (!usuario?.id) return responder({ error: "Se cerró la sesión. Volvé a entrar." }, 401);
  const auth = { user: { id: usuario.id } };

  const { data: quienPide, error: errQuien } = await admin
    .from("usuarios")
    .select("rol, activo")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  // Los tres casos se separan a propósito. Antes se trataban como uno solo y la
  // función respondía "solo un dueño puede invitar" incluso cuando la base le
  // había negado la lectura a ella misma: un error del servidor disfrazado de
  // falta de permisos, que mandó a buscar el problema al lado equivocado
  // durante horas. Un fallo del servidor nunca se le echa encima al usuario.
  if (errQuien) {
    console.error("invitar-empleado: no se pudo leer usuarios", errQuien);
    return responder({ error: "Hubo un problema en el servidor. Avisale a Joaquín." }, 500);
  }
  if (!quienPide) {
    console.error("invitar-empleado: sin fila en usuarios para", auth.user.id);
    return responder({ error: "Tu usuario no está dado de alta en el sistema." }, 403);
  }
  if (!quienPide.activo || quienPide.rol !== "dueno") {
    return responder({ error: "Solo un dueño puede invitar empleados." }, 403);
  }

  let cuerpo: {
    accion?: string;
    email?: string;
    nombre?: string;
    rol?: string;
    sucursal_id?: string | null;
    redirect_to?: string;
  };
  try {
    cuerpo = await req.json();
  } catch {
    return responder({ error: "Cuerpo inválido" }, 400);
  }

  const email = (cuerpo.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return responder({ error: "El email no es válido" }, 400);
  }

  const { data: yaEsta } = await admin
    .from("usuarios")
    .select("user_id, confirmado")
    .eq("email", email)
    .maybeSingle();

  // --- Reenviar una invitación que nunca se aceptó -------------------------
  if (cuerpo.accion === "reenviar") {
    if (!yaEsta) return responder({ error: "Ese email no está en el sistema" }, 404);
    if (yaEsta.confirmado) {
      return responder(
        { error: "Esa persona ya entró y tiene su contraseña. Si la olvidó, que use ‘Olvidé mi contraseña’." },
        409,
      );
    }
    const { error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: cuerpo.redirect_to,
    });
    if (error) return responder({ error: error.message }, 400);
    return responder({ ok: true, reenviado: true }, 200);
  }

  // --- Invitar por primera vez ---------------------------------------------
  const nombre = (cuerpo.nombre ?? "").trim();
  const rol = cuerpo.rol ?? "";
  const sucursalId = cuerpo.sucursal_id ?? null;

  if (nombre.length < 2) return responder({ error: "Falta el nombre" }, 400);
  if (!ROLES.includes(rol)) return responder({ error: "Rol desconocido" }, 400);

  if (sucursalId) {
    const { data: suc } = await admin
      .from("sucursales")
      .select("id, activa")
      .eq("id", sucursalId)
      .maybeSingle();
    if (!suc?.activa) return responder({ error: "Esa sucursal no existe o está inactiva" }, 400);
  }

  if (yaEsta) {
    return responder(
      {
        error: yaEsta.confirmado
          ? "Ese email ya tiene usuario en el sistema"
          : "Ese email ya fue invitado y todavía no aceptó. Reenviale la invitación desde la tarjeta.",
      },
      409,
    );
  }

  const { data: invitado, error: errInvitar } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: cuerpo.redirect_to,
    data: { nombre },
  });

  if (errInvitar || !invitado?.user) {
    return responder({ error: errInvitar?.message ?? "No se pudo enviar la invitación" }, 400);
  }

  const { error: errFila } = await admin.from("usuarios").insert({
    user_id: invitado.user.id,
    nombre,
    rol,
    sucursal_id: sucursalId,
    activo: true,
    email,
    confirmado: false,
  });

  // Si el mail salió pero la fila no entró, la persona quedaría con acceso y sin
  // perfil: el sistema la echaría al entrar. Se deshace la invitación.
  if (errFila) {
    await admin.auth.admin.deleteUser(invitado.user.id);
    return responder({ error: `No se pudo crear el perfil: ${errFila.message}` }, 400);
  }

  return responder({ ok: true, user_id: invitado.user.id }, 200);
});
