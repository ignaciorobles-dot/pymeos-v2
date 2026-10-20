import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Package, Truck, CheckCircle2, XCircle, Clock } from "lucide-react";
import { supa } from "@/lib/supabase";
import { MapaOSM, type PuntoMapa } from "@/components/mapa/MapaOSM";

/**
 * La pantalla que abre el cliente cuando le mandan el link por WhatsApp.
 *
 * No hay login ni cuenta: la llave es el token del link. Del otro lado hay una
 * función que devuelve poco a propósito (ni teléfono, ni qué se compró, ni
 * cuánto salió), porque un link de WhatsApp termina donde termina.
 */

export const Route = createFileRoute("/seguimiento/$token")({
  head: () => ({
    meta: [
      { title: "Seguí tu pedido" },
      { name: "description", content: "Mirá en qué anda tu entrega, en vivo." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Seguimiento,
});

type Seguimiento = {
  numero: number;
  estado: string;
  destinatario: string | null;
  direccion: string;
  localidad: string | null;
  destino_lat: number | null;
  destino_lng: number | null;
  repartidor: string | null;
  salida_at: string | null;
  entrega_at: string | null;
  programado_para: string | null;
  franja: string | null;
  origen_lat: number | null;
  origen_lng: number | null;
  local_nombre: string | null;
  ultima_lat: number | null;
  ultima_lng: number | null;
  ultima_at: string | null;
};

const PASOS = [
  { estado: "pendiente", texto: "Recibimos tu pedido", icono: Clock },
  { estado: "preparando", texto: "Lo estamos preparando", icono: Package },
  { estado: "en_camino", texto: "Salió para tu casa", icono: Truck },
  { estado: "entregado", texto: "Entregado", icono: CheckCircle2 },
];

const FRANJA_TEXTO: Record<string, string> = {
  "mañana": "por la mañana",
  tarde: "por la tarde",
  todo_el_dia: "en el día",
};

function hora(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

function haceCuanto(iso: string | null) {
  if (!iso) return null;
  const minutos = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutos < 1) return "recién";
  if (minutos === 1) return "hace 1 minuto";
  if (minutos < 60) return `hace ${minutos} minutos`;
  return `a las ${hora(iso)}`;
}

function Seguimiento() {
  const { token } = Route.useParams();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["seguimiento", token],
    queryFn: async () => {
      const { data, error } = await supa.rpc("seguimiento_envio", { p_token: token });
      if (error) throw error;
      return ((data as Seguimiento[]) ?? [])[0] ?? null;
    },
    // Mientras el pedido va en camino conviene mirar seguido; una vez entregado
    // no cambia más y no tiene sentido seguir pidiendo datos desde el celular
    // de alguien que capaz está con los datos justos.
    refetchInterval: (q) => {
      const e = (q.state.data as Seguimiento | null)?.estado;
      return e === "en_camino" ? 12_000 : e && e !== "pendiente" && e !== "preparando" ? false : 60_000;
    },
  });

  const { data: recorrido } = useQuery({
    queryKey: ["recorrido", token],
    enabled: data?.estado === "en_camino",
    refetchInterval: 12_000,
    queryFn: async () => {
      const { data, error } = await supa.rpc("recorrido_envio", { p_token: token });
      if (error) throw error;
      return ((data as { lat: number; lng: number }[]) ?? []).slice().reverse();
    },
  });

  if (isLoading) {
    return <Centro>Buscando tu pedido…</Centro>;
  }

  if (isError || !data) {
    return (
      <Centro>
        <div className="text-[15px] font-semibold">No encontramos este pedido</div>
        <p className="mt-1.5 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
          Puede que el link esté incompleto. Copialo entero del mensaje, o escribinos y te lo
          mandamos de nuevo.
        </p>
      </Centro>
    );
  }

  const puntos: PuntoMapa[] = [];
  if (data.ultima_lat != null && data.ultima_lng != null && data.estado === "en_camino") {
    puntos.push({
      lat: Number(data.ultima_lat),
      lng: Number(data.ultima_lng),
      tipo: "repartidor",
      etiqueta: data.repartidor ?? "El reparto",
    });
  }
  if (data.destino_lat != null && data.destino_lng != null) {
    puntos.push({ lat: Number(data.destino_lat), lng: Number(data.destino_lng), tipo: "destino", etiqueta: "Tu casa" });
  }
  if (data.origen_lat != null && data.origen_lng != null && puntos.length < 2) {
    puntos.push({ lat: Number(data.origen_lat), lng: Number(data.origen_lng), tipo: "local", etiqueta: data.local_nombre ?? "El local" });
  }

  const pasoActual = PASOS.findIndex((p) => p.estado === data.estado);
  const cerrado = data.estado === "entregado" || data.estado === "cancelado" || data.estado === "no_entregado";

  return (
    <div className="min-h-screen px-4 py-6" style={{ background: "var(--background)" }}>
      <div className="mx-auto w-full max-w-[520px]">
        <div className="mb-4 text-center">
          <div className="text-[20px] font-bold tracking-tight">
            Pyme<span style={{ color: "var(--primary)" }}>OS</span>
          </div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            {data.local_nombre ?? "Tu pedido"} · Entrega #{data.numero}
          </div>
        </div>

        <div className="card-surface p-5" style={{ background: "var(--surface)" }}>
          <h1 className="text-[17px] font-semibold">
            {data.destinatario ? `Hola ${data.destinatario}, ` : ""}
            {textoEstado(data)}
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            {subtituloEstado(data)}
          </p>

          {data.estado !== "cancelado" && data.estado !== "no_entregado" && (
            <ol className="mt-5">
              {PASOS.map((paso, i) => {
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
                      {i < PASOS.length - 1 && (
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
                      {paso.estado === "en_camino" && data.salida_at && (
                        <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                          Salió a las {hora(data.salida_at)}
                        </div>
                      )}
                      {paso.estado === "entregado" && data.entrega_at && (
                        <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                          A las {hora(data.entrega_at)}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {data.estado === "no_entregado" && (
            <div
              className="mt-4 rounded-md p-3 text-[13px]"
              style={{ background: "var(--warning-bg)", color: "var(--warning)" }}
            >
              <XCircle size={14} className="mb-1 inline" /> No pudimos entregarlo. Vamos a
              intentarlo de nuevo: si querés coordinar un horario, escribinos.
            </div>
          )}
        </div>

        {puntos.length > 0 && !cerrado && (
          <div className="card-surface mt-4 overflow-hidden" style={{ background: "var(--surface)" }}>
            <MapaOSM puntos={puntos} recorrido={recorrido} alto={280} />
            <div className="flex items-center justify-between px-4 py-2.5 text-[12px]">
              <span style={{ color: "var(--muted-foreground)" }}>
                {data.estado === "en_camino" && data.ultima_at
                  ? `Última posición ${haceCuanto(data.ultima_at)}`
                  : "El mapa se enciende cuando el pedido sale del local"}
              </span>
              {data.repartidor && <span className="font-medium">{data.repartidor}</span>}
            </div>
          </div>
        )}

        <div className="card-surface mt-4 p-4" style={{ background: "var(--surface)" }}>
          <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-foreground)" }}>
            Dirección de entrega
          </div>
          <div className="mt-1 text-[13px]">
            {data.direccion}
            {data.localidad ? `, ${data.localidad}` : ""}
          </div>
          {data.programado_para && !cerrado && (
            <div className="mt-2 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              Previsto para el{" "}
              {new Date(`${data.programado_para}T12:00:00`).toLocaleDateString("es-AR", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
              {data.franja ? ` ${FRANJA_TEXTO[data.franja] ?? ""}` : ""}.
            </div>
          )}
        </div>

        <p className="mt-4 text-center text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          Esta página se actualiza sola. No hace falta que la recargues.
        </p>
      </div>
    </div>
  );
}

function textoEstado(e: Seguimiento) {
  switch (e.estado) {
    case "pendiente":
      return "recibimos tu pedido";
    case "preparando":
      return "lo estamos preparando";
    case "en_camino":
      return "tu pedido va en camino";
    case "entregado":
      return "tu pedido fue entregado";
    case "no_entregado":
      return "no pudimos entregarlo";
    default:
      return "el pedido fue cancelado";
  }
}

function subtituloEstado(e: Seguimiento) {
  switch (e.estado) {
    case "pendiente":
      return "En cuanto lo preparemos te vas a enterar acá mismo.";
    case "preparando":
      return "Estamos armando el paquete. Falta poco.";
    case "en_camino":
      return e.repartidor
        ? `${e.repartidor} lo está llevando. Podés ver por dónde va en el mapa.`
        : "Podés ver por dónde va en el mapa.";
    case "entregado":
      return "Gracias por la compra. Cualquier cosa, escribinos.";
    case "no_entregado":
      return "Vamos a volver a intentarlo.";
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
