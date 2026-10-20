import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL as string;
const KEY = import.meta.env.VITE_SUPABASE_KEY as string;

if (!URL || !KEY) {
  throw new Error(
    "Faltan VITE_SUPABASE_URL o VITE_SUPABASE_KEY. Copiá .env.example a .env y completalos.",
  );
}

/**
 * Se lee ANTES de crear el cliente: apenas arranca, supabase-js consume el
 * hash de la URL y lo borra. Si esperábamos al useEffect, ya no estaba.
 *
 * Son dos links distintos con el mismo final: "olvidé mi contraseña"
 * (`type=recovery`) y la invitación a un empleado nuevo (`type=invite`).
 * Los dos dejan sesión válida sin que nadie haya elegido una contraseña,
 * así que los dos tienen que frenar en la pantalla de elegirla.
 */
export const esLinkDeContrasena =
  typeof window !== "undefined" &&
  (window.location.hash.includes("type=recovery") ||
    window.location.hash.includes("type=invite"));

/** true solo para el link de invitación: cambia el texto, no el flujo. */
export const esLinkDeInvitacion =
  typeof window !== "undefined" && window.location.hash.includes("type=invite");

/**
 * Cliente principal. Guarda la sesión en el navegador.
 * La clave es publicable a propósito: quien manda es RLS en el servidor,
 * no esta clave. Ocultarla no sería seguridad.
 */
export const supa = createClient(URL, KEY);

/**
 * Cliente aparte, sin memoria de sesión, para verificar una contraseña
 * sin desloguear a quien está usando el sistema. Se usa cuando hay que
 * confirmar que quien pide un cambio sensible es realmente un dueño.
 */
export const supaVerificar = createClient(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false, storageKey: "pymeos-verificar" },
});
