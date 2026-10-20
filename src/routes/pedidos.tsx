import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Bike,
  Check,
  Copy,
  Link2,
  MapPin,
  Package,
  Phone,
  Plus,
  Search,
  Truck,
  X,
} from "lucide-react";
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
import { DialogoProveedor } from "@/components/ui-bits/DialogoProveedor";
import { MapaOSM, type PuntoMapa } from "@/components/mapa/MapaOSM";
import { formatARS } from "@/lib/format";
import { supa } from "@/lib/supabase";
import { useSesion, useSucursalOperativa } from "@/lib/sesion";

/**
 * Pedidos, que en un local son dos cosas distintas que la gente llama igual:
 *
 *  - Las ENTREGAS: lo que sale del local para la casa de alguien. Necesita
 *    dirección, teléfono, quién lo lleva y un link para que el cliente vea
 *    por dónde anda. Ese link es todo el "GPS": el celular del repartidor
 *    publica su posición mientras la entrega está en camino.
 *
 *  - Los PEDIDOS A PROVEEDOR: lo que se le encarga a la marca. Necesita
 *    saber cuánto cuesta, cuánto se va a gastar en traerlo y a cuánto
 *    conviene venderlo. Cuando la mercadería llega, el pedido se convierte
 *    en la compra: la mercadería entra al sistema por una sola puerta.
 *
 * Un pedido a proveedor no toca stock ni plata hasta que se recibe. Una
 * entrega sin venta tampoco mueve stock: reserva. Lo que se ve en Stock como
 * "disponible" ya descuenta lo reservado.
 */

export const Route = createFileRoute("/pedidos")({
  head: () => ({
    meta: [
      { title: "Pedidos y envíos — PymeOS" },
      { name: "description", content: "Entregas a domicilio y pedidos a proveedores." },
    ],
  }),
  component: Pedidos,
});

/* ────────────────────────────── tipos ────────────────────────────── */

type Envio = {
  id: string;
  numero: number;
  sucursal_id: string;
  venta_id: string | null;
  cliente_id: string | null;
  destinatario: string;
  telefono: string | null;
  direccion: string;
  referencia: string | null;
  localidad: string | null;
  lat: number | null;
  lng: number | null;
  estado: string;
  repartidor_id: string | null;
  token: string;
  token_repartidor: string;
  programado_para: string | null;
  franja: string | null;
  costo_envio: number;
  nota: string | null;
  salida_at: string | null;
  entrega_at: string | null;
  recibido_por: string | null;
  motivo_no_entrega: string | null;
  created_at: string;
  envio_lineas: {
    id: string;
    variante_id: string;
    cantidad: number;
    variantes: {
      talle: string | null;
      color: string | null;
      productos: { nombre: string; marca: string | null } | null;
    } | null;
  }[];
};

type PedidoProveedor = {
  id: string;
  numero: number;
  proveedor_id: string;
  estado: string;
  fecha_pedido: string;
  fecha_estimada: string | null;
  gastos_estimados: number;
  nota: string | null;
  compra_id: string | null;
  motivo_cancelacion: string | null;
  created_at: string;
  pedido_proveedor_lineas: {
    id: string;
    variante_id: string;
    cantidad: number;
    costo_unitario: number;
    precio_previsto: number | null;
    precio_competencia: number | null;
    variantes: {
      talle: string | null;
      color: string | null;
      productos: { nombre: string; marca: string | null } | null;
    } | null;
  }[];
};

type Proveedor = { id: string; nombre: string; activo: boolean };
type ClienteBreve = { id: string; nombre: string; telefono: string | null; direccion: string | null };
type PersonaBreve = { user_id: string; nombre: string; activo: boolean };
type VentaBreve = { id: string; numero: number; total: number; cliente_id: string | null; created_at: string };
type MedioPago = { id: string; nombre: string; es_cuenta_corriente: boolean };
type Variante = {
  id: string;
  talle: string | null;
  color: string | null;
  sku: string | null;
  codigo_barras: string | null;
  costo: number | null;
  precio: number | null;
  activa: boolean;
};
type Producto = { id: string; nombre: string; marca: string | null; variantes: Variante[] };
type Disponible = { variante_id: string; disponible: number };

/* ───────────────────────────── ayudas ────────────────────────────── */

function hoyISO(): string {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
}

