import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { MapPin, Navigation, Phone, Package, CheckCircle2, AlertTriangle, Radio } from "lucide-react";
import { toast } from "sonner";
import { supa } from "@/lib/supabase";
import { Modal, inputCls, inputStyle } from "@/components/ui-bits/Modal";

/**
 * La pantalla que abre el que reparte, en su celular.
 *
 * No tiene login: el link con su token es la llave. Mientras el envío está en
 * camino, el navegador va contando dónde está y esto lo publica. Esa es toda la
 * "API de GPS" que hace falta: el celular que ya tiene en la mano.
 *
 * El seguimiento se apaga solo. Del lado del servidor, publicar_posicion no
 * guarda nada si el envío ya no está en camino, así que nadie queda
 * transmitiendo su ubicación por haberse olvidado una pestaña abierta.
 */

export const Route = createFileRoute("/reparto/$token")({
  head: () => ({
    meta: [
      { title: "Reparto" },
      { name: "description", content: "Hoja de ruta de la entrega." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Reparto,
});

type Hoja = {
  envio_id: string;
  numero: number;
  estado: string;
  destinatario: string;
  telefono: string | null;
  direccion: string;
  referencia: string | null;
  localidad: string | null;
  destino_lat: number | null;
  destino_lng: number | null;
  nota: string | null;
  productos: string | null;
};

const ESTADO_TEXTO: Record<string, string> = {
  pendiente: "Sin salir",
  preparando: "Preparando",
  en_camino: "En camino",
  entregado: "Entregado",
  no_entregado: "No entregado",
  cancelado: "Cancelado",
};

function Reparto() {
  const { token } = Route.useParams();
  const qc = useQueryClient();
  const [dialogo, setDialogo] = useState<null | "entregado" | "no_entregado">(null);
  const [recibidoPor, setRecibidoPor] = useState("");
  const [motivo, setMotivo] = useState("");
  const [gps, setGps] = useState<{ estado: "apagado" | "buscando" | "activo" | "error"; detalle?: string }>({
    estado: "apagado",
  });
  const vigilancia = useRef<number | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["reparto", token],
    queryFn: async () => {
      const { data, error } = await supa.rpc("envio_del_repartidor", { p_token: token });
      if (error) throw error;
      return ((data as Hoja[]) ?? [])[0] ?? null;
    },
  });

  const cambiar = useMutation({
    mutationFn: async (v: { destino: string; motivo?: string; recibido_por?: string }) => {
      const { data, error } = await supa.rpc("repartidor_cambiar_estado", {
        p_token: token,
        p_destino: v.destino,
        p_motivo: v.motivo ?? null,
        p_recibido_por: v.recibido_por ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reparto", token] });
      setDialogo(null);
      setRecibidoPor("");
      setMotivo("");
    },
    onError: (e: { message?: string }) => toast.error(e?.message ?? "No se pudo cambiar el estado"),
  });

  const enCamino = data?.estado === "en_camino";

  // El navegador avisa cada vez que la posición cambia. Cada aviso se publica
  // tal cual: el servidor decide si lo guarda o no según el estado del envío.
  useEffect(() => {
    if (!enCamino) {
      if (vigilancia.current !== null) {
        navigator.geolocation.clearWatch(vigilancia.current);
        vigilancia.current = null;
      }
      setGps({ estado: "apagado" });
      return;
    }

    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setGps({ estado: "error", detalle: "Este celular no comparte ubicación." });
      return;
    }

    setGps({ estado: "buscando" });
    const id = navigator.geolocation.watchPosition(
      async (pos) => {
        setGps({ estado: "activo" });
        const { error } = await supa.rpc("publicar_posicion", {
          p_token: token,
          p_lat: pos.coords.latitude,
          p_lng: pos.coords.longitude,
          p_precision_m: pos.coords.accuracy ?? null,
        });
        if (error) setGps({ estado: "error", detalle: "Sin señal para enviar la posición." });
      },
      (err) => {
        setGps({
          estado: "error",
          detalle:
            err.code === err.PERMISSION_DENIED
              ? "Falta darle permiso de ubicación a esta página."
              : "No se pudo tomar la ubicación.",
        });
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );
    vigilancia.current = id;

    return () => {
      navigator.geolocation.clearWatch(id);
      vigilancia.current = null;
    };
  }, [enCamino, token]);

  if (isLoading) {
    return <Centro>Buscando la entrega…</Centro>;
  }

  if (isError || !data) {
    return (
      <Centro>
        <div className="text-[15px] font-semibold">Este link no sirve</div>
        <p className="mt-1.5 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
          Puede estar cortado. Pedí que te lo manden de nuevo, entero.
        </p>
      </Centro>
    );
  }

  const cerrado = ["entregado", "no_entregado", "cancelado"].includes(data.estado);
  const comoLlegar =
    data.destino_lat != null && data.destino_lng != null
      ? `https://www.google.com/maps/dir/?api=1&destination=${data.destino_lat},${data.destino_lng}`
      : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
          `${data.direccion} ${data.localidad ?? ""}`.trim(),
        )}`;

  return (
    <div className="min-h-screen pb-28" style={{ background: "var(--background)" }}>
      <div
        className="px-4 py-3"
        style={{ background: "var(--sidebar)", color: "var(--sidebar-foreground)" }}
      >
        <div className="mx-auto flex max-w-[520px] items-center justify-between">
          <div className="text-[13px] font-semibold">Entrega #{data.numero}</div>
          <div className="text-[12px]" style={{ color: "var(--sidebar-muted)" }}>
            {ESTADO_TEXTO[data.estado] ?? data.estado}
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[520px] px-4 py-4">
        <div className="card-surface p-4" style={{ background: "var(--surface)" }}>
          <div className="text-[17px] font-semibold">{data.destinatario}</div>
          <div className="mt-2 flex gap-2 text-[14px]">
            <MapPin size={16} className="mt-0.5 shrink-0" style={{ color: "var(--primary)" }} />
            <div>
              <div>{data.direccion}</div>
              {data.localidad && (
                <div style={{ color: "var(--muted-foreground)" }}>{data.localidad}</div>
              )}
              {data.referencia && (
                <div className="mt-1 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                  {data.referencia}
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <a
              href={comoLlegar}
              target="_blank"
              rel="noreferrer"
              className="flex h-11 items-center justify-center gap-2 rounded-md text-[14px] font-medium text-white"
              style={{ background: "var(--primary)" }}
            >
              <Navigation size={16} /> Cómo llegar
            </a>
            {data.telefono ? (
              <a
                href={`tel:${data.telefono.replace(/[^\d+]/g, "")}`}
                className="flex h-11 items-center justify-center gap-2 rounded-md border text-[14px] font-medium"
                style={{ borderColor: "var(--border)", background: "var(--surface)" }}
              >
                <Phone size={16} /> Llamar
              </a>
            ) : (
              <div
                className="flex h-11 items-center justify-center rounded-md border text-[13px]"
                style={{ borderColor: "var(--border)", color: "var(--muted-foreground)" }}
              >
                Sin teléfono
              </div>
            )}
          </div>
        </div>

        {data.productos && (
          <div className="card-surface mt-3 p-4" style={{ background: "var(--surface)" }}>
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-foreground)" }}>
              <Package size={13} /> Qué lleva
            </div>
            <div className="mt-2 whitespace-pre-line text-[14px]">{data.productos}</div>
          </div>
        )}

        {data.nota && (
          <div
            className="mt-3 rounded-md p-3 text-[13px]"
            style={{ background: "var(--warning-bg)", color: "var(--warning)" }}
          >
            {data.nota}
          </div>
        )}

        {enCamino && (
          <div
            className="mt-3 flex items-center gap-2 rounded-md p-3 text-[13px]"
            style={{
              background: gps.estado === "error" ? "var(--danger-bg)" : "var(--success-bg)",
              color: gps.estado === "error" ? "var(--danger)" : "var(--success)",
            }}
          >
            <Radio size={15} className="shrink-0" />
            {gps.estado === "activo" && "El cliente está viendo por dónde vas."}
            {gps.estado === "buscando" && "Buscando la ubicación…"}
            {gps.estado === "error" && gps.detalle}
            {gps.estado === "apagado" && "Ubicación apagada."}
          </div>
        )}

        {cerrado && (
          <div className="card-surface mt-3 p-4 text-center text-[14px]" style={{ background: "var(--surface)" }}>
            {data.estado === "entregado"
              ? "Entrega cerrada. Gracias."
              : data.estado === "no_entregado"
                ? "Quedó como no entregada. En el local la reprograman."
                : "Esta entrega fue cancelada."}
          </div>
        )}
      </div>

      {!cerrado && (
        <div
          className="fixed inset-x-0 bottom-0 border-t px-4 py-3"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        >
          <div className="mx-auto flex max-w-[520px] gap-2">
            {!enCamino ? (
              <button
                type="button"
                disabled={cambiar.isPending}
                onClick={() => cambiar.mutate({ destino: "en_camino" })}
                className="h-12 flex-1 rounded-md text-[15px] font-semibold text-white disabled:opacity-60"
                style={{ background: "var(--primary)" }}
              >
                Empezar reparto
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setDialogo("no_entregado")}
                  className="flex h-12 flex-1 items-center justify-center gap-2 rounded-md border text-[14px] font-medium"
                  style={{ borderColor: "var(--border)", color: "var(--danger)" }}
                >
                  <AlertTriangle size={16} /> No pude
                </button>
                <button
                  type="button"
                  onClick={() => setDialogo("entregado")}
                  className="flex h-12 flex-[1.4] items-center justify-center gap-2 rounded-md text-[15px] font-semibold text-white"
                  style={{ background: "var(--success)" }}
                >
                  <CheckCircle2 size={17} /> Entregué
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {dialogo === "entregado" && (
        <Modal titulo="Entrega hecha" ancho="max-w-sm" onCerrar={() => setDialogo(null)}>
          <label className="block text-[13px]">
            ¿Quién la recibió?
            <input
              className={inputCls}
              style={inputStyle}
              value={recibidoPor}
              onChange={(e) => setRecibidoPor(e.target.value)}
              placeholder="Nombre de quien recibió"
              autoFocus
            />
          </label>
          <p className="mt-2 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Sirve para cuando alguien reclama que no recibió nada.
          </p>
          <button
            type="button"
            disabled={cambiar.isPending}
            onClick={() => cambiar.mutate({ destino: "entregado", recibido_por: recibidoPor.trim() || undefined })}
            className="mt-4 h-11 w-full rounded-md text-[15px] font-semibold text-white disabled:opacity-60"
            style={{ background: "var(--success)" }}
          >
            Confirmar entrega
          </button>
        </Modal>
      )}

      {dialogo === "no_entregado" && (
        <Modal titulo="No se pudo entregar" ancho="max-w-sm" onCerrar={() => setDialogo(null)}>
          <label className="block text-[13px]">
            ¿Qué pasó?
            <textarea
              className={`${inputCls} h-20 py-2`}
              style={inputStyle}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="No había nadie, dirección equivocada, no atendieron…"
              autoFocus
            />
          </label>
          <button
            type="button"
            disabled={cambiar.isPending || motivo.trim().length < 3}
            onClick={() => cambiar.mutate({ destino: "no_entregado", motivo: motivo.trim() })}
            className="mt-4 h-11 w-full rounded-md text-[15px] font-semibold text-white disabled:opacity-50"
            style={{ background: "var(--danger)" }}
          >
            Guardar
          </button>
        </Modal>
      )}
    </div>
  );
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
