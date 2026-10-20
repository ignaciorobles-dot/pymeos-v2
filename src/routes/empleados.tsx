import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/layout/AppShell";
import { Chip } from "@/components/ui-bits/Chip";
import {
  Alerta,
  BotonPrimario,
  BotonSecundario,
  Modal,
  inputCls,
  inputStyle,
} from "@/components/ui-bits/Modal";
import { ROL_LABEL, useSesion, type Rol } from "@/lib/sesion";
import { supa } from "@/lib/supabase";
import { Loader2, Mail, ShieldAlert, UserPlus, X } from "lucide-react";

export const Route = createFileRoute("/empleados")({
  head: () => ({
    meta: [
      { title: "Empleados — PymeOS" },
      { name: "description", content: "Personal del negocio: roles, sucursales y estado." },
    ],
  }),
  component: Empleados,
});

type Empleado = {
  user_id: string;
  nombre: string;
  rol: Rol;
  sucursal_id: string | null;
  activo: boolean;
  email: string;
  confirmado: boolean;
};

const ROL_TONE: Record<Rol, "violet" | "warning" | "success"> = {
  dueno: "violet",
  vendedor: "success",
  contador: "warning",
};

/**
 * Tres estados, no dos. "Pendiente" es el que más importa: la invitación salió
 * pero la persona nunca eligió su contraseña, así que todavía no puede entrar.
 * Sin mostrarlo, un dueño creería que dio de alta a alguien que en realidad
 * nunca llegó al sistema.
 */
function estadoDe(e: Empleado): { texto: string; tono: "success" | "danger" | "warning" } {
  if (!e.activo) return { texto: "inactivo", tono: "danger" };
  if (!e.confirmado) return { texto: "pendiente", tono: "warning" };
  return { texto: "activo", tono: "success" };
}