function fechaCorta(iso: string | null): string {
  if (!iso) return "—";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${a.slice(2)}`;
}

function aNumero(texto: string): number {
  const n = Number(texto.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function nombreVariante(v: {
  talle: string | null;
  color: string | null;
  productos: { nombre: string; marca: string | null } | null;
} | null): string {
  if (!v) return "Producto";
  const partes = [v.productos?.nombre, v.talle, v.color].filter(Boolean);
  return partes.join(" · ") || "Producto";
}

const ESTADO_ENVIO_LABEL: Record<string, string> = {
  pendiente: "Pendiente",
  preparando: "Preparando",
  en_camino: "En camino",
  entregado: "Entregado",
  no_entregado: "No entregado",
  cancelado: "Cancelado",
};

/**
 * Color del cartelito de estado. `statusTone` genérico deja "No entregado" en
 * gris, y una entrega que volvió sin entregarse no es un estado neutro: es lo
 * primero que hay que mirar en la lista.
 */
function tonoEnvio(estado: string) {
  if (estado === "entregado") return "success" as const;
  if (estado === "no_entregado" || estado === "cancelado") return "danger" as const;
  if (estado === "en_camino") return "violet" as const;
  return "warning" as const;
}

const ESTADO_PEDIDO_LABEL: Record<string, string> = {
  borrador: "Borrador",
  enviado: "Enviado",
  confirmado: "Confirmado",
  recibido: "Recibido",
  cancelado: "Cancelado",
};

const FRANJAS = [
  { valor: "todo_el_dia", label: "Todo el día" },
  { valor: "mañana", label: "Por la mañana" },
  { valor: "tarde", label: "Por la tarde" },
];

/** Lo que se puede hacer con una entrega según dónde está. Espeja a mover_envio. */
function transicionesEnvio(estado: string): { destino: string; label: string; tono: "primario" | "borde" | "peligro" }[] {
  switch (estado) {
    case "pendiente":
      return [
        { destino: "preparando", label: "Preparar", tono: "borde" },
        { destino: "en_camino", label: "Salió", tono: "primario" },
      ];
    case "preparando":
      return [{ destino: "en_camino", label: "Salió a repartir", tono: "primario" }];
    case "en_camino":
      return [
        { destino: "entregado", label: "Se entregó", tono: "primario" },
        { destino: "no_entregado", label: "No se pudo", tono: "borde" },
      ];
    case "no_entregado":
      return [{ destino: "pendiente", label: "Reintentar mañana", tono: "borde" }];
    default:
      return [];
  }
}

/* ───────────────────────────── pantalla ──────────────────────────── */

function Pedidos() {
  const { usuario } = useSesion();
  const sucursal = useSucursalOperativa();

  // El vendedor reparte, pero no le encarga mercadería a la marca ni ve costos.
  const vePedidosProveedor = usuario?.rol === "dueno" || usuario?.rol === "contador";
  const veEntregas = usuario?.rol !== "contador";

  const [tab, setTab] = useState<"entregas" | "proveedor">(
    veEntregas ? "entregas" : "proveedor",
  );

  return (
    <>
      <PageHeader
        title="Pedidos y envíos"
        subtitle="Lo que sale para la casa del cliente y lo que se le encarga al proveedor."
      />

      {vePedidosProveedor && veEntregas && (
        <div className="mb-3 inline-flex rounded-md border p-0.5" style={{ borderColor: "var(--border)" }}>
          <BotonTab activo={tab === "entregas"} onClick={() => setTab("entregas")}>
            <Truck size={13} /> Entregas
          </BotonTab>
          <BotonTab activo={tab === "proveedor"} onClick={() => setTab("proveedor")}>
            <Package size={13} /> Pedidos a proveedor
          </BotonTab>
        </div>
      )}

      {tab === "entregas" && veEntregas ? (
        <Entregas sucursalId={sucursal?.id ?? null} />
      ) : vePedidosProveedor ? (
        <PedidosAProveedor sucursalId={sucursal?.id ?? null} />
      ) : null}
    </>
  );
}

function BotonTab({
  activo,
  onClick,
  children,
}: {
  activo: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-[13px] font-medium"
      style={{
        background: activo ? "var(--primary)" : "transparent",
        color: activo ? "var(--primary-foreground)" : "var(--muted-foreground)",
      }}
    >
      {children}
    </button>
  );
}

/* ═══════════════════════════ 1. ENTREGAS ═══════════════════════════ */

function Entregas({ sucursalId }: { sucursalId: string | null }) {
  const [envios, setEnvios] = useState<Envio[]>([]);
  const [clientes, setClientes] = useState<ClienteBreve[]>([]);
  const [personas, setPersonas] = useState<PersonaBreve[]>([]);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [disponible, setDisponible] = useState<Disponible[]>([]);
  const [ventas, setVentas] = useState<VentaBreve[]>([]);
  const [origen, setOrigen] = useState<{ nombre: string; lat: number | null; lng: number | null } | null>(null);

  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  const [busqueda, setBusqueda] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("abiertos");
  const [selId, setSelId] = useState<string | null>(null);
  const [editando, setEditando] = useState<Envio | "nuevo" | null>(null);
  const [cerrando, setCerrando] = useState<{ envio: Envio; destino: string } | null>(null);

  const cargar = useCallback(async () => {
    setErrorCarga(null);

    let consulta = supa
      .from("envios")
      .select(
        "id, numero, sucursal_id, venta_id, cliente_id, destinatario, telefono, direccion, referencia, localidad, lat, lng, estado, repartidor_id, token, token_repartidor, programado_para, franja, costo_envio, nota, salida_at, entrega_at, recibido_por, motivo_no_entrega, created_at, envio_lineas ( id, variante_id, cantidad, variantes ( talle, color, productos ( nombre, marca ) ) )",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (sucursalId) consulta = consulta.eq("sucursal_id", sucursalId);

    let consultaVentas = supa
      .from("ventas")
      .select("id, numero, total, cliente_id, created_at")
      .eq("estado", "confirmada")
      .order("created_at", { ascending: false })
      .limit(60);
    if (sucursalId) consultaVentas = consultaVentas.eq("sucursal_id", sucursalId);

    let consultaStock = supa.from("stock_disponible").select("variante_id, disponible");
    if (sucursalId) consultaStock = consultaStock.eq("sucursal_id", sucursalId);

    const [env, cli, per, cat, stk, ven, suc] = await Promise.all([
      consulta,
      supa.from("clientes").select("id, nombre, telefono, direccion").eq("activo", true).order("nombre"),
      supa.from("usuarios").select("user_id, nombre, activo").eq("activo", true).order("nombre"),
      supa
        .from("productos")
        .select("id, nombre, marca, variantes ( id, talle, color, sku, codigo_barras, costo, precio, activa )")
        .eq("activo", true)
        .order("nombre"),
      consultaStock,
      consultaVentas,
      sucursalId
        ? supa.from("sucursales").select("nombre, lat, lng").eq("id", sucursalId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    const fallo = env.error ?? cli.error ?? per.error ?? cat.error ?? stk.error ?? ven.error;
    if (fallo) setErrorCarga(fallo.message);
    else {
      setEnvios((env.data ?? []) as unknown as Envio[]);
      setClientes((cli.data ?? []) as ClienteBreve[]);
      setPersonas((per.data ?? []) as PersonaBreve[]);
      setProductos((cat.data ?? []) as unknown as Producto[]);
      setDisponible((stk.data ?? []) as Disponible[]);
      setVentas((ven.data ?? []) as VentaBreve[]);
      setOrigen((suc.data ?? null) as { nombre: string; lat: number | null; lng: number | null } | null);
    }
    setCargando(false);
  }, [sucursalId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const lista = useMemo(() => {
    const texto = busqueda.trim().toLowerCase();
    return envios.filter((e) => {
      if (filtroEstado === "abiertos") {
        if (!["pendiente", "preparando", "en_camino"].includes(e.estado)) return false;
      } else if (filtroEstado !== "todos" && e.estado !== filtroEstado) return false;
      if (!texto) return true;
      return [e.destinatario, e.direccion, e.localidad, e.telefono, String(e.numero)]
        .filter(Boolean)
        .some((c) => String(c).toLowerCase().includes(texto));
    });
  }, [envios, busqueda, filtroEstado]);

  const sel = useMemo(() => envios.find((e) => e.id === selId) ?? lista[0] ?? null, [envios, selId, lista]);

  const enCamino = envios.filter((e) => e.estado === "en_camino").length;
  const abiertos = envios.filter((e) => ["pendiente", "preparando", "en_camino"].includes(e.estado)).length;

  if (!sucursalId) {
    return (
      <div className="card-surface p-6 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
        Mirando las dos sucursales se puede leer, pero no armar entregas. Elegí una sucursal para
        operar.
      </div>
    );
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[13px]" style={{ color: "var(--muted-foreground)" }}>
          {cargando ? "Cargando…" : `${abiertos} entregas abiertas · ${enCamino} en camino`}
        </div>
        <button
          type="button"
          onClick={() => setEditando("nuevo")}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium"
          style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
        >
          <Plus size={14} /> Nueva entrega
        </button>
      </div>

      {errorCarga && <Alerta tono="danger">{errorCarga}</Alerta>}

      <div className="grid grid-cols-[1fr_420px] items-start gap-3">
        <div className="card-surface overflow-hidden">
          <div
            className="flex items-center gap-2 px-4 py-3"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <div className="relative flex-1">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2"
                style={{ color: "var(--muted-foreground)" }}
              />
              <input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por cliente, dirección o número…"
                className="h-8 w-full rounded-md border pl-8 pr-3 text-[13px] outline-none"
                style={inputStyle}
              />
            </div>
            <select
              value={filtroEstado}
              onChange={(e) => setFiltroEstado(e.target.value)}
              className="h-8 rounded-md border px-2 text-[13px]"
              style={inputStyle}
            >
              <option value="abiertos">Las que están abiertas</option>
              <option value="todos">Todas</option>
              <option value="pendiente">Pendientes</option>
              <option value="preparando">Preparando</option>
              <option value="en_camino">En camino</option>
              <option value="entregado">Entregadas</option>
              <option value="no_entregado">No entregadas</option>
              <option value="cancelado">Canceladas</option>
            </select>
          </div>

          {lista.length === 0 ? (
            <div className="p-6 text-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
              {cargando
                ? "Cargando entregas…"
                : "No hay entregas para mostrar. Cargá la primera con “Nueva entrega”."}
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ color: "var(--muted-foreground)", background: "#f9fafc" }}>
                  <th className="px-4 py-2 text-left font-medium">Nº</th>
                  <th className="px-4 py-2 text-left font-medium">Destinatario</th>
                  <th className="px-4 py-2 text-left font-medium">Dirección</th>
                  <th className="px-4 py-2 text-left font-medium">Para</th>
                  <th className="px-4 py-2 text-left font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {lista.map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => setSelId(e.id)}
                    className="cursor-pointer"
                    style={{
                      borderTop: "1px solid #eef1f6",
                      background: sel?.id === e.id ? "#f9fafc" : "transparent",
                    }}
                  >
                    <td className="px-4 py-2 font-medium tabular">#{e.numero}</td>
                    <td className="px-4 py-2">{e.destinatario}</td>
                    <td
                      className="truncate px-4 py-2"
                      style={{ maxWidth: 220, color: "var(--muted-foreground)" }}
                    >
                      {e.direccion}
                      {e.localidad ? `, ${e.localidad}` : ""}
                    </td>
                    <td className="px-4 py-2 tabular" style={{ color: "var(--muted-foreground)" }}>
                      {fechaCorta(e.programado_para)}
                    </td>
                    <td className="px-4 py-2">
                      <Chip tone={tonoEnvio(e.estado)}>
                        {ESTADO_ENVIO_LABEL[e.estado] ?? e.estado}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {sel ? (
          <DetalleEnvio
            envio={sel}
            origen={origen}
            personas={personas}
            ventas={ventas}
            onEditar={() => setEditando(sel)}
            onPedirCierre={(destino) => setCerrando({ envio: sel, destino })}
            onCambiado={cargar}
          />
        ) : (
          <aside className="card-surface p-6 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            Elegí una entrega de la lista para ver el detalle y el mapa.
          </aside>
        )}
      </div>

      {editando && (
        <DialogoEnvio
          envio={editando === "nuevo" ? null : editando}
          sucursalId={sucursalId}
          clientes={clientes}
          productos={productos}
          disponible={disponible}
          ventas={ventas}
          onCerrar={() => setEditando(null)}
          onListo={async () => {
            setEditando(null);
            await cargar();
          }}
        />
      )}

      {cerrando && (
        <DialogoCierreEnvio
          envio={cerrando.envio}
          destino={cerrando.destino}
          onCerrar={() => setCerrando(null)}
          onListo={async () => {
            setCerrando(null);
            await cargar();
          }}
        />
      )}
    </>
  );
}

/** Panel derecho: dónde está la entrega, quién la lleva y los links para mandar. */
function DetalleEnvio({
  envio,
  origen,
  personas,
  ventas,
  onEditar,
  onPedirCierre,
  onCambiado,
}: {
  envio: Envio;
  origen: { nombre: string; lat: number | null; lng: number | null } | null;
  personas: PersonaBreve[];
  ventas: VentaBreve[];
  onEditar: () => void;
  onPedirCierre: (destino: string) => void;
  onCambiado: () => Promise<void>;
}) {
  const [recorrido, setRecorrido] = useState<{ lat: number; lng: number }[]>([]);
  const [trabajando, setTrabajando] = useState(false);

  // El recorrido solo existe mientras alguien está manejando. Se refresca solo
  // para no obligar a nadie a apretar F5 mientras mira el mapa.
  useEffect(() => {
    let vivo = true;
    async function traer() {
      const { data } = await supa
        .from("envio_posiciones")
        .select("lat, lng")
        .eq("envio_id", envio.id)
        .order("created_at", { ascending: true })
        .limit(300);
      if (vivo) setRecorrido(((data ?? []) as { lat: number; lng: number }[]).map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) })));
    }
    void traer();
    if (envio.estado !== "en_camino") return () => { vivo = false; };
    const t = setInterval(() => void traer(), 15_000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [envio.id, envio.estado]);

  const puntos: PuntoMapa[] = [];
  const ultima = recorrido[recorrido.length - 1];
  if (ultima && envio.estado === "en_camino") {
    puntos.push({ ...ultima, tipo: "repartidor", etiqueta: "El reparto" });
  }
  if (envio.lat != null && envio.lng != null) {
    puntos.push({ lat: Number(envio.lat), lng: Number(envio.lng), tipo: "destino", etiqueta: envio.destinatario });
  }
  if (origen?.lat != null && origen?.lng != null && puntos.length < 2) {
    puntos.push({ lat: Number(origen.lat), lng: Number(origen.lng), tipo: "local", etiqueta: origen.nombre });
  }

  const base = typeof window === "undefined" ? "" : window.location.origin;

  async function copiar(url: string, que: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(`${que} copiado. Pegalo en el WhatsApp.`);
    } catch {
      toast.error("El navegador no dejó copiar. Seleccioná el link a mano.");
    }
  }

  async function mover(destino: string) {
    // Entregado y no entregado piden explicación: uno para saber quién recibió,
    // el otro para saber por qué volvió. Esos van por el diálogo.
    if (destino === "entregado" || destino === "no_entregado" || destino === "cancelado") {
      onPedirCierre(destino);
      return;
    }
    setTrabajando(true);
    const { error } = await supa.rpc("cambiar_estado_envio", {
      p_envio_id: envio.id,
      p_destino: destino,
    });
    setTrabajando(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    await onCambiado();
  }

  async function asignar(repartidorId: string) {
    setTrabajando(true);
    const { error } = await supa.rpc("asignar_repartidor", {
      p_envio_id: envio.id,
      p_repartidor_id: repartidorId || null,
    });
    setTrabajando(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    await onCambiado();
  }

  async function vincular(ventaId: string) {
    setTrabajando(true);
    const { error } = await supa.rpc("vincular_venta_a_envio", {
      p_envio_id: envio.id,
      p_venta_id: ventaId,
    });
    setTrabajando(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    await onCambiado();
  }

  const cerrado = ["entregado", "cancelado"].includes(envio.estado);

  return (
    <aside className="card-surface flex flex-col overflow-hidden">
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="text-[14px] font-semibold tabular">Entrega #{envio.numero}</div>
        <Chip tone={tonoEnvio(envio.estado)}>
          {ESTADO_ENVIO_LABEL[envio.estado] ?? envio.estado}
        </Chip>
      </div>

      {puntos.length > 0 && <MapaOSM puntos={puntos} recorrido={recorrido} alto={220} />}

      <div className="space-y-3 p-4 text-[13px]">
        <div className="flex gap-2">
          <MapPin size={14} className="mt-0.5 shrink-0" style={{ color: "var(--muted-foreground)" }} />
          <div>
            <div className="font-medium">{envio.destinatario}</div>
            <div style={{ color: "var(--muted-foreground)" }}>
              {envio.direccion}
              {envio.localidad ? `, ${envio.localidad}` : ""}
            </div>
            {envio.referencia && (
              <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                {envio.referencia}
              </div>
            )}
          </div>
        </div>

        {envio.telefono && (
          <div className="flex items-center gap-2">
            <Phone size={14} style={{ color: "var(--muted-foreground)" }} />
            <a href={`tel:${envio.telefono}`} className="underline">
              {envio.telefono}
            </a>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Bike size={14} className="shrink-0" style={{ color: "var(--muted-foreground)" }} />
          <select
            value={envio.repartidor_id ?? ""}
            disabled={cerrado || trabajando}
            onChange={(e) => void asignar(e.target.value)}
            className="h-8 flex-1 rounded-md border px-2 text-[13px]"
            style={inputStyle}
          >
            <option value="">Sin asignar</option>
            {personas.map((p) => (
              <option key={p.user_id} value={p.user_id}>
                {p.nombre}
              </option>
            ))}
          </select>
        </div>

        {envio.envio_lineas.length > 0 && (
          <div className="rounded-md p-3" style={{ background: "#f9fafc" }}>
            <div
              className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--muted-foreground)" }}
            >
              Qué lleva
            </div>
            {envio.envio_lineas.map((l) => (
              <div key={l.id} className="flex justify-between">
                <span>{nombreVariante(l.variantes)}</span>
                <span className="tabular">{l.cantidad}</span>
              </div>
            ))}
            {!envio.venta_id && (
              <div className="mt-2 text-[12px]" style={{ color: "var(--warning)" }}>
                Todavía sin venta: esta mercadería está reservada, no descontada.
              </div>
            )}
          </div>
        )}

        {envio.costo_envio > 0 && (
          <div className="flex justify-between" style={{ color: "var(--muted-foreground)" }}>
            <span>Costo del envío</span>
            <span className="tabular">{formatARS(Number(envio.costo_envio))}</span>
          </div>
        )}

        {!envio.venta_id && !cerrado && (
          <div className="rounded-md p-3" style={{ background: "var(--warning-bg)" }}>
            <div className="text-[12px]" style={{ color: "var(--warning)" }}>
              Antes de darla por entregada hay que enganchar la venta. Si no, sale mercadería del
              depósito sin quedar anotada.
            </div>
            <select
              defaultValue=""
              disabled={trabajando}
              onChange={(e) => e.target.value && void vincular(e.target.value)}
              className="mt-2 h-8 w-full rounded-md border px-2 text-[13px]"
              style={{ borderColor: "var(--border)", background: "var(--surface)" }}
            >
              <option value="">Enganchar una venta…</option>
              {ventas.map((v) => (
                <option key={v.id} value={v.id}>
                  #{v.numero} · {formatARS(Number(v.total))} · {fechaCorta(v.created_at)}
                </option>
              ))}
            </select>
          </div>
        )}

        {envio.motivo_no_entrega && (
          <Alerta tono="warning">No se entregó: {envio.motivo_no_entrega}</Alerta>
        )}
        {envio.recibido_por && (
          <div style={{ color: "var(--muted-foreground)" }}>Recibió: {envio.recibido_por}</div>
        )}

        <div className="space-y-1.5 pt-1">
          <BotonLink
            texto="Link para el cliente"
            url={`${base}/seguimiento/${envio.token}`}
            onCopiar={(u) => void copiar(u, "El link del cliente")}
          />
          <BotonLink
            texto="Link para el repartidor"
            url={`${base}/reparto/${envio.token_repartidor}`}
            onCopiar={(u) => void copiar(u, "El link del repartidor")}
          />
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          {transicionesEnvio(envio.estado).map((t) => (
            <button
              key={t.destino}
              type="button"
              disabled={trabajando}
              onClick={() => void mover(t.destino)}
              className="flex-1 rounded-md py-2 text-[13px] font-medium"
              style={
                t.tono === "primario"
                  ? { background: "var(--primary)", color: "var(--primary-foreground)" }
                  : { border: "1px solid var(--border)" }
              }
            >
              {t.label}
            </button>
          ))}
          {!cerrado && (
            <>
              <button
                type="button"
                onClick={onEditar}
                className="rounded-md border px-3 py-2 text-[13px]"
                style={inputStyle}
              >
                Editar
              </button>
              <button
                type="button"
                onClick={() => onPedirCierre("cancelado")}
                className="rounded-md border px-3 py-2 text-[13px]"
                style={{ borderColor: "var(--border)", color: "var(--danger)" }}
              >
                <X size={13} className="inline" /> Cancelar
              </button>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

function BotonLink({
  texto,
  url,
  onCopiar,
}: {
  texto: string;
  url: string;
  onCopiar: (url: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onCopiar(url)}
      className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-[12px]"
      style={inputStyle}
    >
      <span className="inline-flex items-center gap-1.5">
        <Link2 size={13} style={{ color: "var(--muted-foreground)" }} /> {texto}
      </span>
      <Copy size={13} style={{ color: "var(--muted-foreground)" }} />
    </button>
  );
}

/** Cerrar una entrega: entregada, no entregada o cancelada. Cada una pide lo suyo. */
function DialogoCierreEnvio({
  envio,
  destino,
  onCerrar,
  onListo,
}: {
  envio: Envio;
  destino: string;
  onCerrar: () => void;
  onListo: () => Promise<void>;
}) {
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entregada = destino === "entregado";
  const titulo = entregada
    ? "Dar por entregada"
    : destino === "no_entregado"
      ? "No se pudo entregar"
      : "Cancelar la entrega";

  async function confirmar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    const { error: err } = await supa.rpc("cambiar_estado_envio", {
      p_envio_id: envio.id,
      p_destino: destino,
      p_motivo: entregada ? null : texto.trim() || null,
      p_recibido_por: entregada ? texto.trim() || null : null,
    });
    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    await onListo();
  }

  return (
    <Modal titulo={`${titulo} · #${envio.numero}`} onCerrar={onCerrar}>
      <form onSubmit={(e) => void confirmar(e)} className="space-y-3">
        {entregada ? (
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            ¿Quién la recibió?
            <input
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="La misma clienta, el portero, la vecina…"
              autoFocus
              className={inputCls}
              style={inputStyle}
            />
            <span className="mt-1 block text-[11px]">
              Sirve para cuando alguien reclama que no recibió nada.
            </span>
          </label>
        ) : (
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            ¿Qué pasó?
            <textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              rows={3}
              autoFocus
              placeholder="No había nadie, dirección equivocada, se arrepintió…"
              className="mt-1 w-full rounded-md border px-2.5 py-2 text-[13px] outline-none"
              style={inputStyle}
            />
          </label>
        )}

        {!envio.venta_id && entregada && (
          <Alerta tono="warning">
            Esta entrega todavía no tiene venta enganchada. El sistema no la va a dejar cerrar hasta
            que la registres.
          </Alerta>
        )}

        {error && <Alerta tono="danger">{error}</Alerta>}

        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Volver</BotonSecundario>
          <BotonPrimario enviando={enviando} disabled={!entregada && texto.trim().length < 3}>
            Confirmar
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

/** Alta y edición de una entrega: todo lo que hace falta para tocar un timbre. */
function DialogoEnvio({
  envio,
  sucursalId,
  clientes,
  productos,
  disponible,
  ventas,
  onCerrar,
  onListo,
}: {
  envio: Envio | null;
  sucursalId: string;
  clientes: ClienteBreve[];
  productos: Producto[];
  disponible: Disponible[];
  ventas: VentaBreve[];
  onCerrar: () => void;
  onListo: () => Promise<void>;
}) {
  const [clienteId, setClienteId] = useState(envio?.cliente_id ?? "");
  const [ventaId, setVentaId] = useState(envio?.venta_id ?? "");
  const [destinatario, setDestinatario] = useState(envio?.destinatario ?? "");
  const [telefono, setTelefono] = useState(envio?.telefono ?? "");
  const [direccion, setDireccion] = useState(envio?.direccion ?? "");
  const [referencia, setReferencia] = useState(envio?.referencia ?? "");
  const [localidad, setLocalidad] = useState(envio?.localidad ?? "");
  const [lat, setLat] = useState(envio?.lat != null ? String(envio.lat) : "");
  const [lng, setLng] = useState(envio?.lng != null ? String(envio.lng) : "");
  const [programado, setProgramado] = useState(envio?.programado_para ?? hoyISO());
  const [franja, setFranja] = useState(envio?.franja ?? "todo_el_dia");
  const [costo, setCosto] = useState(envio?.costo_envio ? String(envio.costo_envio) : "");
  const [nota, setNota] = useState(envio?.nota ?? "");

  const [busqueda, setBusqueda] = useState("");
  const [lineas, setLineas] = useState<{ varianteId: string; nombre: string; cantidad: string }[]>(
    (envio?.envio_lineas ?? []).map((l) => ({
      varianteId: l.variante_id,
      nombre: nombreVariante(l.variantes),
      cantidad: String(l.cantidad),
    })),
  );

  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resultados = useMemo(() => {
    const texto = busqueda.trim().toLowerCase();
    if (!texto) return [];
    return productos
      .flatMap((p) => p.variantes.filter((v) => v.activa).map((v) => ({ producto: p, variante: v })))
      .filter(({ producto, variante }) =>
        [producto.nombre, producto.marca, variante.talle, variante.color, variante.sku, variante.codigo_barras]
          .filter(Boolean)
          .some((c) => String(c).toLowerCase().includes(texto)),
      )
      .slice(0, 20);
  }, [productos, busqueda]);

  function elegirCliente(id: string) {
    setClienteId(id);
    const c = clientes.find((x) => x.id === id);
    if (!c) return;
    // Sugerimos lo que ya sabemos del cliente, pero se puede pisar: una entrega
    // puede ir a la casa de la hermana.
    if (!destinatario.trim()) setDestinatario(c.nombre);
    if (!telefono.trim() && c.telefono) setTelefono(c.telefono);
    if (!direccion.trim() && c.direccion) setDireccion(c.direccion);
  }

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);

    const { error: err } = await supa.rpc("guardar_envio", {
      p_envio_id: envio?.id ?? null,
      p_sucursal_id: sucursalId,
      p_destinatario: destinatario.trim(),
      p_direccion: direccion.trim(),
      p_lineas: lineas
        .filter((l) => Math.round(aNumero(l.cantidad)) > 0)
        .map((l) => ({ variante_id: l.varianteId, cantidad: Math.round(aNumero(l.cantidad)) })),
      p_venta_id: ventaId || null,
      p_cliente_id: clienteId || null,
      p_telefono: telefono.trim() || null,
      p_referencia: referencia.trim() || null,
      p_localidad: localidad.trim() || null,
      p_lat: lat.trim() ? aNumero(lat) : null,
      p_lng: lng.trim() ? aNumero(lng) : null,
      p_programado_para: programado || null,
      p_franja: franja || null,
      p_costo_envio: aNumero(costo),
      p_nota: nota.trim() || null,
    });

    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    await onListo();
  }

  return (
    <Modal
      titulo={envio ? `Editar entrega #${envio.numero}` : "Nueva entrega"}
      ancho="max-w-2xl"
      onCerrar={onCerrar}
    >
      <form onSubmit={(e) => void guardar(e)} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Cliente (opcional)
            <select
              value={clienteId}
              onChange={(e) => elegirCliente(e.target.value)}
              className={inputCls}
              style={inputStyle}
            >
              <option value="">Sin cliente en la ficha</option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Venta que ya está hecha (opcional)
            <select
              value={ventaId}
              onChange={(e) => setVentaId(e.target.value)}
              className={inputCls}
              style={inputStyle}
            >
              <option value="">Todavía no se vendió</option>
              {ventas.map((v) => (
                <option key={v.id} value={v.id}>
                  #{v.numero} · {formatARS(Number(v.total))} · {fechaCorta(v.created_at)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            ¿A nombre de quién?
            <input
              value={destinatario}
              onChange={(e) => setDestinatario(e.target.value)}
              required
              className={inputCls}
              style={inputStyle}
            />
          </label>
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Teléfono
            <input
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              placeholder="341…"
              className={inputCls}
              style={inputStyle}
            />
          </label>
        </div>

        <div className="grid grid-cols-[2fr_1fr] gap-2">
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Dirección
            <input
              value={direccion}
              onChange={(e) => setDireccion(e.target.value)}
              required
              placeholder="Calle y número, piso, depto"
              className={inputCls}
              style={inputStyle}
            />
          </label>
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Localidad
            <input
              value={localidad}
              onChange={(e) => setLocalidad(e.target.value)}
              placeholder="Rosario"
              className={inputCls}
              style={inputStyle}
            />
          </label>
        </div>

        <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
          Referencia para encontrarlo
          <input
            value={referencia}
            onChange={(e) => setReferencia(e.target.value)}
            placeholder="Portón negro, al lado del kiosco, timbre 3"
            className={inputCls}
            style={inputStyle}
          />
        </label>

        <div className="grid grid-cols-3 gap-2">
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Día
            <input
              type="date"
              value={programado}
              onChange={(e) => setProgramado(e.target.value)}
              className={inputCls}
              style={inputStyle}
            />
          </label>
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Franja
            <select
              value={franja}
              onChange={(e) => setFranja(e.target.value)}
              className={inputCls}
              style={inputStyle}
            >
              {FRANJAS.map((f) => (
                <option key={f.valor} value={f.valor}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Costo del envío
            <input
              value={costo}
              onChange={(e) => setCosto(e.target.value)}
              inputMode="decimal"
              placeholder="0"
              className={`${inputCls} tabular`}
              style={inputStyle}
            />
          </label>
        </div>

        <div className="rounded-md border p-3" style={{ borderColor: "var(--border)" }}>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[12px] font-semibold">Qué se lleva</div>
            <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
              Sin venta hecha, esto reserva stock: no lo descuenta.
            </div>
          </div>

          <div className="relative">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2"
              style={{ color: "var(--muted-foreground)" }}
            />
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar producto por nombre, código o talle…"
              className="h-9 w-full rounded-md border pl-8 pr-3 text-[13px] outline-none"
              style={inputStyle}
            />
          </div>

          {resultados.length > 0 && (
            <div className="mt-2 max-h-40 overflow-auto rounded-md border" style={{ borderColor: "var(--border)" }}>
              {resultados.map(({ producto, variante }) => {
                const disp = disponible.find((d) => d.variante_id === variante.id)?.disponible ?? 0;
                return (
                  <button
                    key={variante.id}
                    type="button"
                    onClick={() => {
                      setLineas((ls) =>
                        ls.some((l) => l.varianteId === variante.id)
                          ? ls
                          : [
                              ...ls,
                              {
                                varianteId: variante.id,
                                nombre: [producto.nombre, variante.talle, variante.color]
                                  .filter(Boolean)
                                  .join(" · "),
                                cantidad: "1",
                              },
                            ],
                      );
                      setBusqueda("");
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px]"
                    style={{ borderBottom: "1px solid #eef1f6" }}
                  >
                    <span>
                      {producto.nombre}
                      <span style={{ color: "var(--muted-foreground)" }}>
                        {variante.talle ? ` · ${variante.talle}` : ""}
                        {variante.color ? ` · ${variante.color}` : ""}
                      </span>
                    </span>
                    <span className="tabular text-[12px]" style={{ color: disp > 0 ? "var(--success)" : "var(--danger)" }}>
                      {disp} libre{disp === 1 ? "" : "s"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {lineas.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {lineas.map((l, i) => (
                <div key={l.varianteId} className="flex items-center gap-2 text-[13px]">
                  <span className="flex-1">{l.nombre}</span>
                  <input
                    value={l.cantidad}
                    onChange={(e) =>
                      setLineas((ls) => ls.map((x, j) => (i === j ? { ...x, cantidad: e.target.value } : x)))
                    }
                    inputMode="numeric"
                    className="h-8 w-16 rounded-md border px-2 text-right text-[13px] tabular"
                    style={inputStyle}
                  />
                  <button
                    type="button"
                    onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))}
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <details>
          <summary className="cursor-pointer text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Coordenadas exactas (opcional)
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
              Latitud
              <input
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                placeholder="-32.9468"
                className={`${inputCls} tabular`}
                style={inputStyle}
              />
            </label>
            <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
              Longitud
              <input
                value={lng}
                onChange={(e) => setLng(e.target.value)}
                placeholder="-60.6393"
                className={`${inputCls} tabular`}
                style={inputStyle}
              />
            </label>
            <p className="col-span-2 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
              Se sacan de Google Maps: botón derecho sobre el punto, y los dos números que aparecen
              arriba de todo. Sin esto el mapa igual funciona, pero no marca la casa.
            </p>
          </div>
        </details>

        <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
          Nota para el repartidor
          <input
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Cobrar $12.000 al entregar"
            className={inputCls}
            style={inputStyle}
          />
        </label>

        {error && <Alerta tono="danger">{error}</Alerta>}

        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando} disabled={!destinatario.trim() || !direccion.trim()}>
            Guardar
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

/* ═══════════════════ 2. PEDIDOS A PROVEEDOR ═══════════════════ */

type LineaPedido = {
  varianteId: string;
  nombre: string;
  cantidad: string;
  costo: string;
  precio: string;
  competencia: string;
  sugerido: Sugerido | null;
};

type Sugerido = {
  costo_total: number;
  sugerido: number;
  piso: number;
  margen_categoria: number | null;
  por_margen: number;
  referencia: number | null;
  origen_referencia: string;
  precio_actual: number | null;
  unidades_90d: number;
  base: string;
};

const ORIGEN_TEXTO: Record<string, string> = {
  competencia: "el precio de la competencia que cargaste",
  misma_marca: "lo que valen en tu catálogo otros productos de la misma marca",
  misma_categoria: "lo que valen en tu catálogo otros productos de la categoría",
  sin_referencia: "todavía no hay con qué comparar",
};

const BASE_TEXTO: Record<string, string> = {
  margen_y_mercado: "Sale de tu margen histórico, ajustado para no despegarse del mercado.",
  solo_mercado: "Todavía no hay margen histórico: manda la referencia de mercado.",
  solo_margen: "Sin referencia de mercado: es costo más tu margen histórico.",
  sin_historia: "Sin historia de ventas todavía: es costo más un margen por defecto.",
};

function PedidosAProveedor({ sucursalId }: { sucursalId: string | null }) {
  const [pedidos, setPedidos] = useState<PedidoProveedor[]>([]);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [medios, setMedios] = useState<MedioPago[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  const [editando, setEditando] = useState<PedidoProveedor | null>(null);
  const [recibiendo, setRecibiendo] = useState<PedidoProveedor | null>(null);
  const [cancelando, setCancelando] = useState<PedidoProveedor | null>(null);

  const cargar = useCallback(async () => {
    setErrorCarga(null);

    let consulta = supa
      .from("pedidos_proveedor")
      .select(
        "id, numero, proveedor_id, estado, fecha_pedido, fecha_estimada, gastos_estimados, nota, compra_id, motivo_cancelacion, created_at, pedido_proveedor_lineas ( id, variante_id, cantidad, costo_unitario, precio_previsto, precio_competencia, variantes ( talle, color, productos ( nombre, marca ) ) )",
      )
      .order("created_at", { ascending: false })
      .limit(100);
    if (sucursalId) consulta = consulta.eq("sucursal_id", sucursalId);

    const [ped, prov, cat, mp] = await Promise.all([
      consulta,
      supa.from("proveedores").select("id, nombre, activo").eq("activo", true).order("nombre"),
      supa
        .from("productos")
        .select("id, nombre, marca, variantes ( id, talle, color, sku, codigo_barras, costo, precio, activa )")
        .eq("activo", true)
        .order("nombre"),
      supa
        .from("medios_pago")
        .select("id, nombre, es_cuenta_corriente")
        .eq("activo", true)
        .order("orden"),
    ]);

    const fallo = ped.error ?? prov.error ?? cat.error ?? mp.error;
    if (fallo) setErrorCarga(fallo.message);
    else {
      setPedidos((ped.data ?? []) as unknown as PedidoProveedor[]);
      setProveedores((prov.data ?? []) as Proveedor[]);
      setProductos((cat.data ?? []) as unknown as Producto[]);
      setMedios((mp.data ?? []) as MedioPago[]);
    }
    setCargando(false);
  }, [sucursalId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function avanzar(pedido: PedidoProveedor, destino: string) {
    const { error } = await supa.rpc("cambiar_estado_pedido_proveedor", {
      p_pedido_id: pedido.id,
      p_destino: destino,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    await cargar();
  }

  if (!sucursalId) {
    return (
      <div className="card-surface p-6 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
        Mirando las dos sucursales se puede leer, pero no encargar mercadería. Elegí una sucursal
        para operar.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <FormularioPedido
        key={editando?.id ?? "nuevo"}
        pedido={editando}
        sucursalId={sucursalId}
        proveedores={proveedores}
        productos={productos}
        onSalirDeEdicion={() => setEditando(null)}
        onGuardado={async () => {
          setEditando(null);
          await cargar();
        }}
        onProveedorNuevo={cargar}
      />

      {errorCarga && <Alerta tono="danger">{errorCarga}</Alerta>}

      <div className="card-surface overflow-hidden">
        <div className="px-4 py-3 text-[14px] font-semibold" style={{ borderBottom: "1px solid var(--border)" }}>
          Pedidos hechos
        </div>

        {pedidos.length === 0 ? (
          <div className="p-6 text-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            {cargando ? "Cargando…" : "Todavía no hay pedidos a proveedor."}
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr style={{ color: "var(--muted-foreground)", background: "#f9fafc" }}>
                <th className="px-4 py-2 text-left font-medium">Nº</th>
                <th className="px-4 py-2 text-left font-medium">Proveedor</th>
                <th className="px-4 py-2 text-left font-medium">Pedido</th>
                <th className="px-4 py-2 text-right font-medium">Pares</th>
                <th className="px-4 py-2 text-right font-medium">Inversión</th>
                <th className="px-4 py-2 text-left font-medium">Estado</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {pedidos.map((p) => {
                const pares = p.pedido_proveedor_lineas.reduce((s, l) => s + l.cantidad, 0);
                const inversion =
                  p.pedido_proveedor_lineas.reduce((s, l) => s + l.cantidad * Number(l.costo_unitario), 0) +
                  Number(p.gastos_estimados);
                return (
                  <tr key={p.id} style={{ borderTop: "1px solid #eef1f6" }}>
                    <td className="px-4 py-2 font-medium tabular">#{p.numero}</td>
                    <td className="px-4 py-2">
                      {proveedores.find((x) => x.id === p.proveedor_id)?.nombre ?? "—"}
                    </td>
                    <td className="px-4 py-2 tabular" style={{ color: "var(--muted-foreground)" }}>
                      {fechaCorta(p.fecha_pedido)}
                    </td>
                    <td className="px-4 py-2 text-right tabular">{pares}</td>
                    <td className="px-4 py-2 text-right tabular font-medium">{formatARS(inversion)}</td>
                    <td className="px-4 py-2">
                      <Chip
                        tone={
                          p.estado === "recibido"
                            ? "success"
                            : p.estado === "cancelado"
                              ? "danger"
                              : p.estado === "confirmado"
                                ? "violet"
                                : "warning"
                        }
                      >
                        {ESTADO_PEDIDO_LABEL[p.estado] ?? p.estado}
                      </Chip>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1.5">
                        {p.estado === "borrador" && (
                          <>
                            <BotonFila onClick={() => setEditando(p)}>Editar</BotonFila>
                            <BotonFila onClick={() => void avanzar(p, "enviado")}>Mandar</BotonFila>
                          </>
                        )}
                        {p.estado === "enviado" && (
                          <BotonFila onClick={() => void avanzar(p, "confirmado")}>
                            Lo confirmaron
                          </BotonFila>
                        )}
                        {(p.estado === "enviado" || p.estado === "confirmado") && (
                          <BotonFila destacado onClick={() => setRecibiendo(p)}>
                            <Check size={12} className="inline" /> Llegó
                          </BotonFila>
                        )}
                        {p.estado !== "recibido" && p.estado !== "cancelado" && (
                          <BotonFila peligro onClick={() => setCancelando(p)}>
                            Cancelar
                          </BotonFila>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {recibiendo && (
        <DialogoRecibir
          pedido={recibiendo}
          medios={medios}
          onCerrar={() => setRecibiendo(null)}
          onListo={async () => {
            setRecibiendo(null);
            await cargar();
          }}
        />
      )}

      {cancelando && (
        <DialogoCancelarPedido
          pedido={cancelando}
          onCerrar={() => setCancelando(null)}
          onListo={async () => {
            setCancelando(null);
            await cargar();
          }}
        />
      )}
    </div>
  );
}

function BotonFila({
  children,
  onClick,
  destacado,
  peligro,
}: {
  children: React.ReactNode;
  onClick: () => void;
  destacado?: boolean;
  peligro?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border px-2 py-1 text-[12px]"
      style={
        destacado
          ? { background: "var(--primary)", color: "var(--primary-foreground)", borderColor: "var(--primary)" }
          : { borderColor: "var(--border)", color: peligro ? "var(--danger)" : "var(--foreground)" }
      }
    >
      {children}
    </button>
  );
}

/**
 * Armar el pedido. Acá se ve lo que casi ningún sistema muestra a tiempo:
 * cuánto sale traerlo, a cuánto habría que venderlo y cuánta plata queda.
 */
function FormularioPedido({
  pedido,
  sucursalId,
  proveedores,
  productos,
  onSalirDeEdicion,
  onGuardado,
  onProveedorNuevo,
}: {
  pedido: PedidoProveedor | null;
  sucursalId: string;
  proveedores: Proveedor[];
  productos: Producto[];
  onSalirDeEdicion: () => void;
  onGuardado: () => Promise<void>;
  onProveedorNuevo: () => Promise<void>;
}) {
  const [proveedorId, setProveedorId] = useState(pedido?.proveedor_id ?? "");
  const [fechaEstimada, setFechaEstimada] = useState(pedido?.fecha_estimada ?? "");
  const [gastos, setGastos] = useState(pedido?.gastos_estimados ? String(pedido.gastos_estimados) : "");
  const [nota, setNota] = useState(pedido?.nota ?? "");
  const [nuevoProveedor, setNuevoProveedor] = useState(false);

  const [busqueda, setBusqueda] = useState("");
  const [lineas, setLineas] = useState<LineaPedido[]>(
    (pedido?.pedido_proveedor_lineas ?? []).map((l) => ({
      varianteId: l.variante_id,
      nombre: nombreVariante(l.variantes),
      cantidad: String(l.cantidad),
      costo: String(l.costo_unitario),
      precio: l.precio_previsto != null ? String(l.precio_previsto) : "",
      competencia: l.precio_competencia != null ? String(l.precio_competencia) : "",
      sugerido: null,
    })),
  );

  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalPares = lineas.reduce((s, l) => s + Math.round(aNumero(l.cantidad)), 0);
  const costoMercaderia = lineas.reduce(
    (s, l) => s + Math.round(aNumero(l.cantidad)) * aNumero(l.costo),
    0,
  );
  const gastosNum = aNumero(gastos);
  const inversion = costoMercaderia + gastosNum;
  const gastoUnitario = totalPares > 0 ? gastosNum / totalPares : 0;
  const ingresoPrevisto = lineas.reduce(
    (s, l) => s + Math.round(aNumero(l.cantidad)) * aNumero(l.precio),
    0,
  );
  const ganancia = ingresoPrevisto - inversion;
  const margen = inversion > 0 ? (ganancia / inversion) * 100 : 0;

  // El precio sugerido se recalcula solo, pero con calma: no tiene sentido
  // pegarle a la base en cada tecla mientras alguien tipea un costo.
  const claveSugerencias = lineas
    .map((l) => `${l.varianteId}:${aNumero(l.costo)}:${aNumero(l.competencia)}`)
    .join("|");

  useEffect(() => {
    if (lineas.length === 0) return;
    const t = setTimeout(() => {
      void (async () => {
        const resultados = await Promise.all(
          lineas.map(async (l) => {
            const { data, error: err } = await supa.rpc("precio_sugerido", {
              p_variante_id: l.varianteId,
              p_costo: aNumero(l.costo) || null,
              p_gasto_unitario: gastoUnitario,
              p_precio_competencia: aNumero(l.competencia) || null,
            });
            if (err) return null;
            return ((data as Sugerido[]) ?? [])[0] ?? null;
          }),
        );
        setLineas((ls) =>
          ls.map((l, i) => (i < resultados.length ? { ...l, sugerido: resultados[i] } : l)),
        );
      })();
    }, 600);
    return () => clearTimeout(t);
    // gastoUnitario entra a propósito: repartir el flete cambia el piso de cada par.
  }, [claveSugerencias, gastoUnitario]); // eslint-disable-line react-hooks/exhaustive-deps

  const resultados = useMemo(() => {
    const texto = busqueda.trim().toLowerCase();
    if (!texto) return [];
    return productos
      .flatMap((p) => p.variantes.filter((v) => v.activa).map((v) => ({ producto: p, variante: v })))
      .filter(({ producto, variante }) =>
        [producto.nombre, producto.marca, variante.talle, variante.color, variante.sku, variante.codigo_barras]
          .filter(Boolean)
          .some((c) => String(c).toLowerCase().includes(texto)),
      )
      .slice(0, 20);
  }, [productos, busqueda]);

  function limpiar() {
    setProveedorId("");
    setFechaEstimada("");
    setGastos("");
    setNota("");
    setLineas([]);
    setBusqueda("");
  }

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    const utiles = lineas.filter((l) => Math.round(aNumero(l.cantidad)) > 0);
    if (utiles.length === 0) {
      setError("El pedido no tiene ningún producto cargado.");
      return;
    }
    setEnviando(true);
    setError(null);

    const { error: err } = await supa.rpc("guardar_pedido_proveedor", {
      p_pedido_id: pedido?.id ?? null,
      p_sucursal_id: sucursalId,
      p_proveedor_id: proveedorId,
      p_lineas: utiles.map((l) => ({
        variante_id: l.varianteId,
        cantidad: Math.round(aNumero(l.cantidad)),
        costo_unitario: aNumero(l.costo),
        precio_previsto: aNumero(l.precio) || null,
        precio_competencia: aNumero(l.competencia) || null,
      })),
      p_fecha_estimada: fechaEstimada || null,
      p_gastos_estimados: gastosNum,
      p_nota: nota.trim() || null,
    });
    setEnviando(false);

    if (err) {
      setError(err.message);
      return;
    }
    limpiar();
    toast.success(pedido ? "Pedido actualizado." : "Pedido guardado como borrador.");
    await onGuardado();
  }

  return (
    <>
      <form onSubmit={(e) => void guardar(e)} className="card-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-[14px] font-semibold">
              {pedido ? `Editando el pedido #${pedido.numero}` : "Armar un pedido al proveedor"}
            </div>
            <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              Esto no toca stock ni plata. Cuando la mercadería llegue, el pedido se convierte en la
              compra.
            </div>
          </div>
          {pedido && <BotonSecundario onClick={onSalirDeEdicion}>Salir de la edición</BotonSecundario>}
        </div>

        <div className="grid grid-cols-4 items-end gap-2">
          <label className="col-span-2 block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Proveedor
            <div className="flex gap-2">
              <select
                value={proveedorId}
                onChange={(e) => setProveedorId(e.target.value)}
                required
                className={inputCls}
                style={inputStyle}
              >
                <option value="">Elegí un proveedor…</option>
                {proveedores.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setNuevoProveedor(true)}
                className="mt-1 h-9 shrink-0 rounded-md border px-2.5 text-[12px]"
                style={inputStyle}
              >
                <Plus size={13} className="inline" /> Nuevo
              </button>
            </div>
          </label>

          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            ¿Cuándo llega?
            <input
              type="date"
              value={fechaEstimada}
              onChange={(e) => setFechaEstimada(e.target.value)}
              className={inputCls}
              style={inputStyle}
            />
          </label>

          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Gastos para traerlo
            <input
              value={gastos}
              onChange={(e) => setGastos(e.target.value)}
              inputMode="decimal"
              placeholder="Flete, despacho…"
              className={`${inputCls} tabular`}
              style={inputStyle}
            />
          </label>
        </div>

        <div className="relative mt-3">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2"
            style={{ color: "var(--muted-foreground)" }}
          />
          <input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar el producto que vas a pedir…"
            className="h-9 w-full rounded-md border pl-8 pr-3 text-[13px] outline-none"
            style={inputStyle}
          />
        </div>

        {resultados.length > 0 && (
          <div className="mt-2 max-h-44 overflow-auto rounded-md border" style={{ borderColor: "var(--border)" }}>
            {resultados.map(({ producto, variante }) => (
              <button
                key={variante.id}
                type="button"
                onClick={() => {
                  setLineas((ls) =>
                    ls.some((l) => l.varianteId === variante.id)
                      ? ls
                      : [
                          ...ls,
                          {
                            varianteId: variante.id,
                            nombre: [producto.nombre, variante.talle, variante.color]
                              .filter(Boolean)
                              .join(" · "),
                            cantidad: "1",
                            costo: variante.costo ? String(variante.costo) : "",
                            precio: "",
                            competencia: "",
                            sugerido: null,
                          },
                        ],
                  );
                  setBusqueda("");
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px]"
                style={{ borderBottom: "1px solid #eef1f6" }}
              >
                <span>
                  {producto.nombre}
                  <span style={{ color: "var(--muted-foreground)" }}>
                    {variante.talle ? ` · ${variante.talle}` : ""}
                    {variante.color ? ` · ${variante.color}` : ""}
                  </span>
                </span>
                <span className="tabular text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                  hoy a {variante.precio ? formatARS(Number(variante.precio)) : "—"}
                </span>
              </button>
            ))}
          </div>
        )}

        {lineas.length === 0 ? (
          <div
            className="mt-3 rounded-md p-4 text-center text-[13px]"
            style={{ background: "#f9fafc", color: "var(--muted-foreground)" }}
          >
            Buscá arriba los productos que le vas a encargar al proveedor.
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {lineas.map((l, i) => (
              <LineaDePedido
                key={l.varianteId}
                linea={l}
                gastoUnitario={gastoUnitario}
                onCambiar={(campo, valor) =>
                  setLineas((ls) => ls.map((x, j) => (i === j ? { ...x, [campo]: valor } : x)))
                }
                onQuitar={() => setLineas((ls) => ls.filter((_, j) => j !== i))}
              />
            ))}
          </div>
        )}

        {lineas.length > 0 && (
          <div className="mt-3 grid grid-cols-5 gap-2 rounded-md p-3" style={{ background: "#f9fafc" }}>
            <Cifra titulo="Mercadería" valor={formatARS(costoMercaderia)} />
            <Cifra titulo="Gastos" valor={formatARS(gastosNum)} />
            <Cifra titulo="Lo que ponés" valor={formatARS(inversion)} fuerte />
            <Cifra titulo="Si lo vendés todo" valor={formatARS(ingresoPrevisto)} />
            <Cifra
              titulo="Te queda"
              valor={`${formatARS(ganancia)} · ${margen.toFixed(0)}%`}
              color={ganancia >= 0 ? "var(--success)" : "var(--danger)"}
              fuerte
            />
          </div>
        )}

        <label className="mt-3 block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
          Nota del pedido
          <input
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Pedido de temporada, entrega parcial acordada…"
            className={inputCls}
            style={inputStyle}
          />
        </label>

        {error && (
          <div className="mt-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}

        <div className="mt-3 flex justify-end">
          <BotonPrimario enviando={enviando} disabled={!proveedorId || lineas.length === 0}>
            {pedido ? "Guardar cambios" : "Guardar pedido"}
          </BotonPrimario>
        </div>
      </form>

      {nuevoProveedor && (
        <DialogoProveedor
          onCerrar={() => setNuevoProveedor(false)}
          onListo={async (id) => {
            setNuevoProveedor(false);
            setProveedorId(id);
            await onProveedorNuevo();
          }}
        />
      )}
    </>
  );
}

/** Una línea del pedido, con la explicación de de dónde sale el precio sugerido. */
function LineaDePedido({
  linea,
  gastoUnitario,
  onCambiar,
  onQuitar,
}: {
  linea: LineaPedido;
  gastoUnitario: number;
  onCambiar: (campo: "cantidad" | "costo" | "precio" | "competencia", valor: string) => void;
  onQuitar: () => void;
}) {
  const s = linea.sugerido;
  const costoTotal = aNumero(linea.costo) + gastoUnitario;
  const precio = aNumero(linea.precio);
  const gananciaUnidad = precio > 0 ? precio - costoTotal : 0;

  return (
    <div className="rounded-md border p-3" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-center gap-2">
        <div className="flex-1 text-[13px] font-medium">{linea.nombre}</div>
        <button type="button" onClick={onQuitar} style={{ color: "var(--muted-foreground)" }}>
          <X size={14} />
        </button>
      </div>

      <div className="mt-2 grid grid-cols-4 gap-2">
        <CampoChico
          titulo="Pares"
          valor={linea.cantidad}
          onChange={(v) => onCambiar("cantidad", v)}
        />
        <CampoChico
          titulo="Costo por par"
          valor={linea.costo}
          onChange={(v) => onCambiar("costo", v)}
        />
        <CampoChico
          titulo="Lo vendo a"
          valor={linea.precio}
          onChange={(v) => onCambiar("precio", v)}
        />
        <CampoChico
          titulo="Vi en la competencia"
          valor={linea.competencia}
          onChange={(v) => onCambiar("competencia", v)}
        />
      </div>

      {s && (
        <div className="mt-2 rounded-md p-2.5 text-[12px]" style={{ background: "#f9fafc" }}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              Costo puesto en el local{" "}
              <strong className="tabular">{formatARS(Number(s.costo_total))}</strong>
            </span>
            <span>
              Sugerido{" "}
              <strong className="tabular" style={{ color: "var(--primary)" }}>
                {formatARS(Number(s.sugerido))}
              </strong>
            </span>
            {precio > 0 && (
              <span style={{ color: gananciaUnidad >= 0 ? "var(--success)" : "var(--danger)" }}>
                Ganás {formatARS(gananciaUnidad)} por par
              </span>
            )}
            <button
              type="button"
              onClick={() => onCambiar("precio", String(s.sugerido))}
              className="rounded-md border px-2 py-0.5 text-[11px]"
              style={inputStyle}
            >
              Usar el sugerido
            </button>
          </div>

          <div className="mt-1.5" style={{ color: "var(--muted-foreground)" }}>
            {BASE_TEXTO[s.base] ?? ""}{" "}
            {s.margen_categoria != null && (
              <>
                Tu margen histórico en esta categoría es{" "}
                <strong>{Math.round(Number(s.margen_categoria) * 100)}%</strong>.{" "}
              </>
            )}
            {s.referencia != null && (
              <>
                La referencia de mercado ({formatARS(Number(s.referencia))}) sale de{" "}
                {ORIGEN_TEXTO[s.origen_referencia] ?? s.origen_referencia}.{" "}
              </>
            )}
            {s.unidades_90d > 0 && <>Se vendieron {s.unidades_90d} en los últimos 90 días. </>}
            {s.precio_actual != null && <>Hoy está a {formatARS(Number(s.precio_actual))} en tu lista.</>}
          </div>
        </div>
      )}
    </div>
  );
}

function CampoChico({
  titulo,
  valor,
  onChange,
}: {
  titulo: string;
  valor: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-[11px] font-medium" style={{ color: "var(--muted-foreground)" }}>
      {titulo}
      <input
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        placeholder="0"
        className="mt-1 h-8 w-full rounded-md border px-2 text-right text-[13px] tabular outline-none"
        style={inputStyle}
      />
    </label>
  );
}

function Cifra({
  titulo,
  valor,
  color,
  fuerte,
}: {
  titulo: string;
  valor: string;
  color?: string;
  fuerte?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
        {titulo}
      </div>
      <div
        className="tabular"
        style={{ fontSize: fuerte ? 15 : 14, fontWeight: fuerte ? 600 : 500, color }}
      >
        {valor}
      </div>
    </div>
  );
}

/**
 * Llegó la mercadería. Acá se corrige lo que vino distinto de lo pedido y recién
 * ahí se registra la compra: una sola puerta para que entre mercadería.
 */
function DialogoRecibir({
  pedido,
  medios,
  onCerrar,
  onListo,
}: {
  pedido: PedidoProveedor;
  medios: MedioPago[];
  onCerrar: () => void;
  onListo: () => Promise<void>;
}) {
  const mediosContado = useMemo(() => medios.filter((m) => !m.es_cuenta_corriente), [medios]);

  const [lineas, setLineas] = useState(
    pedido.pedido_proveedor_lineas.map((l) => ({
      varianteId: l.variante_id,
      nombre: nombreVariante(l.variantes),
      cantidad: String(l.cantidad),
      costo: String(l.costo_unitario),
    })),
  );
  const [fecha, setFecha] = useState(hoyISO);
  const [tipo, setTipo] = useState("factura_a");
  const [puntoVenta, setPuntoVenta] = useState("");
  const [numero, setNumero] = useState("");
  const [pagos, setPagos] = useState<{ medioId: string; monto: string }[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = lineas.reduce((s, l) => s + Math.round(aNumero(l.cantidad)) * aNumero(l.costo), 0);
  const pagado = pagos.reduce((s, p) => s + aNumero(p.monto), 0);

  async function recibir(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);

    const { error: err } = await supa.rpc("recibir_pedido_proveedor", {
      p_pedido_id: pedido.id,
      p_lineas: lineas
        .filter((l) => Math.round(aNumero(l.cantidad)) > 0)
        .map((l) => ({
          variante_id: l.varianteId,
          cantidad: Math.round(aNumero(l.cantidad)),
          costo_unitario: aNumero(l.costo),
        })),
      p_pagos: pagos.map((p) => ({ medio_pago_id: p.medioId, monto: aNumero(p.monto) })),
      p_fecha: fecha,
      p_tipo_comprobante: tipo,
      p_punto_venta: puntoVenta || null,
      p_numero_comprobante: numero || null,
    });
    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    toast.success("Mercadería recibida. Ya entró al stock como compra.");
    await onListo();
  }

  return (
    <Modal titulo={`Recibir el pedido #${pedido.numero}`} ancho="max-w-2xl" onCerrar={onCerrar}>
      <form onSubmit={(e) => void recibir(e)} className="space-y-3">
        <p className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
          Corregí lo que vino distinto de lo pedido. Lo que confirmes acá es lo que entra al stock y
          lo que le vas a deber al proveedor.
        </p>

        <div className="space-y-1.5">
          {lineas.map((l, i) => (
            <div key={l.varianteId} className="flex items-center gap-2 text-[13px]">
              <span className="flex-1">{l.nombre}</span>
              <input
                value={l.cantidad}
                onChange={(e) =>
                  setLineas((ls) => ls.map((x, j) => (i === j ? { ...x, cantidad: e.target.value } : x)))
                }
                inputMode="numeric"
                className="h-8 w-16 rounded-md border px-2 text-right text-[13px] tabular"
                style={inputStyle}
              />
              <input
                value={l.costo}
                onChange={(e) =>
                  setLineas((ls) => ls.map((x, j) => (i === j ? { ...x, costo: e.target.value } : x)))
                }
                inputMode="decimal"
                className="h-8 w-28 rounded-md border px-2 text-right text-[13px] tabular"
                style={inputStyle}
              />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-4 gap-2">
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Fecha
            <input
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              className={inputCls}
              style={inputStyle}
            />
          </label>
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Comprobante
            <select
              value={tipo}
              onChange={(e) => setTipo(e.target.value)}
              className={inputCls}
              style={inputStyle}
            >
              <option value="factura_a">Factura A</option>
              <option value="factura_b">Factura B</option>
              <option value="factura_c">Factura C</option>
              <option value="remito">Remito</option>
              <option value="sin_comprobante">Sin comprobante</option>
            </select>
          </label>
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Punto de venta
            <input
              value={puntoVenta}
              onChange={(e) => setPuntoVenta(e.target.value)}
              className={`${inputCls} tabular`}
              style={inputStyle}
            />
          </label>
          <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Número
            <input
              value={numero}
              onChange={(e) => setNumero(e.target.value)}
              className={`${inputCls} tabular`}
              style={inputStyle}
            />
          </label>
        </div>

        <div className="rounded-md border p-3" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center justify-between">
            <div className="text-[12px] font-semibold">Pagos</div>
            <button
              type="button"
              onClick={() =>
                setPagos((p) =>
                  mediosContado.length === 0 ? p : [...p, { medioId: mediosContado[0].id, monto: "" }],
                )
              }
              className="rounded-md border px-2 py-0.5 text-[11px]"
              style={inputStyle}
            >
              <Plus size={11} className="inline" /> Agregar pago
            </button>
          </div>

          {pagos.length === 0 ? (
            <div className="mt-2 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              Sin pagos cargados queda todo como deuda con el proveedor. Es lo normal cuando se paga
              a 30 días.
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              {pagos.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={p.medioId}
                    onChange={(e) =>
                      setPagos((ps) => ps.map((x, j) => (i === j ? { ...x, medioId: e.target.value } : x)))
                    }
                    className="h-9 flex-1 rounded-md border px-2 text-[13px]"
                    style={inputStyle}
                  >
                    {mediosContado.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.nombre}
                      </option>
                    ))}
                  </select>
                  <input
                    value={p.monto}
                    onChange={(e) =>
                      setPagos((ps) => ps.map((x, j) => (i === j ? { ...x, monto: e.target.value } : x)))
                    }
                    inputMode="decimal"
                    placeholder="0"
                    className="h-9 w-32 rounded-md border px-2 text-right text-[13px] tabular"
                    style={inputStyle}
                  />
                  <button
                    type="button"
                    onClick={() => setPagos((ps) => ps.filter((_, j) => j !== i))}
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-between rounded-md p-3 text-[13px]" style={{ background: "#f9fafc" }}>
          <span>Total de la compra</span>
          <span className="tabular font-semibold">{formatARS(total)}</span>
        </div>
        {pagado > 0 && pagado < total && (
          <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Quedan {formatARS(total - pagado)} de deuda con el proveedor.
          </div>
        )}

        {error && <Alerta tono="danger">{error}</Alerta>}

        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando} disabled={total <= 0}>
            Recibir y registrar la compra
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

function DialogoCancelarPedido({
  pedido,
  onCerrar,
  onListo,
}: {
  pedido: PedidoProveedor;
  onCerrar: () => void;
  onListo: () => Promise<void>;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancelar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    const { error: err } = await supa.rpc("cambiar_estado_pedido_proveedor", {
      p_pedido_id: pedido.id,
      p_destino: "cancelado",
      p_motivo: motivo.trim(),
    });
    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    await onListo();
  }

  return (
    <Modal titulo={`Cancelar el pedido #${pedido.numero}`} onCerrar={onCerrar}>
      <form onSubmit={(e) => void cancelar(e)} className="space-y-3">
        <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
          ¿Por qué se cancela?
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            rows={3}
            autoFocus
            placeholder="No tenían stock, se cayó el acuerdo de precio…"
            className="mt-1 w-full rounded-md border px-2.5 py-2 text-[13px] outline-none"
            style={inputStyle}
          />
        </label>
        {error && <Alerta tono="danger">{error}</Alerta>}
        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Volver</BotonSecundario>
          <BotonPrimario enviando={enviando} disabled={motivo.trim().length < 3}>
            Cancelar el pedido
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}
