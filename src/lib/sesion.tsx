import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { esLinkDeContrasena, esLinkDeInvitacion, supa, supaVerificar } from "@/lib/supabase";

/** Roles tal cual los guarda la base (sin ñ, para no depender de acentos en SQL). */
export type Rol = "dueno" | "vendedor" | "contador";

export const ROL_LABEL: Record<Rol, string> = {
  dueno: "Dueño",
  vendedor: "Vendedor",
  contador: "Contador",
};

export type Usuario = {
  user_id: string;
  nombre: string;
  rol: Rol;
  /** null = ve todas las sucursales. Con valor = pertenece a esa sucursal. */
  sucursal_id: string | null;
  activo: boolean;
  email: string;
};

export type Sucursal = {
  id: string;
  nombre: string;
  alias: string;
  direccion: string;
  cuit: string | null;
  condicion_iva: string | null;
  punto_venta: number | null;
  activa: boolean;
};

/** Qué pantallas ve cada rol. La UI las esconde; RLS las bloquea de verdad. */
export const RUTAS_POR_ROL: Record<Rol, string[]> = {
  dueno: [
    "/",
    "/ventas",
    "/clientes",
    "/tienda",
    "/pedidos",
    "/atencion",
    "/stock",
    "/gastos",
    "/compras",
    "/caja",
    "/cheques",
    "/resultado",
    "/facturacion",
    "/empleados",
    "/configuracion",
  ],
  vendedor: ["/ventas", "/clientes", "/pedidos", "/atencion", "/stock"],
  contador: [
    "/facturacion",
    "/clientes",
    "/gastos",
    "/compras",
    "/pedidos",
    "/caja",
    "/cheques",
    "/resultado",
  ],
};

/**
 * La sucursal se activa UNA VEZ por equipo y queda guardada en el navegador.
 * Sobrevive al cierre de sesión y al reinicio: la compu del local 1 es del
 * local 1, arranque quien arranque el día. Nadie elige sucursal por venta.
 */
const CLAVE_SUCURSAL_EQUIPO = "pymeos-sucursal-equipo";

