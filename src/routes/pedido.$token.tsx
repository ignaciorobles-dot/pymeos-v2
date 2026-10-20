import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ClipboardList, Clock, MapPin, Package, Truck, XCircle } from "lucide-react";
import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";

/**
 * El comprobante del pedido online: lo que ve el comprador apenas confirma, y
 * lo que vuelve a abrir después para saber en qué anda.
 *
 * La llave es el token del link, igual que en el seguimiento de la entrega. No
 * hay login: del otro lado hay una función que devuelve solo este pedido.
 *
 * Cuando el local genera la entrega, aparece el link del mapa en vivo: ahí el
 * seguimiento pasa a ser el de siempre, el mismo que usa el reparto propio.
 */

export const Route = createFileRoute("/pedido/$token")({
  head: () => ({
    meta: [
      { title: "Tu pedido" },
      { name: "description", content: "El estado de tu pedido, al día." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PedidoOnline,
});

type LineaPedido = {
  producto: string;
  talle: string | null;
  color: string | null;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
};

type Pedido = {
  numero: number;
  estado: string;
  entrega: string;
  pago: string;
  nombre: string;
  direccion: string | null;
  localidad: string | null;
  subtotal: number;
  costo_envio: number;
  total: number;
  created_at: string;
  token_envio: string | null;
  local_nombre: string | null;
  local_direccion: string | null;
  whatsapp: string | null;
  texto_retiro: string | null;
  lineas: LineaPedido[] | null;
};

const PASOS_RETIRO = [
  { estado: "pendiente", texto: "Recibimos tu pedido", icono: ClipboardList },
  { estado: "confirmado", texto: "El local lo confirmó", icono: CheckCircle2 },
  { estado: "listo", texto: "Listo para retirar", icono: Package },
  { estado: "entregado", texto: "Retirado", icono: CheckCircle2 },
];

const PASOS_ENVIO = [
  { estado: "pendiente", texto: "Recibimos tu pedido", icono: ClipboardList },
  { estado: "confirmado", texto: "El local lo confirmó", icono: CheckCircle2 },
  { estado: "listo", texto: "Preparado para salir", icono: Package },
  { estado: "entregado", texto: "Entregado", icono: Truck },
];

function PedidoOnline() {
  const { token } = Route.useParams();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["pedido-online", token],
    queryFn: async () => {
      const { data, error } = await supa.rpc("seguimiento_pedido_online", { p_token: token });
      if (error) throw error;
      return ((data as Pedido[]) ?? [])[0] ?? null;
    },
    // Mientras el local todavía no lo cerró conviene mirar cada tanto, sin
    // exagerar: del otro lado hay alguien con los datos del celular contados.
    refetchInterval: (q) => {
      const e = (q.state.data as Pedido | null)?.estado;
      return e === "entregado" || e === "cancelado" ? false : 45_000;
    },
  });

  if (isLoading) return <Centro>Buscando tu pedido…</Centro>;

  if (isError || !data) {
    return (
      <Centro>
        <div className="text-[15px] font-semibold">No encontramos este pedido</div>
        <p className="mt-1.5 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
          Puede que el link esté incompleto. Copialo entero del mensaje, o escribinos y te lo
          mandamos de nuevo.
        </p>
        <Link
          to="/comprar"
          className="mt-4 inline-flex h-10 items-center rounded-md px-4 text-[13px] font-medium text-white"
          style={{ background: "var(--primary)" }}
        >
          Ir a la tienda
        </Link>
      </Centro>
    );
  }

  const pasos = data.entrega === "envio" ? PASOS_ENVIO : PASOS_RETIRO;
  const pasoActual = pasos.findIndex((p) => p.estado === data.estado);
  const cancelado = data.estado === "cancelado";
  const wpp = data.whatsapp?.replace(/\D/g, "");

  return (
    <div className="min-h-screen px-4 py-6" style={{ background: "var(--background)" }}>
      <div className="mx-auto w-full max-w-[520px]">
        <div className="mb-4 text-center">
          <div className="text-[15px] font-semibold">{data.local_nombre ?? "Tu pedido"}</div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Pedido #{data.numero} ·{" "}
            {new Date(data.created_at).toLocaleDateString("es-AR", { day: "numeric", month: "long" })}
          </div>
        </div>

        <div className="card-surface p-5" style={{ background: "var(--surface)" }}>
          <h1 className="text-[17px] font-semibold">
            {data.nombre ? `Hola ${data.nombre}, ` : ""}
            {titulo(data)}
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            {subtitulo(data)}
          </p>

          {data.estado === "iniciado" && (
            <div
              className="mt-4 rounded-md p-3 text-[13px]"
              style={{ background: "var(--warning-bg)", color: "var(--warning)" }}
            >
              <Clock size={14} className="mb-0.5 mr-1 inline" />
              Estamos esperando que se acredite el pago. Si ya pagaste, en unos minutos se
              actualiza solo.
            </div>
          )}

          {cancelado ? (
            <div
              className="mt-4 rounded-md p-3 text-[13px]"
              style={{ background: "var(--danger-bg)", color: "var(--danger)" }}
            >
              <XCircle size={14} className="mb-0.5 mr-1 inline" />
              Este pedido fue cancelado. Si fue un error, escribinos y lo volvemos a armar.
            </div>
          ) : (
            <ol className="mt-5">
              {pasos.map((paso, i) => {
                const hecho = pasoActual >= 0 && i <= pasoActual;
                const Icono = paso.icono;
                return (
                  <li key={paso.estado} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div
                        className="grid h-7 w-7 place-items-center rounded-full"
                        style={{
                          background: hecho ? "var(--success-bg)" : "#eef1f6",
                          color: hecho ? "var(--success)" : "#98a2b3",
                        }}
                      >
                        <Icono size={14} />
                      </div>
                      {i < pasos.length - 1 && (
                        <div
                          style={{
                            width: 2,
                            flex: 1,
                            minHeight: 18,
                            background: pasoActual > i ? "var(--success)" : "#eef1f6",
                          }}
                        />
                      )}
                    </div>
                    <div className="pb-3">
                      <div
                        className="text-[13px]"
                        style={{
                          fontWeight: i === pasoActual ? 600 : 400,
                          color: hecho ? "var(--foreground)" : "var(--muted-foreground)",
                        }}
                      >
                        {paso.texto}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {data.token_envio && (
            <Link
              to="/seguimiento/$token"
              params={{ token: data.token_envio }}
              className="mt-1 flex h-11 w-full items-center justify-center gap-2 rounded-md text-[13px] font-medium text-white"
              style={{ background: "var(--primary)" }}
            >
              <MapPin size={14} /> Ver la entrega en el mapa
            </Link>
          )}
        </div>

        <div className="card-surface mt-4 p-4" style={{ background: "var(--surface)" }}>
          <div
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: "var(--muted-foreground)" }}
          >
            Lo que pediste
          </div>
          <div className="mt-2">
            {(data.lineas ?? []).map((l, i) => (
              <div key={i} className="flex gap-3 border-b py-2 last:border-0" style={{ borderColor: "#eef1f6" }}>
                <span className="text-[13px] tabular" style={{ color: "var(--muted-foreground)" }}>
                  {l.cantidad}×
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px]">{l.producto}</div>
                  {(l.talle || l.color) && (
                    <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                      {[l.talle && `Talle ${l.talle}`, l.color].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
                <span className="text-[13px] tabular">{formatARS(Number(l.subtotal))}</span>
              </div>
            ))}
          </div>

          <div className="mt-3 flex justify-between text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            <span>Productos</span>
            <span className="tabular">{formatARS(Number(data.subtotal))}</span>
          </div>
          {Number(data.costo_envio) > 0 && (
            <div className="flex justify-between text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              <span>Envío</span>
              <span className="tabular">{formatARS(Number(data.costo_envio))}</span>
            </div>
          )}
          <div className="mt-1 flex justify-between text-[15px] font-semibold">
            <span>Total</span>
            <span className="tabular">{formatARS(Number(data.total))}</span>
          </div>
          <div className="mt-1 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            {data.pago === "mercadopago" ? "Pagado por Mercado Pago" : "Se paga al recibirlo"}
          </div>
        </div>

        <div className="card-surface mt-4 p-4" style={{ background: "var(--surface)" }}>
          <div
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: "var(--muted-foreground)" }}
          >
            {data.entrega === "envio" ? "Dirección de entrega" : "Dónde retirarlo"}
          </div>
          <div className="mt-1 text-[13px]">
            {data.entrega === "envio"
              ? [data.direccion, data.localidad].filter(Boolean).join(", ")
              : data.local_direccion ?? "Te avisamos por WhatsApp."}
          </div>
          {data.entrega === "retiro" && data.texto_retiro && (
            <div className="mt-1.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              {data.texto_retiro}
            </div>
          )}
        </div>

        {wpp && (
          <a
            href={`https://wa.me/${wpp}?text=${encodeURIComponent(`Hola! Consulta por el pedido #${data.numero}`)}`}
            target="_blank"
            rel="noreferrer"
            className="mt-4 flex h-11 items-center justify-center rounded-md border text-[13px] font-medium"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
          >
            Escribirnos por WhatsApp
          </a>
        )}

        <p className="mt-4 text-center text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          Guardá este link: es tu comprobante y se actualiza solo.
        </p>
      </div>
    </div>
  );
}

function titulo(p: Pedido) {
  switch (p.estado) {
    case "iniciado":
      return "falta confirmar el pago";
    case "pendiente":
      return "recibimos tu pedido";
    case "confirmado":
      return "lo estamos preparando";
    case "listo":
      return p.entrega === "envio" ? "está listo para salir" : "podés pasar a retirarlo";
    case "entregado":
      return "listo, ya lo tenés";
    default:
      return "el pedido fue cancelado";
  }
}

function subtitulo(p: Pedido) {
  switch (p.estado) {
    case "iniciado":
      return "En cuanto se acredite, el local lo empieza a preparar.";
    case "pendiente":
      return "El local lo revisa y te confirma. Te avisamos por acá y por WhatsApp.";
    case "confirmado":
      return "Estamos armando el pedido. Falta poco.";
    case "listo":
      return p.entrega === "envio"
        ? "Cuando salga vas a poder seguirlo en el mapa."
        : "Te esperamos en el local con este número de pedido.";
    case "entregado":
      return "Gracias por la compra. Cualquier cosa, escribinos.";
    default:
      return "Si fue un error, escribinos y lo arreglamos.";
  }
}

function Centro({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-4" style={{ background: "var(--background)" }}>
      <div className="card-surface max-w-sm p-6 text-center" style={{ background: "var(--surface)" }}>
        {children}
      </div>
    </div>
  );
}
