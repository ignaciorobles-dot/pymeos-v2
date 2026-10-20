import { useState, type ReactNode } from "react";
import { Building2, KeyRound, Loader2, Lock, MapPin } from "lucide-react";
import { supa } from "@/lib/supabase";
import { useSesion } from "@/lib/sesion";

/** Marco común de las pantallas previas al sistema. */
function Portada({ children }: { children: ReactNode }) {
  return (
    <div
      className="grid min-h-screen place-items-center px-4"
      style={{ background: "var(--background)" }}
    >
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-[26px] font-bold tracking-tight">
            Pyme<span style={{ color: "var(--primary)" }}>OS</span>
          </div>
        </div>
        <div className="card-surface p-6">{children}</div>
      </div>
    </div>
  );
}

function Cargando({ texto = "Cargando…" }: { texto?: string }) {
  return (
    <div
      className="grid min-h-screen place-items-center"
      style={{ background: "var(--background)", color: "var(--muted-foreground)" }}
    >
      <div className="flex items-center gap-2 text-[13px]">
        <Loader2 size={16} className="animate-spin" />
        {texto}
      </div>
    </div>
  );
}

const inputCls = "mt-1 h-9 w-full rounded-md border px-2.5 text-[13px] outline-none";
const inputStyle = { borderColor: "var(--border)" } as const;

function PantallaLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAviso(null);
    setEnviando(true);
    const { error: err } = await supa.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setEnviando(false);
    if (err) setError("Email o contraseña incorrectos.");
    // Si sale bien, onAuthStateChange recarga el perfil y esta pantalla desaparece.
  }

  async function recuperar() {
    if (!email.trim()) {
      setError("Escribí tu email y volvé a tocar “Olvidé mi contraseña”.");
      return;
    }
    setError(null);
    setAviso(null);
    const { error: err } = await supa.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
    });
    if (err) {
      // No tragarse el error: si el mail no sale, hay que saber por qué.
      setError(
        err.message.toLowerCase().includes("rate")
          ? "Ya se pidió un mail hace poco. Esperá unos minutos y probá de nuevo."
          : `No pudimos enviar el mail (${err.message}).`,
      );
      return;
    }
    setAviso("Te mandamos un mail para crear una contraseña nueva. Revisá también el spam.");
  }

  return (
    <Portada>
      <h1 className="text-[16px] font-semibold">Entrar</h1>
      <p className="mt-1 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
        Cada persona entra con su propio usuario. Ojo: la contraseña del sistema anterior no vale
        acá, son dos bases distintas.
      </p>

      <form onSubmit={entrar} className="mt-5 space-y-3">
        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Email
          </label>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
            style={inputStyle}
            required
          />
        </div>
        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Contraseña
          </label>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
            style={inputStyle}
            required
          />
        </div>

        {error && (
          <p className="text-[12px]" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
        {aviso && (
          <p className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            {aviso}
          </p>
        )}

        <button
          type="submit"
          disabled={enviando}
          className="mt-1 h-9 w-full rounded-md text-[13px] font-medium text-white disabled:opacity-60"
          style={{ background: "var(--primary)" }}
        >
          {enviando ? "Entrando…" : "Entrar"}
        </button>
      </form>

      <button
        onClick={recuperar}
        className="mt-3 w-full text-[12px]"
        style={{ color: "var(--muted-foreground)" }}
      >
        Olvidé mi contraseña
      </button>
    </Portada>
  );
}

/**
 * Se abre al volver del mail de recuperación. La contraseña la escribe
 * únicamente la persona dueña de la cuenta: el sistema nunca la genera
 * ni la guarda en ningún lado propio.
 */
function PantallaNuevaPassword() {
  const { cambiarMiPassword, cerrarSesion, esInvitacion } = useSesion();
  const [nueva, setNueva] = useState("");
  const [repetida, setRepetida] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (nueva !== repetida) {
      setError("Las dos contraseñas no coinciden.");
      return;
    }
    if (nueva.length < 6) {
      setError("Tiene que tener al menos 6 caracteres.");
      return;
    }
    setError(null);
    setEnviando(true);
    const r = await cambiarMiPassword(nueva);
    setEnviando(false);
    setNueva("");
    setRepetida("");
    if (!r.ok) setError(r.error ?? "No se pudo guardar.");
  }

  return (
    <Portada>
      <div
        className="grid h-10 w-10 place-items-center rounded-full"
        style={{ background: "var(--warning-bg)", color: "var(--warning)" }}
      >
        <KeyRound size={18} />
      </div>
      <h1 className="mt-3 text-[16px] font-semibold">
        {esInvitacion ? "Bienvenido: elegí tu contraseña" : "Elegí una contraseña nueva"}
      </h1>
      <p className="mt-1 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
        {esInvitacion
          ? "La elegís vos y no la ve nadie más, tampoco quien te invitó. Con esta contraseña vas a entrar de acá en adelante."
          : "Es la contraseña de este sistema. Si tenías otra en el sistema anterior, no sirve acá: son dos bases distintas."}
      </p>

      <form onSubmit={guardar} className="mt-5 space-y-3">
        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Contraseña nueva
          </label>
          <input
            type="password"
            autoComplete="new-password"
            value={nueva}
            onChange={(e) => setNueva(e.target.value)}
            className={inputCls}
            style={inputStyle}
            required
          />
        </div>
        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Repetila
          </label>
          <input
            type="password"
            autoComplete="new-password"
            value={repetida}
            onChange={(e) => setRepetida(e.target.value)}
            className={inputCls}
            style={inputStyle}
            required
          />
        </div>

        {error && (
          <p className="text-[12px]" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={enviando}
          className="mt-1 h-9 w-full rounded-md text-[13px] font-medium text-white disabled:opacity-60"
          style={{ background: "var(--primary)" }}
        >
          {enviando ? "Guardando…" : "Guardar y entrar"}
        </button>
      </form>

      <button
        onClick={() => void cerrarSesion()}
        className="mt-3 w-full text-[12px]"
        style={{ color: "var(--muted-foreground)" }}
      >
        Cancelar
      </button>
    </Portada>
  );
}

function PantallaSucursalEquipo() {
  const { sucursales, usuario, sucursalEquipoId, configurarSucursalEquipo, cerrarSesion } =
    useSesion();
  const [elegida, setElegida] = useState<string | null>(sucursalEquipoId);
  const [email, setEmail] = useState(usuario?.rol === "dueno" ? usuario.email : "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const activas = sucursales.filter((s) => s.activa);

  async function confirmar(e: React.FormEvent) {
    e.preventDefault();
    if (!elegida) {
      setError("Elegí una sucursal.");
      return;
    }
    setError(null);
    setEnviando(true);
    const r = await configurarSucursalEquipo(elegida, email, password);
    setEnviando(false);
    setPassword("");
    if (!r.ok) setError(r.error ?? "No se pudo configurar.");
  }

  return (
    <Portada>
      <div
        className="grid h-10 w-10 place-items-center rounded-full"
        style={{ background: "var(--warning-bg)", color: "var(--warning)" }}
      >
        <MapPin size={18} />
      </div>
      <h1 className="mt-3 text-[16px] font-semibold">Configurá la sucursal de este equipo</h1>
      <p className="mt-1 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
        Todo lo que se cargue desde esta computadora —ventas, gastos, caja— va a quedar en la
        sucursal que elijas. Se configura una sola vez.
      </p>

      <form onSubmit={confirmar} className="mt-5 space-y-3">
        <div className="space-y-2">
          {activas.map((s) => {
            const sel = elegida === s.id;
            return (
              <button
                type="button"
                key={s.id}
                onClick={() => setElegida(s.id)}
                className="flex w-full items-center gap-3 rounded-md border p-3 text-left"
                style={{
                  borderColor: sel ? "var(--primary)" : "var(--border)",
                  background: sel ? "#fdf3ef" : "transparent",
                }}
              >
                <Building2 size={16} style={{ color: "var(--muted-foreground)" }} />
                <div>
                  <div className="text-[13px] font-medium">{s.nombre}</div>
                  <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                    {s.direccion}
                  </div>
                </div>
              </button>
            );
          })}
          {activas.length === 0 && (
            <p className="text-[13px]" style={{ color: "var(--muted-foreground)" }}>
              Todavía no hay sucursales cargadas.
            </p>
          )}
        </div>

        <div className="rounded-md border p-3" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-1.5 text-[12px] font-medium">
            <Lock size={13} />
            Autorización del dueño
          </div>
          <p className="mt-1 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Solo un dueño puede fijar o cambiar la sucursal de un equipo.
          </p>
          <div className="mt-2 grid gap-2">
            <input
              type="email"
              placeholder="Email del dueño"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
              style={inputStyle}
              required
            />
            <input
              type="password"
              placeholder="Contraseña"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
              style={inputStyle}
              required
            />
          </div>
        </div>

        {error && (
          <p className="text-[12px]" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={enviando}
          className="h-9 w-full rounded-md text-[13px] font-medium text-white disabled:opacity-60"
          style={{ background: "var(--primary)" }}
        >
          {enviando ? "Verificando…" : "Activar sucursal en este equipo"}
        </button>
      </form>

      <button
        onClick={() => void cerrarSesion()}
        className="mt-3 w-full text-[12px]"
        style={{ color: "var(--muted-foreground)" }}
      >
        Cerrar sesión
      </button>
    </Portada>
  );
}

/**
 * Antes de que exista una sola venta el sistema tiene que saber dos cosas,
 * y no deja hacer nada hasta saberlas: quién está operando y en qué sucursal.
 *
 * Ojo con lo que NO se chequea acá: si alguien asignado a Sucursal 1 entra en la
 * computadora de Sucursal 2, opera en la 2. Manda el equipo, no la persona
 * (decisión del dueño). `usuarios.sucursal_id` es la sucursal de referencia de
 * cada uno, no un permiso: quien reemplaza un día en el otro local carga ahí sin
 * que nadie tenga que reconfigurar nada.
 */
export function Guardia({ children }: { children: ReactNode }) {
  const { cargando, usuario, sucursalEquipoId, sucursalEquipo, sucursales, recuperando } =
    useSesion();

  if (cargando) return <Cargando />;
  // Va antes que todo: el link de recuperación trae sesión válida, pero
  // hasta que no elija contraseña nueva no entra al sistema.
  if (recuperando) return <PantallaNuevaPassword />;
  if (!usuario) return <PantallaLogin />;
  if (!sucursalEquipoId || (sucursales.length > 0 && !sucursalEquipo))
    return <PantallaSucursalEquipo />;

  return <>{children}</>;
}

export { PantallaSucursalEquipo };