function iniciales(nombre: string) {
  return nombre
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function Empleados() {
  const { usuario, sucursales, recargarUsuario } = useSesion();
  const [empleados, setEmpleados] = useState<Empleado[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [invitando, setInvitando] = useState(false);
  const [editando, setEditando] = useState<Empleado | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const esDueno = usuario?.rol === "dueno";

  const cargar = useCallback(async () => {
    const { data, error } = await supa
      .from("usuarios")
      .select("user_id, nombre, rol, sucursal_id, activo, email, confirmado")
      .order("nombre");

    if (error) setErrorCarga(error.message);
    else {
      setErrorCarga(null);
      setEmpleados((data ?? []) as Empleado[]);
    }
    setCargando(false);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const nombreSucursal = (id: string | null) =>
    id ? (sucursales.find((s) => s.id === id)?.alias ?? "sucursal borrada") : "Todas";

  if (cargando) {
    return (
      <div className="flex h-40 items-center justify-center gap-2 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
        <Loader2 size={16} className="animate-spin" /> Cargando el equipo…
      </div>
    );
  }

  const activos = empleados.filter((e) => e.activo && e.confirmado).length;
  const pendientes = empleados.filter((e) => e.activo && !e.confirmado).length;

  return (
    <>
      <PageHeader
        title="Empleados"
        subtitle={
          `${empleados.length} ${empleados.length === 1 ? "persona" : "personas"} · ${activos} ${activos === 1 ? "activa" : "activas"}` +
          (pendientes > 0 ? ` · ${pendientes} sin aceptar la invitación` : "")
        }
        actions={
          esDueno ? (
            <button
              onClick={() => setInvitando(true)}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white"
              style={{ background: "var(--primary)" }}
            >
              <UserPlus size={14} /> Invitar por email
            </button>
          ) : undefined
        }
      />

      {errorCarga && (
        <div
          className="mb-3 rounded-md px-3 py-2 text-[12px]"
          style={{ background: "var(--danger-bg)", color: "var(--danger)" }}
        >
          No se pudo leer el equipo: {errorCarga}
        </div>
      )}

      {aviso && (
        <div
          className="mb-3 flex items-center justify-between gap-3 rounded-md px-3 py-2 text-[12px]"
          style={{ background: "#fdf3ef", color: "var(--primary)" }}
        >
          <span>{aviso}</span>
          <button onClick={() => setAviso(null)} aria-label="Cerrar aviso">
            <X size={13} />
          </button>
        </div>
      )}

      <div className="grid grid-cols-4 gap-3">
        {empleados.map((e) => {
          const estado = estadoDe(e);
          return (
            <div key={e.user_id} className="card-surface p-4">
              <div className="flex items-center gap-3">
                <div
                  className="grid h-11 w-11 place-items-center rounded-full text-[14px] font-semibold text-white"
                  style={{ background: "var(--sidebar-active)" }}
                >
                  {iniciales(e.nombre)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold">{e.nombre}</div>
                  <div className="truncate text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                    {e.email}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Chip tone={ROL_TONE[e.rol]}>{ROL_LABEL[e.rol]}</Chip>
                <Chip tone="neutral">{nombreSucursal(e.sucursal_id)}</Chip>
                <Chip tone={estado.tono}>{estado.texto}</Chip>
              </div>
              {esDueno && (
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => setEditando(e)}
                    className="flex-1 rounded-md border py-1.5 text-[12px]"
                    style={inputStyle}
                  >
                    Editar
                  </button>
                  <BotonReenviar empleado={e} onAviso={setAviso} />
                </div>
              )}
            </div>
          );
        })}

        {esDueno && (
          <button
            onClick={() => setInvitando(true)}
            className="card-surface flex flex-col items-center justify-center gap-2 p-6 text-[13px]"
            style={{ borderStyle: "dashed", color: "var(--muted-foreground)" }}
          >
            <UserPlus size={20} />
            Invitar empleado nuevo
          </button>
        )}
      </div>

      <div className="mt-4 card-surface p-4">
        <div className="flex items-start gap-3">
          <div
            className="grid h-9 w-9 place-items-center rounded-md"
            style={{ background: "var(--violet-bg)", color: "var(--violet)" }}
          >
            <Mail size={16} />
          </div>
          <div>
            <div className="text-[13px] font-semibold">Los empleados se dan de alta solo por invitación</div>
            <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              Nunca vas a ver ni configurar contraseñas desde acá. Cada persona crea su propia clave
              desde el link que llega al mail.
            </div>
          </div>
        </div>
      </div>

      {invitando && (
        <DialogoInvitar
          onCerrar={() => setInvitando(false)}
          onListo={(msg) => {
            setInvitando(false);
            setAviso(msg);
            void cargar();
          }}
        />
      )}

      {editando && (
        <DialogoEditar
          empleado={editando}
          esMiPropiaFila={editando.user_id === usuario?.user_id}
          onCerrar={() => setEditando(null)}
          onListo={(msg) => {
            setEditando(null);
            setAviso(msg);
            void cargar();
            // Si el dueño se editó a sí mismo, la sesión tiene datos viejos.
            void recargarUsuario();
          }}
        />
      )}
    </>
  );
}

/** Llama a la Edge Function: invitar gente necesita permisos que el navegador no tiene. */
async function llamarInvitar(cuerpo: Record<string, unknown>) {
  const { data: sesion } = await supa.auth.getSession();
  const token = sesion.session?.access_token;
  if (!token) return { ok: false as const, error: "Se cerró la sesión. Volvé a entrar." };

  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invitar-empleado`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_KEY as string,
    },
    body: JSON.stringify({ ...cuerpo, redirect_to: window.location.origin }),
  });

  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) return { ok: false as const, error: json.error ?? "No se pudo completar." };
  return { ok: true as const };
}

function BotonReenviar({
  empleado,
  onAviso,
}: {
  empleado: Empleado;
  onAviso: (m: string) => void;
}) {
  const [enviando, setEnviando] = useState(false);

  // Reenviar solo tiene sentido mientras la invitación no se aceptó. A quien ya
  // entró y olvidó la clave le sirve "Olvidé mi contraseña", no otra invitación.
  const sirve = !empleado.confirmado;

  return (
    <button
      disabled={!sirve || enviando}
      title={sirve ? "Reenviar la invitación" : "Ya aceptó la invitación"}
      onClick={async () => {
        setEnviando(true);
        const r = await llamarInvitar({ accion: "reenviar", email: empleado.email });
        setEnviando(false);
        onAviso(r.ok ? `Invitación reenviada a ${empleado.email}.` : (r.error ?? "No se pudo."));
      }}
      className="grid w-9 place-items-center rounded-md border disabled:opacity-40"
      style={inputStyle}
    >
      {enviando ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
    </button>
  );
}

function DialogoInvitar({
  onCerrar,
  onListo,
}: {
  onCerrar: () => void;
  onListo: (mensaje: string) => void;
}) {
  const { sucursales } = useSesion();
  const [nombre, setNombre] = useState("");
  const [email, setEmail] = useState("");
  const [rol, setRol] = useState<Rol>("vendedor");
  const [sucursalId, setSucursalId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);
    setEnviando(true);
    const r = await llamarInvitar({
      nombre,
      email,
      rol,
      sucursal_id: sucursalId === "" ? null : sucursalId,
    });
    setEnviando(false);
    if (r.ok) onListo(`Invitación enviada a ${email.trim().toLowerCase()}.`);
    else setError(r.error ?? "No se pudo enviar.");
  }

  return (
    <Modal titulo="Invitar empleado" onCerrar={onCerrar}>
      <form onSubmit={enviar} className="space-y-3">
        <label className="block text-[12px] font-medium">
          Nombre y apellido
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
            className={inputCls}
            style={inputStyle}
            placeholder="Pedro Gómez"
          />
        </label>

        <label className="block text-[12px] font-medium">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={inputCls}
            style={inputStyle}
            placeholder="pedro@ejemplo.com"
          />
        </label>

        <label className="block text-[12px] font-medium">
          Rol
          <select
            value={rol}
            onChange={(e) => setRol(e.target.value as Rol)}
            className={inputCls}
            style={inputStyle}
          >
            <option value="vendedor">Vendedor</option>
            <option value="contador">Contador</option>
            <option value="dueno">Dueño</option>
          </select>
        </label>

        <label className="block text-[12px] font-medium">
          Sucursal de referencia
          <select
            value={sucursalId}
            onChange={(e) => setSucursalId(e.target.value)}
            className={inputCls}
            style={inputStyle}
          >
            <option value="">Todas (sin sucursal fija)</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.alias}
              </option>
            ))}
          </select>
          <span className="mt-1 block font-normal" style={{ color: "var(--muted-foreground)" }}>
            Es dónde trabaja habitualmente, no un permiso. Si un día atiende en el otro local, sus
            movimientos se guardan en la sucursal de esa computadora.
          </span>
        </label>

        {rol === "dueno" && (
          <div
            className="flex items-start gap-2 rounded-md px-3 py-2 text-[12px]"
            style={{ background: "var(--warning-bg)", color: "var(--warning)" }}
          >
            <ShieldAlert size={14} className="mt-px shrink-0" />
            Un dueño puede invitar y dar de baja gente, cambiar la sucursal de cualquier equipo y
            ver todo el negocio.
          </div>
        )}

        {error && <Alerta tono="danger">{error}</Alerta>}

        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando}>Enviar invitación</BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

function DialogoEditar({
  empleado,
  esMiPropiaFila,
  onCerrar,
  onListo,
}: {
  empleado: Empleado;
  esMiPropiaFila: boolean;
  onCerrar: () => void;
  onListo: (mensaje: string) => void;
}) {
  const { sucursales } = useSesion();
  const [nombre, setNombre] = useState(empleado.nombre);
  const [rol, setRol] = useState<Rol>(empleado.rol);
  const [sucursalId, setSucursalId] = useState(empleado.sucursal_id ?? "");
  const [activo, setActivo] = useState(empleado.activo);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function guardar(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);
    setGuardando(true);

    const { error: err } = await supa
      .from("usuarios")
      .update({
        nombre: nombre.trim(),
        rol,
        sucursal_id: sucursalId === "" ? null : sucursalId,
        activo,
      })
      .eq("user_id", empleado.user_id);

    setGuardando(false);
    // El error del último dueño llega desde la base, no de la UI: es la barrera
    // real. Se muestra tal cual porque ya viene escrito para que se entienda.
    if (err) setError(err.message);
    else onListo(`Cambios guardados en ${nombre.trim()}.`);
  }

  return (
    <Modal titulo={`Editar a ${empleado.nombre}`} onCerrar={onCerrar}>
      <form onSubmit={guardar} className="space-y-3">
        <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
          {empleado.email}
          {!empleado.confirmado && " · todavía no aceptó la invitación"}
        </div>

        <label className="block text-[12px] font-medium">
          Nombre y apellido
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
            className={inputCls}
            style={inputStyle}
          />
        </label>

        <label className="block text-[12px] font-medium">
          Rol
          <select
            value={rol}
            onChange={(e) => setRol(e.target.value as Rol)}
            className={inputCls}
            style={inputStyle}
          >
            <option value="vendedor">Vendedor</option>
            <option value="contador">Contador</option>
            <option value="dueno">Dueño</option>
          </select>
        </label>

        <label className="block text-[12px] font-medium">
          Sucursal de referencia
          <select
            value={sucursalId}
            onChange={(e) => setSucursalId(e.target.value)}
            className={inputCls}
            style={inputStyle}
          >
            <option value="">Todas (sin sucursal fija)</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.alias}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-[12px] font-medium">
          <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} />
          Puede entrar al sistema
        </label>
        <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
          Desactivar no borra nada: las ventas que haya hecho siguen ahí, con su nombre. Deja de
          poder entrar, nada más.
        </div>

        {esMiPropiaFila && (
          <div
            className="flex items-start gap-2 rounded-md px-3 py-2 text-[12px]"
            style={{ background: "var(--warning-bg)", color: "var(--warning)" }}
          >
            <ShieldAlert size={14} className="mt-px shrink-0" />
            Este sos vos. Si te sacás el rol de dueño o te desactivás, perdés el acceso a esta
            pantalla.
          </div>
        )}

        {error && <Alerta tono="danger">{error}</Alerta>}

        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={guardando}>Guardar</BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

