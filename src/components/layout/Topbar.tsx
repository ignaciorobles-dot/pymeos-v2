import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Bell,
  Building2,
  ChevronDown,
  Eye,
  FileText,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Package,
  Search,
  User,
} from "lucide-react";
import { ROL_LABEL, RUTAS_POR_ROL, useSesion, useSucursalOperativa } from "@/lib/sesion";
import { useAvisos, type Aviso } from "@/lib/avisos";
import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";

export function Topbar() {
  const { usuario, sucursalEquipo, verTodas, setVerTodas, puedeVerTodas } = useSesion();
  const [cambiando, setCambiando] = useState(false);

  if (!usuario) return null;

  return (
    <div
      className="sticky top-0 z-10 flex h-14 items-center gap-3 px-6"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
    >
      {/* La sucursal no se elige por operación: es la del equipo. */}
      <div
        className="flex h-9 items-center gap-2 rounded-md border px-3 text-[13px] font-medium"
        style={{ borderColor: "var(--border)" }}
      >
        <Building2 size={14} style={{ color: "var(--muted-foreground)" }} />
        {sucursalEquipo?.nombre ?? "Sin sucursal"}
        <button
          onClick={() => setCambiando(true)}
          className="ml-1 text-[12px] font-normal"
          style={{ color: "var(--muted-foreground)" }}
          title="Requiere autorización de un dueño"
        >
          Cambiar
        </button>
      </div>

      {puedeVerTodas && (
        <button
          onClick={() => setVerTodas(!verTodas)}
          className="flex h-9 items-center gap-1.5 rounded-md border px-3 text-[12px]"
          style={{
            borderColor: verTodas ? "var(--primary)" : "var(--border)",
            color: verTodas ? "var(--primary)" : "var(--muted-foreground)",
          }}
          title="Solo para mirar. Para operar siempre hay una sucursal activa."
        >
          <Eye size={13} />
          Ver las dos
        </button>
      )}

      <Buscador />

      <div className="ml-auto flex items-center gap-2">
        <Campana />
        <MenuUsuario />
      </div>

      {cambiando && <DialogoCambiarSucursal onCerrar={() => setCambiando(false)} />}
    </div>
  );
}

/** Cierra el panel al tocar afuera o al apretar Escape. */
function useCerrarAfuera(abierto: boolean, cerrar: () => void) {
  const caja = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!abierto) return;
    const afuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) cerrar();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") cerrar();
    };
    document.addEventListener("mousedown", afuera);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", afuera);
      document.removeEventListener("keydown", escape);
    };
  }, [abierto, cerrar]);

  return caja;
}

/* ── Buscador global ───────────────────────────────────────────────────── */

type Resultado = {
  id: string;
  tipo: "producto" | "cliente" | "comprobante";
  titulo: string;
  detalle: string;
  ruta: string;
};

