import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Lock, MessageSquare, Plus, Search, Send, ShoppingBag, User } from "lucide-react";
import { PageHeader } from "@/components/layout/AppShell";
import { Chip } from "@/components/ui-bits/Chip";
import { Alerta, BotonPrimario, BotonSecundario, Modal, inputCls, inputStyle } from "@/components/ui-bits/Modal";
import { formatARS } from "@/lib/format";
import { supa } from "@/lib/supabase";
import { useSesion, useSucursalOperativa } from "@/lib/sesion";

/**
 * Atención al cliente: el registro de consultas y reclamos.
 *
 * No es un WhatsApp. Un chat real necesita la API de WhatsApp Business, que es
 * un trámite aparte. Lo que sirve desde el primer día es saber quién preguntó,
 * por dónde, sobre qué venta, quién lo atendió y cómo terminó. Por eso las
 * conversaciones las carga el mostrador a mano.
 *
 * La tabla está pensada para que el día que llegue la API los mensajes entren
 * solos acá adentro, sin cambiar la pantalla: una consulta con su hilo.
 *
 * El estado se mueve solo cuando alguien contesta. Nadie se acuerda de tocar un
 * desplegable, y una bandeja que miente sobre lo que está contestado no sirve.
 */

export const Route = createFileRoute("/atencion")({
  head: () => ({
    meta: [
      { title: "Atención al cliente — PymeOS" },
      { name: "description", content: "Consultas y reclamos: quién preguntó, por dónde y cómo terminó." },
    ],
  }),
  component: Atencion,
});

type Consulta = {
  id: string;
  numero: number;
  sucursal_id: string;
  cliente_id: string | null;
  nombre: string;
  telefono: string | null;
  email: string | null;
  canal: string;
  tipo: string;
  asunto: string;
  prioridad: string;
  estado: string;
  asignado_a: string | null;
  venta_id: string | null;
  pedido_online_id: string | null;
  resolucion: string | null;
  primera_respuesta_at: string | null;
  resuelta_at: string | null;
  created_at: string;
  actualizado_at: string;
};

type Mensaje = {
  id: string;
  autor: string;
  texto: string;
  usuario_id: string | null;
  created_at: string;
};

type UsuarioBreve = { user_id: string; nombre: string; rol: string };
type ClienteBreve = { id: string; nombre: string; telefono: string | null; email: string | null };
type VentaBreve = { id: string; numero: number; total: number; created_at: string };

const CANALES = [
  ["whatsapp", "WhatsApp"],
  ["instagram", "Instagram"],
  ["facebook", "Facebook"],
  ["telefono", "Teléfono"],
  ["email", "Email"],
  ["mostrador", "Mostrador"],
  ["tienda_online", "Tienda online"],
] as const;

const TIPOS = [
  ["consulta", "Consulta"],
  ["reclamo", "Reclamo"],
  ["cambio", "Cambio"],
  ["devolucion", "Devolución"],
  ["garantia", "Garantía"],
  ["otro", "Otro"],
] as const;

const PRIORIDADES = [
  ["baja", "Baja"],
  ["normal", "Normal"],
  ["alta", "Alta"],
] as const;

/**
 * statusTone no conoce estos cuatro estados, y no tiene por qué: son de esta
 * pantalla sola. El mapa vive acá.
 */
type Tono = "success" | "danger" | "warning" | "violet" | "neutral";

const ESTADOS: Record<string, { texto: string; tono: Tono }> = {
  abierta: { texto: "Sin responder", tono: "warning" },
  en_curso: { texto: "En curso", tono: "violet" },
  esperando: { texto: "Esperando al cliente", tono: "neutral" },
  resuelta: { texto: "Resuelta", tono: "success" },
};

const etiqueta = (pares: readonly (readonly [string, string])[], valor: string) =>
  pares.find(([v]) => v === valor)?.[1] ?? valor;