type Ctx = {
  /** true mientras todavía no sabemos quién está operando. */
  cargando: boolean;
  usuario: Usuario | null;
  sucursales: Sucursal[];
  /** La sucursal activa de este equipo. Todo movimiento se guarda acá. */
  sucursalEquipo: Sucursal | null;
  sucursalEquipoId: string | null;
  /** Modo mirar-las-dos. Solo lectura: nunca habilita operar. */
  verTodas: boolean;
  setVerTodas: (v: boolean) => void;
  /** Solo quien no está atado a una sucursal puede mirar todo junto. */
  puedeVerTodas: boolean;
  configurarSucursalEquipo: (
    sucursalId: string,
    email: string,
    password: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  cerrarSesion: () => Promise<void>;
  recargarUsuario: () => Promise<void>;
  /** true cuando se entró por un link de "olvidé mi contraseña" o de invitación. */
  recuperando: boolean;
  /** true si ese link era una invitación: cambia el texto, no el flujo. */
  esInvitacion: boolean;
  /** Guarda la contraseña nueva. Nadie más que el dueño de la cuenta la escribe. */
  cambiarMiPassword: (nueva: string) => Promise<{ ok: boolean; error?: string }>;
};

const SesionCtx = createContext<Ctx | null>(null);

function leerSucursalGuardada(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(CLAVE_SUCURSAL_EQUIPO);
}

export function SesionProvider({ children }: { children: ReactNode }) {
  const [cargando, setCargando] = useState(true);
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [sucursalEquipoId, setSucursalEquipoId] = useState<string | null>(null);
  const [verTodas, setVerTodas] = useState(false);
  const [recuperando, setRecuperando] = useState(false);

  const cargarPerfil = useCallback(async () => {
    const { data: sesion } = await supa.auth.getSession();
    const auth = sesion.session?.user;

    if (!auth) {
      setUsuario(null);
      setSucursales([]);
      return;
    }

    const { data: fila, error } = await supa
      .from("usuarios")
      .select("user_id, nombre, rol, sucursal_id, activo")
      .eq("user_id", auth.id)
      .maybeSingle();

    if (error || !fila || !fila.activo) {
      // Existe en Auth pero no es (o dejó de ser) usuario del sistema.
      await supa.auth.signOut();
      setUsuario(null);
      setSucursales([]);
      return;
    }

    setUsuario({
      user_id: fila.user_id,
      nombre: fila.nombre,
      rol: fila.rol as Rol,
      sucursal_id: fila.sucursal_id,
      activo: fila.activo,
      email: auth.email ?? "",
    });

    const { data: sucs } = await supa
      .from("sucursales")
      .select("id, nombre, alias, direccion, cuit, condicion_iva, punto_venta, activa")
      .order("nombre");

    setSucursales((sucs ?? []) as Sucursal[]);
  }, []);

  useEffect(() => {
    setSucursalEquipoId(leerSucursalGuardada());
    if (esLinkDeContrasena) setRecuperando(true);

    let vivo = true;
    void (async () => {
      await cargarPerfil();
      if (vivo) setCargando(false);
    })();

    const { data: sub } = supa.auth.onAuthStateChange((evento) => {
      // El link de recuperación deja una sesión válida, pero no queremos que
      // entre al sistema: primero tiene que elegir una contraseña nueva.
      if (evento === "PASSWORD_RECOVERY") setRecuperando(true);
      void cargarPerfil();
    });

    return () => {
      vivo = false;
      sub.subscription.unsubscribe();
    };
  }, [cargarPerfil]);

  const configurarSucursalEquipo = useCallback(
    async (sucursalId: string, email: string, password: string) => {
      // Cambiar la sucursal del equipo mueve TODAS las ventas del día.
      // Por eso pide credenciales de un dueño, verificadas contra Supabase
      // en un cliente aparte para no voltear la sesión de quien está atendiendo.
      const { data: login, error: errLogin } =
        await supaVerificar.auth.signInWithPassword({ email: email.trim(), password });

      if (errLogin || !login.user) {
        return { ok: false, error: "Email o contraseña incorrectos." };
      }

      const { data: fila } = await supaVerificar
        .from("usuarios")
        .select("rol, activo")
        .eq("user_id", login.user.id)
        .maybeSingle();

      await supaVerificar.auth.signOut();

      if (!fila || !fila.activo) {
        return { ok: false, error: "Ese usuario no está activo en el sistema." };
      }
      if (fila.rol !== "dueno") {
        return { ok: false, error: "Solo un dueño puede cambiar la sucursal de este equipo." };
      }

      window.localStorage.setItem(CLAVE_SUCURSAL_EQUIPO, sucursalId);
      setSucursalEquipoId(sucursalId);
      setVerTodas(false);
      return { ok: true };
    },
    [],
  );

  const cambiarMiPassword = useCallback(async (nueva: string) => {
    const { error } = await supa.auth.updateUser({ password: nueva });
    if (error) {
      return {
        ok: false,
        error:
          error.message.includes("should be at least") || error.message.includes("Password")
            ? "La contraseña tiene que tener al menos 6 caracteres."
            : "No se pudo guardar. Probá pedir el mail de recuperación de nuevo.",
      };
    }
    // Limpia el token del link para que un F5 no vuelva a abrir esta pantalla.
    window.history.replaceState(null, "", window.location.pathname);
    setRecuperando(false);
    return { ok: true };
  }, []);

  const cerrarSesion = useCallback(async () => {
    // Ojo: no borra la sucursal del equipo. La compu sigue siendo del mismo local.
    await supa.auth.signOut();
    setUsuario(null);
    setVerTodas(false);
    setRecuperando(false);
  }, []);

  const sucursalEquipo = useMemo(
    () => sucursales.find((s) => s.id === sucursalEquipoId) ?? null,
    [sucursales, sucursalEquipoId],
  );

  const puedeVerTodas = usuario?.sucursal_id === null && usuario?.rol === "dueno";

  const valor: Ctx = {
    cargando,
    usuario,
    sucursales,
    sucursalEquipo,
    sucursalEquipoId,
    verTodas: puedeVerTodas ? verTodas : false,
    setVerTodas,
    puedeVerTodas: !!puedeVerTodas,
    configurarSucursalEquipo,
    cerrarSesion,
    recargarUsuario: cargarPerfil,
    recuperando,
    esInvitacion: esLinkDeInvitacion,
    cambiarMiPassword,
  };

  return <SesionCtx.Provider value={valor}>{children}</SesionCtx.Provider>;
}

export function useSesion() {
  const c = useContext(SesionCtx);
  if (!c) throw new Error("Falta <SesionProvider> arriba de este componente.");
  return c;
}

/**
 * Sucursal sobre la que se guarda cualquier movimiento. Si devuelve null,
 * no se puede vender, ni cargar un gasto, ni abrir la caja. A propósito.
 */
export function useSucursalOperativa(): Sucursal | null {
  const { sucursalEquipo, verTodas } = useSesion();
  return verTodas ? null : sucursalEquipo;
}