function Buscador() {
  const { usuario } = useSesion();
  const navegar = useNavigate();
  const [texto, setTexto] = useState("");
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [abierto, setAbierto] = useState(false);
  const caja = useCerrarAfuera(abierto, () => setAbierto(false));

  const permitidas = usuario ? RUTAS_POR_ROL[usuario.rol] : [];

  useEffect(() => {
    const q = texto.trim();
    if (q.length < 2) {
      setResultados([]);
      setBuscando(false);
      return;
    }
    // Se espera a que deje de escribir: una consulta por letra serían seis
    // viajes a la base para buscar "zapati".
    setBuscando(true);
    const t = setTimeout(() => {
      void (async () => {
        const patron = `%${q}%`;
        // No se consulta lo que el rol no puede abrir: un vendedor no tiene por
        // que gastar una consulta en comprobantes que no va a poder mirar.
        const vacio = Promise.resolve({ data: [] as unknown[] });
        const [prod, cli, comp] = await Promise.all([
          permitidas.includes("/stock")
            ? supa
                .from("productos")
                .select("id, nombre, marca")
                .eq("activo", true)
                .or(`nombre.ilike.${patron},marca.ilike.${patron}`)
                .limit(5)
            : vacio,
          permitidas.includes("/clientes")
            ? supa
                .from("clientes")
                .select("id, nombre, telefono, documento, saldo")
                .eq("activo", true)
                .or(`nombre.ilike.${patron},telefono.ilike.${patron},documento.ilike.${patron}`)
                .limit(5)
            : vacio,
          permitidas.includes("/facturacion")
            ? supa
                .from("comprobantes")
                .select("id, tipo, punto_venta, numero, receptor_nombre, total")
                .or(`receptor_nombre.ilike.${patron},cae.ilike.${patron}`)
                .limit(5)
            : vacio,
        ]);

        const filas: Resultado[] = [];

        for (const p of (prod.data ?? []) as { id: string; nombre: string; marca: string | null }[]) {
          filas.push({
            id: `p-${p.id}`,
            tipo: "producto",
            titulo: p.nombre,
            detalle: p.marca ?? "Sin marca",
            ruta: "/stock",
          });
        }

        for (const c of (cli.data ?? []) as {
          id: string;
          nombre: string;
          telefono: string | null;
          saldo: number | null;
        }[]) {
          filas.push({
            id: `c-${c.id}`,
            tipo: "cliente",
            titulo: c.nombre,
            // El saldo es lo primero que se quiere saber de un cliente que debe.
            detalle:
              Number(c.saldo ?? 0) !== 0
                ? `Saldo ${formatARS(Number(c.saldo))}`
                : (c.telefono ?? "Sin teléfono"),
            ruta: "/clientes",
          });
        }

        for (const c of (comp.data ?? []) as {
          id: string;
          tipo: string;
          punto_venta: number;
          numero: number | null;
          receptor_nombre: string;
          total: number;
        }[]) {
          const nro =
            c.numero === null
              ? "sin número"
              : `${String(c.punto_venta).padStart(5, "0")}-${String(c.numero).padStart(8, "0")}`;
          filas.push({
            id: `f-${c.id}`,
            tipo: "comprobante",
            titulo: `${c.tipo} ${nro}`,
            detalle: `${c.receptor_nombre} · ${formatARS(Number(c.total))}`,
            ruta: "/facturacion",
          });
        }

        setResultados(filas);
        setBuscando(false);
      })();
    }, 250);
    return () => clearTimeout(t);
    // permitidas se rearma en cada render pero su contenido depende del rol.
  }, [texto, usuario]);

  function ir(r: Resultado) {
    setAbierto(false);
    setTexto("");
    // Se abre la pantalla ya filtrada: llegar a una lista de mil filas para
    // volver a escribir lo mismo sería hacer el trabajo dos veces.
    void navegar({ to: r.ruta, search: { q: r.titulo } });
  }

  const ICONO = {
    producto: Package,
    cliente: User,
    comprobante: FileText,
  } as const;

  return (
    <div className="relative max-w-md flex-1" ref={caja}>
      <Search
        size={14}
        className="absolute left-2.5 top-1/2 -translate-y-1/2"
        style={{ color: "var(--muted-foreground)" }}
      />
      <input
        value={texto}
        onChange={(e) => {
          setTexto(e.target.value);
          setAbierto(true);
        }}
        onFocus={() => setAbierto(true)}
        placeholder="Buscar productos, clientes, comprobantes…"
        className="h-9 w-full rounded-md border pl-8 pr-3 text-[13px] outline-none"
        style={{ borderColor: "var(--border)", background: "#f9fafc" }}
      />

      {abierto && texto.trim().length >= 2 && (
        <div
          className="card-surface absolute left-0 right-0 top-11 z-20 overflow-hidden p-1"
          style={{ boxShadow: "0 8px 24px rgba(16,24,40,.12)" }}
        >
          {buscando ? (
            <div
              className="flex items-center gap-2 px-3 py-3 text-[12px]"
              style={{ color: "var(--muted-foreground)" }}
            >
              <Loader2 size={13} className="animate-spin" /> Buscando…
            </div>
          ) : resultados.length === 0 ? (
            <div className="px-3 py-3 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              No encontré nada con “{texto.trim()}”.
            </div>
          ) : (
            resultados.map((r) => {
              const Icono = ICONO[r.tipo];
              return (
                <button
                  key={r.id}
                  onClick={() => ir(r)}
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left hover:bg-[#f4f6fa]"
                >
                  <Icono size={14} style={{ color: "var(--muted-foreground)" }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{r.titulo}</span>
                    <span
                      className="block truncate text-[11px]"
                      style={{ color: "var(--muted-foreground)" }}
                    >
                      {r.detalle}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/* ── Campana de avisos ─────────────────────────────────────────────────── */

function Campana() {
  const navegar = useNavigate();
  const { avisos, cargando } = useAvisos();
  const [abierto, setAbierto] = useState(false);
  const caja = useCerrarAfuera(abierto, () => setAbierto(false));

  const urgentes = avisos.filter((a) => a.tono === "danger").length;

  return (
    <div className="relative" ref={caja}>
      <button
        onClick={() => setAbierto(!abierto)}
        className="relative grid h-9 w-9 place-items-center rounded-md border"
        style={{ borderColor: "var(--border)" }}
        title={avisos.length === 0 ? "No hay nada pendiente" : `${avisos.length} avisos`}
      >
        <Bell size={14} />
        {avisos.length > 0 && (
          <span
            className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold text-white"
            style={{ background: urgentes > 0 ? "var(--danger)" : "var(--primary)" }}
          >
            {avisos.length}
          </span>
        )}
      </button>

      {abierto && (
        <div
          className="card-surface absolute right-0 top-11 z-20 w-80 overflow-hidden"
          style={{ boxShadow: "0 8px 24px rgba(16,24,40,.12)" }}
        >
          <div
            className="px-4 py-2.5 text-[12px] font-semibold"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            Pendientes
          </div>

          {cargando ? (
            <div
              className="flex items-center gap-2 px-4 py-4 text-[12px]"
              style={{ color: "var(--muted-foreground)" }}
            >
              <Loader2 size={13} className="animate-spin" /> Revisando…
            </div>
          ) : avisos.length === 0 ? (
            <div className="px-4 py-4 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              No hay nada esperando. Todo al día.
            </div>
          ) : (
            avisos.map((a) => (
              <ItemAviso
                key={a.id}
                aviso={a}
                onIr={() => {
                  setAbierto(false);
                  void navegar({ to: a.ruta });
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ItemAviso({ aviso, onIr }: { aviso: Aviso; onIr: () => void }) {
  const color =
    aviso.tono === "danger"
      ? "var(--danger)"
      : aviso.tono === "warning"
        ? "var(--warning)"
        : "var(--muted-foreground)";

  return (
    <button
      onClick={onIr}
      className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-[#f9fafc]"
      style={{ borderTop: "1px solid #eef1f6" }}
    >
      <span
        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: color }}
      />
      <span>
        <span className="block text-[12px] font-medium">{aviso.texto}</span>
        <span className="block text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          {aviso.detalle}
        </span>
      </span>
    </button>
  );
}

/* ── Menú del usuario ──────────────────────────────────────────────────── */

function MenuUsuario() {
  const { usuario, cerrarSesion } = useSesion();
  const sucursalOperativa = useSucursalOperativa();
  const [abierto, setAbierto] = useState(false);
  const [cambiandoPassword, setCambiandoPassword] = useState(false);
  const [saliendo, setSaliendo] = useState(false);
  const caja = useCerrarAfuera(abierto, () => setAbierto(false));

  if (!usuario) return null;

  return (
    <div className="relative" ref={caja}>
      <button
        onClick={() => setAbierto(!abierto)}
        className="flex items-center gap-2 rounded-md py-1 pl-2 pr-1 hover:bg-[#f9fafc]"
      >
        <div
          className="grid h-8 w-8 place-items-center rounded-full text-[12px] font-semibold text-white"
          style={{ background: "var(--sidebar-active)" }}
        >
          {usuario.nombre.charAt(0).toUpperCase()}
        </div>
        <div className="text-left text-[12px] leading-tight">
          <div className="font-semibold">{usuario.nombre}</div>
          <div style={{ color: "var(--muted-foreground)" }}>{ROL_LABEL[usuario.rol]}</div>
        </div>
        <ChevronDown size={13} style={{ color: "var(--muted-foreground)" }} />
      </button>

      {abierto && (
        <div
          className="card-surface absolute right-0 top-12 z-20 w-64 overflow-hidden"
          style={{ boxShadow: "0 8px 24px rgba(16,24,40,.12)" }}
        >
          <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="text-[13px] font-semibold">{usuario.nombre}</div>
            <div className="truncate text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              {usuario.email}
            </div>
            <div className="mt-1 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
              {ROL_LABEL[usuario.rol]} ·{" "}
              {sucursalOperativa ? sucursalOperativa.nombre : "Mirando las dos sucursales"}
            </div>
          </div>

          <button
            onClick={() => {
              setAbierto(false);
              setCambiandoPassword(true);
            }}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] hover:bg-[#f9fafc]"
          >
            <KeyRound size={14} style={{ color: "var(--muted-foreground)" }} />
            Cambiar mi contraseña
          </button>

          <button
            onClick={() => {
              setSaliendo(true);
              void cerrarSesion();
            }}
            disabled={saliendo}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] hover:bg-[#f9fafc]"
            style={{ borderTop: "1px solid #eef1f6", color: "var(--danger)" }}
          >
            <LogOut size={14} />
            {saliendo ? "Cerrando…" : "Cerrar sesión"}
          </button>
        </div>
      )}

      {cambiandoPassword && <DialogoMiPassword onCerrar={() => setCambiandoPassword(false)} />}
    </div>
  );
}

function DialogoMiPassword({ onCerrar }: { onCerrar: () => void }) {
  const { cambiarMiPassword } = useSesion();
  const [nueva, setNueva] = useState("");
  const [repetida, setRepetida] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState(false);
  const [enviando, setEnviando] = useState(false);

  async function confirmar(e: React.FormEvent) {
    e.preventDefault();
    if (nueva.length < 8) return setError("Poné al menos 8 caracteres.");
    if (nueva !== repetida) return setError("Las dos no coinciden.");
    setError(null);
    setEnviando(true);
    const r = await cambiarMiPassword(nueva);
    setEnviando(false);
    if (r.ok) {
      setListo(true);
      setTimeout(onCerrar, 1400);
    } else setError(r.error ?? "No se pudo cambiar.");
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center px-4"
      style={{ background: "rgba(15,18,26,.45)" }}
    >
      <div className="card-surface w-full max-w-sm p-5">
        <h2 className="text-[15px] font-semibold">Cambiar mi contraseña</h2>
        <p className="mt-1 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
          La sesión abierta sigue funcionando. La contraseña nueva vale para la próxima vez que
          entres.
        </p>

        {listo ? (
          <p className="mt-4 text-[13px]" style={{ color: "var(--success)" }}>
            Listo, ya quedó cambiada.
          </p>
        ) : (
          <form onSubmit={confirmar} className="mt-4 space-y-2">
            <input
              type="password"
              placeholder="Contraseña nueva"
              autoComplete="new-password"
              value={nueva}
              onChange={(e) => setNueva(e.target.value)}
              className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
              style={{ borderColor: "var(--border)" }}
              required
            />
            <input
              type="password"
              placeholder="Repetila"
              autoComplete="new-password"
              value={repetida}
              onChange={(e) => setRepetida(e.target.value)}
              className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
              style={{ borderColor: "var(--border)" }}
              required
            />

            {error && (
              <p className="text-[12px]" style={{ color: "var(--danger)" }}>
                {error}
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={onCerrar}
                className="h-9 flex-1 rounded-md border text-[13px]"
                style={{ borderColor: "var(--border)" }}
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={enviando}
                className="h-9 flex-1 rounded-md text-[13px] font-medium text-white disabled:opacity-60"
                style={{ background: "var(--primary)" }}
              >
                {enviando ? "Guardando…" : "Cambiar"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function DialogoCambiarSucursal({ onCerrar }: { onCerrar: () => void }) {
  const { sucursales, sucursalEquipoId, configurarSucursalEquipo } = useSesion();
  const [elegida, setElegida] = useState<string | null>(sucursalEquipoId);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function confirmar(e: React.FormEvent) {
    e.preventDefault();
    if (!elegida) return setError("Elegí una sucursal.");
    setError(null);
    setEnviando(true);
    const r = await configurarSucursalEquipo(elegida, email, password);
    setEnviando(false);
    setPassword("");
    if (r.ok) onCerrar();
    else setError(r.error ?? "No se pudo cambiar.");
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center px-4" style={{ background: "rgba(15,18,26,.45)" }}>
      <div className="card-surface w-full max-w-sm p-5">
        <h2 className="text-[15px] font-semibold">Cambiar la sucursal de este equipo</h2>
        <p className="mt-1 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
          Desde el cambio, todo lo que se cargue en esta computadora queda en la sucursal nueva. Lo
          ya cargado no se mueve.
        </p>

        <form onSubmit={confirmar} className="mt-4 space-y-3">
          <div className="space-y-2">
            {sucursales
              .filter((s) => s.activa)
              .map((s) => {
                const sel = elegida === s.id;
                return (
                  <button
                    type="button"
                    key={s.id}
                    onClick={() => setElegida(s.id)}
                    className="flex w-full items-center gap-2.5 rounded-md border p-2.5 text-left text-[13px]"
                    style={{
                      borderColor: sel ? "var(--primary)" : "var(--border)",
                      background: sel ? "#fdf3ef" : "transparent",
                    }}
                  >
                    <Building2 size={14} style={{ color: "var(--muted-foreground)" }} />
                    {s.nombre}
                  </button>
                );
              })}
          </div>

          <div className="rounded-md border p-3" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center gap-1.5 text-[12px] font-medium">
              <Lock size={13} />
              Autorización del dueño
            </div>
            <div className="mt-2 grid gap-2">
              <input
                type="email"
                placeholder="Email del dueño"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
                style={{ borderColor: "var(--border)" }}
                required
              />
              <input
                type="password"
                placeholder="Contraseña"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
                style={{ borderColor: "var(--border)" }}
                required
              />
            </div>
          </div>

          {error && (
            <p className="text-[12px]" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCerrar}
              className="h-9 flex-1 rounded-md border text-[13px]"
              style={{ borderColor: "var(--border)" }}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={enviando}
              className="h-9 flex-1 rounded-md text-[13px] font-medium text-white disabled:opacity-60"
              style={{ background: "var(--primary)" }}
            >
              {enviando ? "Verificando…" : "Cambiar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