function Atencion() {
  const { usuario } = useSesion();
  const sucursal = useSucursalOperativa();
  const sucursalId = sucursal?.id ?? null;

  const [consultas, setConsultas] = useState<Consulta[]>([]);
  const [usuarios, setUsuarios] = useState<UsuarioBreve[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  const [seleccionada, setSeleccionada] = useState<string | null>(null);
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [cargandoHilo, setCargandoHilo] = useState(false);

  const [busqueda, setBusqueda] = useState("");
  const [filtro, setFiltro] = useState<"pendientes" | "todas" | "abierta" | "en_curso" | "esperando" | "resuelta">(
    "pendientes",
  );

  const [nueva, setNueva] = useState(false);
  const [resolviendo, setResolviendo] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    let q = supa
      .from("consultas")
      .select(
        "id, numero, sucursal_id, cliente_id, nombre, telefono, email, canal, tipo, asunto, prioridad, estado, asignado_a, venta_id, pedido_online_id, resolucion, primera_respuesta_at, resuelta_at, created_at, actualizado_at",
      )
      .order("actualizado_at", { ascending: false })
      .limit(300);
    if (sucursalId) q = q.eq("sucursal_id", sucursalId);

    const [c, u] = await Promise.all([
      q,
      supa.from("usuarios").select("user_id, nombre, rol").eq("activo", true).order("nombre"),
    ]);

    const fallo = c.error ?? u.error;
    if (fallo) setErrorCarga(fallo.message);
    else {
      setErrorCarga(null);
      setConsultas((c.data as Consulta[]) ?? []);
      setUsuarios((u.data as UsuarioBreve[]) ?? []);
    }
    setCargando(false);
  }, [sucursalId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const cargarHilo = useCallback(async (consultaId: string) => {
    setCargandoHilo(true);
    const { data, error } = await supa
      .from("consulta_mensajes")
      .select("id, autor, texto, usuario_id, created_at")
      .eq("consulta_id", consultaId)
      .order("created_at", { ascending: true });
    if (error) toast.error(error.message);
    else setMensajes((data as Mensaje[]) ?? []);
    setCargandoHilo(false);
  }, []);

  useEffect(() => {
    if (!seleccionada) {
      setMensajes([]);
      return;
    }
    void cargarHilo(seleccionada);
  }, [seleccionada, cargarHilo]);

  const visibles = useMemo(() => {
    const t = busqueda.trim().toLowerCase();
    return consultas.filter((c) => {
      if (filtro === "pendientes" && c.estado === "resuelta") return false;
      if (filtro !== "pendientes" && filtro !== "todas" && c.estado !== filtro) return false;
      if (!t) return true;
      return (
        c.nombre.toLowerCase().includes(t) ||
        c.asunto.toLowerCase().includes(t) ||
        (c.telefono ?? "").includes(t) ||
        String(c.numero) === t
      );
    });
  }, [consultas, busqueda, filtro]);

  // Si la seleccionada se cae del filtro, el panel de la derecha queda mostrando
  // algo que ya no está en la lista. Mejor soltarla.
  useEffect(() => {
    if (seleccionada && !visibles.some((c) => c.id === seleccionada)) setSeleccionada(null);
  }, [visibles, seleccionada]);

  const actual = consultas.find((c) => c.id === seleccionada) ?? null;
  const sinResolver = consultas.filter((c) => c.estado !== "resuelta").length;
  const nombreUsuario = (id: string | null) =>
    id ? usuarios.find((u) => u.user_id === id)?.nombre ?? "Alguien del equipo" : null;

  const refrescar = async (id: string) => {
    await cargar();
    await cargarHilo(id);
  };

  return (
    <>
      <PageHeader
        title="Atención al cliente"
        subtitle={
          cargando
            ? "Buscando consultas…"
            : `${consultas.length} ${consultas.length === 1 ? "consulta" : "consultas"} · ${sinResolver} sin resolver`
        }
        actions={
          <button
            onClick={() => setNueva(true)}
            disabled={!sucursalId}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-45"
            style={{ background: "var(--primary)" }}
            title={sucursalId ? undefined : "Elegí una sucursal para cargar consultas"}
          >
            <Plus size={14} /> Nueva consulta
          </button>
        }
      />

      {errorCarga && (
        <div className="mb-3">
          <Alerta tono="danger">No pudimos traer las consultas: {errorCarga}</Alerta>
        </div>
      )}

      {!sucursalId && (
        <div className="mb-3">
          <Alerta tono="info">
            Estás mirando las dos sucursales. Podés leer todo, pero para cargar una consulta nueva
            hay que trabajar sobre una sucursal.
          </Alerta>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[340px_1fr]" style={{ height: "calc(100vh - 168px)" }}>
        <div className="card-surface flex flex-col overflow-hidden">
          <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="relative">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2"
                style={{ color: "var(--muted-foreground)" }}
              />
              <input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Nombre, asunto, teléfono o número"
                className="h-8 w-full rounded-md border pl-8 pr-2 text-[13px] outline-none"
                style={inputStyle}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {(
                [
                  ["pendientes", "Sin resolver"],
                  ["abierta", "Sin responder"],
                  ["esperando", "Esperando"],
                  ["todas", "Todas"],
                ] as const
              ).map(([v, texto]) => (
                <button
                  key={v}
                  onClick={() => setFiltro(v)}
                  className="rounded-full border px-2.5 py-1 text-[12px]"
                  style={
                    filtro === v
                      ? { borderColor: "var(--primary)", background: "#fdf3ef", color: "var(--primary)" }
                      : { borderColor: "var(--border)", color: "var(--muted-foreground)" }
                  }
                >
                  {texto}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {cargando ? (
              <p className="p-4 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                Buscando…
              </p>
            ) : visibles.length === 0 ? (
              <div className="p-6 text-center">
                <MessageSquare size={22} className="mx-auto" style={{ color: "#c3cad9" }} />
                <p className="mt-2 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                  {consultas.length === 0
                    ? "Todavía no hay consultas cargadas. Cuando alguien pregunte por Instagram o por teléfono, anotalo acá."
                    : "Ninguna consulta entra en este filtro."}
                </p>
              </div>
            ) : (
              visibles.map((c) => {
                const est = ESTADOS[c.estado] ?? { texto: c.estado, tono: "neutral" as Tono };
                return (
                  <button
                    key={c.id}
                    onClick={() => setSeleccionada(c.id)}
                    className="w-full px-3 py-3 text-left"
                    style={{
                      borderBottom: "1px solid var(--border)",
                      background: seleccionada === c.id ? "#f9fafc" : "transparent",
                    }}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="truncate text-[13px] font-medium">{c.nombre}</div>
                      <span className="shrink-0 text-[11px] tabular" style={{ color: "var(--muted-foreground)" }}>
                        {cuando(c.actualizado_at)}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                      {c.asunto}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Chip tone={est.tono}>{est.texto}</Chip>
                      {c.prioridad === "alta" && <Chip tone="danger">Urgente</Chip>}
                      <span className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                        {etiqueta(CANALES, c.canal)} · {etiqueta(TIPOS, c.tipo)}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {actual ? (
          <Hilo
            key={actual.id}
            consulta={actual}
            mensajes={mensajes}
            cargandoHilo={cargandoHilo}
            usuarios={usuarios}
            nombreUsuario={nombreUsuario}
            miNombre={usuario?.nombre ?? "Vos"}
            onResolver={() => setResolviendo(true)}
            onCambio={() => void refrescar(actual.id)}
          />
        ) : (
          <div className="card-surface grid place-items-center p-6 text-center">
            <div>
              <MessageSquare size={26} className="mx-auto" style={{ color: "#c3cad9" }} />
              <p className="mt-2 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                Elegí una consulta de la izquierda para ver la conversación.
              </p>
            </div>
          </div>
        )}
      </div>

      {nueva && sucursalId && (
        <DialogoNueva
          sucursalId={sucursalId}
          usuarios={usuarios}
          miId={usuario?.user_id ?? null}
          onCerrar={() => setNueva(false)}
          onGuardada={async (id) => {
            setNueva(false);
            await cargar();
            setSeleccionada(id);
          }}
        />
      )}

      {resolviendo && actual && (
        <DialogoResolver
          consulta={actual}
          onCerrar={() => setResolviendo(false)}
          onResuelta={async () => {
            setResolviendo(false);
            await refrescar(actual.id);
          }}
        />
      )}
    </>
  );
}

/* --------------------------------------------------------------------- hilo */

function Hilo({
  consulta,
  mensajes,
  cargandoHilo,
  usuarios,
  nombreUsuario,
  miNombre,
  onResolver,
  onCambio,
}: {
  consulta: Consulta;
  mensajes: Mensaje[];
  cargandoHilo: boolean;
  usuarios: UsuarioBreve[];
  nombreUsuario: (id: string | null) => string | null;
  miNombre: string;
  onResolver: () => void;
  onCambio: () => void;
}) {
  const [texto, setTexto] = useState("");
  const [autor, setAutor] = useState<"local" | "cliente" | "nota">("local");
  const [enviando, setEnviando] = useState(false);
  const fondo = useRef<HTMLDivElement>(null);

  // El último mensaje es el que importa: si hay que buscarlo con la rueda del
  // mouse, la pantalla obliga a trabajar de más.
  useEffect(() => {
    fondo.current?.scrollTo({ top: fondo.current.scrollHeight });
  }, [mensajes]);

  const est = ESTADOS[consulta.estado] ?? { texto: consulta.estado, tono: "neutral" as Tono };
  const resuelta = consulta.estado === "resuelta";

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    const limpio = texto.trim();
    if (!limpio || enviando) return;
    setEnviando(true);
    const { error } = await supa.rpc("agregar_mensaje_consulta", {
      p_consulta_id: consulta.id,
      p_texto: limpio,
      p_autor: autor,
    });
    setEnviando(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setTexto("");
    onCambio();
  };

  const reabrir = async () => {
    const { error } = await supa.rpc("cambiar_estado_consulta", {
      p_consulta_id: consulta.id,
      p_destino: "en_curso",
    });
    if (error) toast.error(error.message);
    else {
      toast.success("La consulta volvió a quedar abierta.");
      onCambio();
    }
  };

  const esperar = async () => {
    const { error } = await supa.rpc("cambiar_estado_consulta", {
      p_consulta_id: consulta.id,
      p_destino: consulta.estado === "esperando" ? "en_curso" : "esperando",
    });
    if (error) toast.error(error.message);
    else onCambio();
  };

  const asignado = nombreUsuario(consulta.asignado_a);

  return (
    <div className="card-surface flex flex-col overflow-hidden">
      <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold">{consulta.asunto}</div>
            <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              #{consulta.numero} · {consulta.nombre}
              {consulta.telefono ? ` · ${consulta.telefono}` : ""} · {etiqueta(CANALES, consulta.canal)} ·{" "}
              {etiqueta(TIPOS, consulta.tipo)}
              {asignado ? ` · Atiende ${asignado}` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Chip tone={est.tono}>{est.texto}</Chip>
            {resuelta ? (
              <button
                onClick={() => void reabrir()}
                className="rounded-md border px-2.5 py-1 text-[12px]"
                style={{ borderColor: "var(--border)" }}
              >
                Reabrir
              </button>
            ) : (
              <>
                <button
                  onClick={() => void esperar()}
                  className="rounded-md border px-2.5 py-1 text-[12px]"
                  style={{ borderColor: "var(--border)" }}
                >
                  {consulta.estado === "esperando" ? "Volver a en curso" : "Esperando al cliente"}
                </button>
                <button
                  onClick={onResolver}
                  className="rounded-md px-2.5 py-1 text-[12px] font-medium text-white"
                  style={{ background: "var(--primary)" }}
                >
                  Marcar como resuelta
                </button>
              </>
            )}
          </div>
        </div>

        {(consulta.venta_id || consulta.pedido_online_id) && (
          <div className="mt-2 flex items-center gap-1.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            <ShoppingBag size={13} />
            {consulta.venta_id ? "Es por una venta del local." : "Es por un pedido de la tienda online."}
          </div>
        )}

        {resuelta && consulta.resolucion && (
          <div
            className="mt-2 rounded-md p-2.5 text-[12px]"
            style={{ background: "var(--success-bg)", color: "var(--success)" }}
          >
            {consulta.resolucion}
          </div>
        )}
      </div>

      <div ref={fondo} className="flex-1 space-y-3 overflow-y-auto p-6" style={{ background: "#f9fafc" }}>
        {cargandoHilo ? (
          <p className="text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            Buscando la conversación…
          </p>
        ) : mensajes.length === 0 ? (
          <p className="text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            Todavía no hay mensajes cargados en esta consulta.
          </p>
        ) : (
          mensajes.map((m) => {
            if (m.autor === "nota") {
              return (
                <div key={m.id} className="flex justify-center">
                  <div
                    className="max-w-[80%] rounded-md px-3 py-1.5 text-center text-[12px]"
                    style={{ background: "#eef1f6", color: "var(--muted-foreground)" }}
                  >
                    <Lock size={11} className="mb-0.5 mr-1 inline" />
                    {m.texto}
                    <span className="ml-1.5 opacity-70">{hora(m.created_at)}</span>
                  </div>
                </div>
              );
            }
            const propio = m.autor === "local";
            return (
              <div key={m.id} className={`flex ${propio ? "justify-end" : "justify-start"}`}>
                <div
                  className="max-w-[70%] rounded-2xl px-3 py-2 text-[13px]"
                  style={{
                    background: propio ? "var(--primary)" : "var(--surface)",
                    color: propio ? "#fff" : "var(--foreground)",
                    border: propio ? "none" : "1px solid var(--border)",
                  }}
                >
                  <div className="whitespace-pre-line">{m.texto}</div>
                  <div className="mt-1 text-[10px] opacity-70">
                    {propio ? `${nombreUsuario(m.usuario_id) ?? miNombre} · ` : ""}
                    {cuando(m.created_at)}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <form onSubmit={enviar} className="p-3" style={{ borderTop: "1px solid var(--border)" }}>
        <div className="mb-2 flex flex-wrap gap-1">
          {(
            [
              ["local", "Contestamos nosotros"],
              ["cliente", "Escribió el cliente"],
              ["nota", "Nota interna"],
            ] as const
          ).map(([v, texto]) => (
            <button
              key={v}
              type="button"
              onClick={() => setAutor(v)}
              className="rounded-full border px-2.5 py-1 text-[12px]"
              style={
                autor === v
                  ? { borderColor: "var(--primary)", background: "#fdf3ef", color: "var(--primary)" }
                  : { borderColor: "var(--border)", color: "var(--muted-foreground)" }
              }
            >
              {texto}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              // Enter manda, Shift+Enter hace renglón: es lo que espera
              // cualquiera que haya escrito un mensaje alguna vez.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void enviar(e as unknown as React.FormEvent);
              }
            }}
            rows={2}
            placeholder={
              autor === "nota"
                ? "Una nota para el equipo. El cliente no la ve."
                : autor === "cliente"
                  ? "Lo que dijo el cliente…"
                  : "Lo que le contestamos…"
            }
            className="flex-1 resize-none rounded-md border px-3 py-2 text-[13px] outline-none"
            style={inputStyle}
          />
          <button
            type="submit"
            disabled={enviando || texto.trim() === ""}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-white disabled:opacity-45"
            style={{ background: "var(--primary)" }}
          >
            <Send size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------ nueva consulta */

function DialogoNueva({
  sucursalId,
  usuarios,
  miId,
  onCerrar,
  onGuardada,
}: {
  sucursalId: string;
  usuarios: UsuarioBreve[];
  miId: string | null;
  onCerrar: () => void;
  onGuardada: (id: string) => void | Promise<void>;
}) {
  const [asunto, setAsunto] = useState("");
  const [canal, setCanal] = useState<string>("whatsapp");
  const [tipo, setTipo] = useState<string>("consulta");
  const [prioridad, setPrioridad] = useState<string>("normal");
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [email, setEmail] = useState("");
  const [asignado, setAsignado] = useState<string>(miId ?? "");
  const [primerMensaje, setPrimerMensaje] = useState("");

  const [buscarCliente, setBuscarCliente] = useState("");
  const [clientes, setClientes] = useState<ClienteBreve[]>([]);
  const [cliente, setCliente] = useState<ClienteBreve | null>(null);
  const [ventas, setVentas] = useState<VentaBreve[]>([]);
  const [ventaId, setVentaId] = useState("");

  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Se busca contra la base y no en memoria: la lista de clientes crece, y
  // traerla entera para escribir tres letras es tirar datos al aire.
  useEffect(() => {
    const t = buscarCliente.trim();
    if (cliente || t.length < 2) {
      setClientes([]);
      return;
    }
    const id = setTimeout(async () => {
      const { data } = await supa
        .from("clientes")
        .select("id, nombre, telefono, email")
        .eq("activo", true)
        .ilike("nombre", `%${t}%`)
        .order("nombre")
        .limit(8);
      setClientes((data as ClienteBreve[]) ?? []);
    }, 250);
    return () => clearTimeout(id);
  }, [buscarCliente, cliente]);

  const elegirCliente = async (c: ClienteBreve) => {
    setCliente(c);
    setBuscarCliente(c.nombre);
    setClientes([]);
    if (!nombre.trim()) setNombre(c.nombre);
    if (!telefono.trim() && c.telefono) setTelefono(c.telefono);
    if (!email.trim() && c.email) setEmail(c.email);
    const { data } = await supa
      .from("ventas")
      .select("id, numero, total, created_at")
      .eq("cliente_id", c.id)
      .eq("estado", "completada")
      .order("created_at", { ascending: false })
      .limit(10);
    setVentas((data as VentaBreve[]) ?? []);
  };

  const soltarCliente = () => {
    setCliente(null);
    setVentas([]);
    setVentaId("");
    setBuscarCliente("");
  };

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    if (!nombre.trim() && !cliente) {
      setError("Poné al menos un nombre: sin eso la consulta no se puede volver a encontrar.");
      return;
    }
    if (!asunto.trim()) {
      setError("Escribí de qué se trata. En dos semanas nadie se acuerda.");
      return;
    }
    setEnviando(true);
    setError(null);
    const { data, error: falla } = await supa.rpc("guardar_consulta", {
      p_sucursal_id: sucursalId,
      p_asunto: asunto.trim(),
      p_canal: canal,
      p_tipo: tipo,
      p_prioridad: prioridad,
      p_cliente_id: cliente?.id ?? null,
      p_nombre: nombre.trim() || null,
      p_telefono: telefono.trim() || null,
      p_email: email.trim() || null,
      p_asignado_a: asignado || null,
      p_venta_id: ventaId || null,
      p_primer_mensaje: primerMensaje.trim() || null,
    });
    setEnviando(false);
    if (falla) {
      setError(falla.message);
      return;
    }
    toast.success("Consulta cargada.");
    await onGuardada(data as string);
  };

  return (
    <Modal titulo="Nueva consulta" ancho="max-w-2xl" onCerrar={onCerrar}>
      <form onSubmit={guardar}>
        {error && (
          <div className="mb-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="text-[12px] font-medium">¿De qué se trata?</label>
            <input
              value={asunto}
              onChange={(e) => setAsunto(e.target.value)}
              placeholder="Cambio de talle de unas Air Max"
              className={inputCls}
              style={inputStyle}
              autoFocus
            />
          </div>

          <div>
            <label className="text-[12px] font-medium">¿Por dónde escribió?</label>
            <select value={canal} onChange={(e) => setCanal(e.target.value)} className={inputCls} style={inputStyle}>
              {CANALES.map(([v, texto]) => (
                <option key={v} value={v}>
                  {texto}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[12px] font-medium">Tipo</label>
            <select value={tipo} onChange={(e) => setTipo(e.target.value)} className={inputCls} style={inputStyle}>
              {TIPOS.map(([v, texto]) => (
                <option key={v} value={v}>
                  {texto}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="text-[12px] font-medium">¿Es un cliente cargado?</label>
            {cliente ? (
              <div
                className="mt-1 flex items-center justify-between rounded-md border px-2.5 py-2 text-[13px]"
                style={inputStyle}
              >
                <span className="flex items-center gap-1.5">
                  <User size={13} style={{ color: "var(--muted-foreground)" }} />
                  {cliente.nombre}
                </span>
                <button type="button" onClick={soltarCliente} className="text-[12px]" style={{ color: "var(--primary)" }}>
                  Cambiar
                </button>
              </div>
            ) : (
              <>
                <input
                  value={buscarCliente}
                  onChange={(e) => setBuscarCliente(e.target.value)}
                  placeholder="Buscar por nombre (opcional)"
                  className={inputCls}
                  style={inputStyle}
                />
                {clientes.length > 0 && (
                  <div className="mt-1 overflow-hidden rounded-md border" style={inputStyle}>
                    {clientes.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => void elegirCliente(c)}
                        className="block w-full px-2.5 py-1.5 text-left text-[13px] hover:bg-[#f9fafc]"
                      >
                        {c.nombre}
                        {c.telefono && (
                          <span className="ml-1.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                            {c.telefono}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-1 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                  La mayoría de las preguntas de Instagram son de gente que nunca compró. Con el
                  nombre alcanza.
                </p>
              </>
            )}
          </div>

          {ventas.length > 0 && (
            <div className="sm:col-span-2">
              <label className="text-[12px] font-medium">¿Es por alguna venta?</label>
              <select value={ventaId} onChange={(e) => setVentaId(e.target.value)} className={inputCls} style={inputStyle}>
                <option value="">No, es una consulta suelta</option>
                {ventas.map((v) => (
                  <option key={v.id} value={v.id}>
                    Venta #{v.numero} · {new Date(v.created_at).toLocaleDateString("es-AR")} ·{" "}
                    {formatARS(Number(v.total))}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="text-[12px] font-medium">Nombre</label>
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Cómo se llama"
              className={inputCls}
              style={inputStyle}
            />
          </div>

          <div>
            <label className="text-[12px] font-medium">Teléfono</label>
            <input
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              placeholder="341 555 1234"
              className={inputCls}
              style={inputStyle}
            />
          </div>

          <div>
            <label className="text-[12px] font-medium">Email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Opcional"
              className={inputCls}
              style={inputStyle}
            />
          </div>

          <div>
            <label className="text-[12px] font-medium">Prioridad</label>
            <select
              value={prioridad}
              onChange={(e) => setPrioridad(e.target.value)}
              className={inputCls}
              style={inputStyle}
            >
              {PRIORIDADES.map(([v, texto]) => (
                <option key={v} value={v}>
                  {texto}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="text-[12px] font-medium">¿Quién la atiende?</label>
            <select
              value={asignado}
              onChange={(e) => setAsignado(e.target.value)}
              className={inputCls}
              style={inputStyle}
            >
              <option value="">Nadie todavía</option>
              {usuarios.map((u) => (
                <option key={u.user_id} value={u.user_id}>
                  {u.nombre}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="text-[12px] font-medium">¿Qué preguntó?</label>
            <textarea
              value={primerMensaje}
              onChange={(e) => setPrimerMensaje(e.target.value)}
              rows={3}
              placeholder="Copiá el mensaje o escribí lo que te dijo. Opcional."
              className="mt-1 w-full resize-none rounded-md border px-2.5 py-2 text-[13px] outline-none"
              style={inputStyle}
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando}>Cargar consulta</BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ resolver */

function DialogoResolver({
  consulta,
  onCerrar,
  onResuelta,
}: {
  consulta: Consulta;
  onCerrar: () => void;
  onResuelta: () => void | Promise<void>;
}) {
  const [resolucion, setResolucion] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cerrar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    if (resolucion.trim() === "") {
      setError("Contá cómo terminó. Una consulta cerrada sin explicación no sirve para nada después.");
      return;
    }
    setEnviando(true);
    setError(null);
    const { error: falla } = await supa.rpc("cambiar_estado_consulta", {
      p_consulta_id: consulta.id,
      p_destino: "resuelta",
      p_resolucion: resolucion.trim(),
    });
    setEnviando(false);
    if (falla) {
      setError(falla.message);
      return;
    }
    toast.success("Consulta resuelta.");
    await onResuelta();
  };

  return (
    <Modal titulo="Marcar como resuelta" onCerrar={onCerrar}>
      <form onSubmit={cerrar}>
        {error && (
          <div className="mb-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}
        <p className="text-[13px]" style={{ color: "var(--muted-foreground)" }}>
          Consulta #{consulta.numero} de {consulta.nombre}.
        </p>
        <label className="mt-3 block text-[12px] font-medium">¿Cómo terminó?</label>
        <textarea
          value={resolucion}
          onChange={(e) => setResolucion(e.target.value)}
          rows={4}
          placeholder="Se le cambió el talle 41 por el 42, sin diferencia de precio."
          className="mt-1 w-full resize-none rounded-md border px-2.5 py-2 text-[13px] outline-none"
          style={inputStyle}
          autoFocus
        />
        <div className="mt-4 flex justify-end gap-2">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando}>Resolver</BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------------------- fechas */

function hora(iso: string) {
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

/** Hoy alcanza con la hora; más atrás hace falta el día para ubicarse. */
function cuando(iso: string) {
  const d = new Date(iso);
  const hoy = new Date();
  const mismoDia =
    d.getDate() === hoy.getDate() && d.getMonth() === hoy.getMonth() && d.getFullYear() === hoy.getFullYear();
  if (mismoDia) return hora(iso);
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "short" });
}
