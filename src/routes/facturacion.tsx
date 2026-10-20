import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  BookOpen,
  FileText,
  Loader2,
  Printer,
  Receipt,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Alerta,
  BotonPrimario,
  BotonSecundario,
  Modal,
  inputCls,
  inputStyle,
} from "@/components/ui-bits/Modal";
import { Chip } from "@/components/ui-bits/Chip";
import { useSesion, useSucursalOperativa } from "@/lib/sesion";
import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";
import { labelCondicion } from "@/lib/fiscal";
import { consultarCae, esperarCae, explicarRechazo, pedirCae } from "@/lib/comprobantes";
import { MesaFiscal, RevisionFiscal } from "@/components/facturas/MesaFiscal";
import { TicketComprobante } from "@/components/facturas/TicketComprobante";

export const Route = createFileRoute("/facturacion")({
  head: () => ({
    meta: [
      { title: "Facturación — PymeOS" },
      {
        name: "description",
        content: "Comprobantes de venta, notas de crédito y libro IVA de compras y ventas.",
      },
    ],
  }),
  // Lo que se escribió en el buscador del encabezado llega acá ya filtrado.
  validateSearch: (s: Record<string, unknown>): { q?: string } => ({
    q: typeof s.q === "string" ? s.q : undefined,
  }),
  component: Facturacion,
});

/**
 * El sistema arma el comprobante completo y lo deja esperando. El CAE lo
 * devuelve ARCA, y hasta que alguien lo cargue el comprobante está pendiente:
 * no hay número inventado ni comprobante de mentira en el registro.
 */
type Estado = "pendiente" | "emitido" | "rechazado" | "anulado";

type Comprobante = {
  revision_estado: string;
  idempotency_key: string | null;
  job_id: string | null;
  intento: number;
  emitido_at: string | null;
  envio_solicitado_at: string | null;
  id: string;
  sucursal_id: string;
  venta_id: string | null;
  comprobante_origen_id: string | null;
  tipo: string;
  punto_venta: number;
  numero: number | null;
  fecha: string;
  emisor_nombre: string;
  emisor_cuit: string;
  emisor_condicion_iva: string;
  emisor_direccion: string | null;
  receptor_nombre: string;
  receptor_tipo_documento: string;
  receptor_documento: string | null;
  receptor_condicion_iva: string;
  receptor_direccion: string | null;
  neto: number;
  iva: number;
  total: number;
  estado: Estado;
  cae: string | null;
  cae_vencimiento: string | null;
  qr_url: string | null;
  observacion: string | null;
  motivo: string | null;
  created_at: string;
  sucursal: { nombre: string } | null;
};

type Linea = {
  id: string;
  orden: number;
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  alicuota: number;
  neto: number;
  iva: number;
  subtotal: number;
};

type VentaSinFacturar = {
  id: string;
  numero: number;
  total: number;
  created_at: string;
  cliente: { nombre: string } | null;
};

type FilaLibro = {
  origen: string;
  fecha: string;
  tipo: string;
  comprobante: string;
  contraparte: string;
  documento: string | null;
  neto: number;
  iva: number;
  total: number;
};

type Tono = "success" | "danger" | "warning" | "violet" | "neutral";

const ETIQUETA_ESTADO: Record<Estado, { texto: string; tono: Tono }> = {
  pendiente: { texto: "Pendiente", tono: "warning" },
  emitido: { texto: "Emitido", tono: "success" },
  rechazado: { texto: "Rechazado", tono: "danger" },
  anulado: { texto: "Anulado", tono: "neutral" },
};

const NOMBRE_TIPO: Record<string, string> = {
  A: "Factura A",
  B: "Factura B",
  C: "Factura C",
  NCA: "Nota de crédito A",
  NCB: "Nota de crédito B",
  NCC: "Nota de crédito C",
};

function mesActual(): string {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
}

function rangoDelMes(mes: string): { desde: string; hasta: string } {
  const [a, m] = mes.split("-").map(Number);
  const ultimo = new Date(a, m, 0).getDate();
  return { desde: `${mes}-01`, hasta: `${mes}-${String(ultimo).padStart(2, "0")}` };
}

function nombreDelMes(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  const texto = new Date(a, m - 1, 1).toLocaleDateString("es-AR", {
    month: "long",
    year: "numeric",
  });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function fechaCorta(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${a.slice(2)}`;
}

/** Como se lee un comprobante en papel: punto de venta y número, con ceros. */
function etiquetaNumero(c: Comprobante): string {
  const pv = String(c.punto_venta).padStart(5, "0");
  if (c.numero === null) return `${pv}-········`;
  return `${pv}-${String(c.numero).padStart(8, "0")}`;
}

function Facturacion() {
  const { usuario, verTodas } = useSesion();
  const sucursalOperativa = useSucursalOperativa();
  const esDueno = usuario?.rol === "dueno";

  const puedeAutorizar = usuario?.rol === "dueno" || usuario?.rol === "contador";
  const [revisando, setRevisando] = useState<string | null>(null);
  const [vista, setVista] = useState<"pendientes" | "comprobantes" | "libro">("pendientes");
  const [mes, setMes] = useState(mesActual);
  const [comprobantes, setComprobantes] = useState<Comprobante[]>([]);
  const [libro, setLibro] = useState<FilaLibro[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  const [busqueda, setBusqueda] = useState(Route.useSearch().q ?? "");
  const [filtroEstado, setFiltroEstado] = useState("");
  const [seleccionado, setSeleccionado] = useState<string | null>(null);
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [cargandoLineas, setCargandoLineas] = useState(false);

  const [eligiendoVenta, setEligiendoVenta] = useState(false);
  const [cargandoCae, setCargandoCae] = useState<Comprobante | null>(null);
  const [rechazando, setRechazando] = useState<Comprobante | null>(null);
  const [descartando, setDescartando] = useState<Comprobante | null>(null);
  const [acreditando, setAcreditando] = useState<Comprobante | null>(null);

  const [pidiendoCae, setPidiendoCae] = useState(false);
  const [avisoCae, setAvisoCae] = useState<string | null>(null);

  const abrirComprobante = async (id: string) => {
    const { data, error } = await supa
      .from("comprobantes")
      .select("*, sucursal:sucursales(nombre)")
      .eq("id", id)
      .single();
    if (error || !data) {
      setErrorCarga(error?.message ?? "No se encontró el comprobante");
      return;
    }
    const c = data as unknown as Comprobante;
    setBusqueda("");
    setFiltroEstado("");
    setMes(c.fecha.slice(0, 7));
    setComprobantes((prev) => [...prev.filter((x) => x.id !== id), c]);
    setSeleccionado(id);
    setVista("comprobantes");
  };

  const cargar = useCallback(async () => {
    setCargando(true);
    setErrorCarga(null);
    const { desde, hasta } = rangoDelMes(mes);

    let consulta = supa
      .from("comprobantes")
      .select("*, sucursal:sucursales(nombre)")
      .gte("fecha", desde)
      .lte("fecha", hasta)
      .order("fecha", { ascending: false })
      .order("created_at", { ascending: false });

    if (sucursalOperativa) consulta = consulta.eq("sucursal_id", sucursalOperativa.id);

    const [filas, iva] = await Promise.all([
      consulta,
      supa.rpc("libro_iva", {
        p_desde: desde,
        p_hasta: hasta,
        p_sucursal_id: sucursalOperativa?.id ?? null,
      }),
    ]);

    const fallo = filas.error ?? iva.error;
    if (fallo) setErrorCarga(fallo.message);
    else {
      setComprobantes((filas.data ?? []) as unknown as Comprobante[]);
      setLibro((iva.data ?? []) as FilaLibro[]);
    }
    setCargando(false);
  }, [mes, sucursalOperativa]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /**
   * Le pide el CAE a ARCA por el gateway.
   *
   * Tarda: ARCA no contesta al toque. Mientras se espera, el comprobante queda
   * en pendiente y la pantalla lo dice. Si se cierra antes de que conteste no
   * se pierde nada — el barrido del servidor lo cierra igual — así que el
   * timeout se cuenta como "está tardando" y no como un error.
   */
  const pedirCaeAArca = async (comprobanteId: string) => {
    if (!sucursalOperativa || !puedeAutorizar || pidiendoCae) return;
    const c = comprobantes.find((c) => c.id === comprobanteId);
    if (!c) return;
    if (
      !c.job_id &&
      !c.idempotency_key &&
      !window.confirm(
        "¿Autorizar el envío fiscal real de este comprobante a Gateway? Esto no es una prueba.",
      )
    )
      return;
    setPidiendoCae(true);
    setAvisoCae("Pidiéndole el CAE a ARCA. Tarda hasta un minuto.");

    const rta = c.job_id
      ? await consultarCae(comprobanteId)
      : await pedirCae(comprobanteId, sucursalOperativa.id);
    if (!rta.ok) {
      setAvisoCae(null);
      setErrorCarga(rta.falta?.join(" ") ?? rta.error);
      setPidiendoCae(false);
      await cargar();
      return;
    }

    if (rta.datos.aviso) setAvisoCae(rta.datos.aviso);

    const final = await esperarCae(comprobanteId);
    setPidiendoCae(false);

    if (!final || final.estado === "pendiente") {
      setAvisoCae(
        "ARCA está demorando. El comprobante se va a completar solo: volvé a mirar en un rato.",
      );
    } else if (final.estado === "rechazado") {
      setAvisoCae(null);
      setErrorCarga(explicarRechazo(final.observacion));
    } else {
      setAvisoCae(null);
    }

    await cargar();
  };

  const visibles = useMemo(() => {
    const texto = busqueda.trim().toLowerCase();
    return comprobantes.filter((c) => {
      const descartado = c.estado === "anulado" && !c.cae;
      if (filtroEstado === "descartados") {
        if (!descartado) return false;
      } else if (descartado || (filtroEstado && c.estado !== filtroEstado)) return false;
      if (!texto) return true;
      return (
        c.receptor_nombre.toLowerCase().includes(texto) ||
        etiquetaNumero(c).includes(texto) ||
        (c.receptor_documento ?? "").includes(texto) ||
        (c.cae ?? "").includes(texto)
      );
    });
  }, [comprobantes, busqueda, filtroEstado]);

  // La primera vez, y cada vez que el elegido deja de estar en la lista, se
  // para en el de arriba: una pantalla con la vista previa vacía no sirve.
  useEffect(() => {
    if (visibles.length === 0) {
      setSeleccionado(null);
      return;
    }
    if (!seleccionado || !visibles.some((c) => c.id === seleccionado)) {
      setSeleccionado(visibles[0].id);
    }
  }, [visibles, seleccionado]);

  const actual = useMemo(
    () => comprobantes.find((c) => c.id === seleccionado) ?? null,
    [comprobantes, seleccionado],
  );

  useEffect(() => {
    if (!seleccionado) {
      setLineas([]);
      return;
    }
    let vigente = true;
    setCargandoLineas(true);
    void supa
      .from("comprobante_lineas")
      .select("id, orden, descripcion, cantidad, precio_unitario, alicuota, neto, iva, subtotal")
      .eq("comprobante_id", seleccionado)
      .order("orden")
      .then(({ data, error }) => {
        if (!vigente) return;
        if (error) setErrorCarga(error.message);
        setLineas((data ?? []) as Linea[]);
        setCargandoLineas(false);
      });
    return () => {
      vigente = false;
    };
  }, [seleccionado]);

  // Lo anulado y lo rechazado no facturó nada: no suma.
  const facturado = useMemo(
    () =>
      comprobantes.reduce((s, c) => {
        if (c.estado !== "emitido") return s;
        return c.tipo.startsWith("NC") ? s - Number(c.total) : s + Number(c.total);
      }, 0),
    [comprobantes],
  );

  const pendientes = comprobantes.filter((c) => c.estado === "pendiente").length;

  const alcance = sucursalOperativa
    ? sucursalOperativa.nombre
    : verTodas
      ? "Las dos sucursales"
      : "Sin sucursal activa";

  return (
    <>
      <PageHeader
        title="Facturación"
        subtitle={`${nombreDelMes(mes)} · ${alcance} · ${formatARS(facturado)} facturado${
          pendientes > 0 ? ` · ${pendientes} pendientes` : ""
        }`}
        actions={
          <button
            disabled={!sucursalOperativa}
            onClick={() => setEligiendoVenta(true)}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white"
            style={{ background: "var(--primary)" }}
          >
            <Receipt size={13} /> Preparar borrador
          </button>
        }
      />

      {errorCarga && (
        <div className="mb-3">
          <Alerta tono="danger">{errorCarga}</Alerta>
        </div>
      )}

      <div className="mb-3">
        <Alerta tono="info">
          Registrar una venta o preparar un borrador no envía nada a Gateway. Un responsable revisa
          y autoriza la emisión. Solo se considera emitido cuando ARCA devuelve el CAE.
        </Alerta>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <BotonVista activa={vista === "pendientes"} onClick={() => setVista("pendientes")}>
          Pendientes por fecha
        </BotonVista>
        <BotonVista activa={vista === "comprobantes"} onClick={() => setVista("comprobantes")}>
          <FileText size={13} /> Comprobantes
        </BotonVista>
        <BotonVista activa={vista === "libro"} onClick={() => setVista("libro")}>
          <BookOpen size={13} /> Libro IVA
        </BotonVista>
        <div className="flex-1" />
        <input
          type="month"
          value={mes}
          onChange={(e) => setMes(e.target.value || mesActual())}
          className="h-8 rounded-md border px-2 text-[13px]"
          style={inputStyle}
        />
      </div>

      {vista === "pendientes" ? (
        <MesaFiscal
          key={`${mes}:${sucursalOperativa?.id ?? "todas"}`}
          mes={mes}
          sucursalId={sucursalOperativa?.id ?? null}
          puedeAutorizar={puedeAutorizar}
          onCambio={() => void cargar()}
          onAbrir={(id) => void abrirComprobante(id)}
        />
      ) : vista === "libro" ? (
        <LibroIva filas={libro} cargando={cargando} mes={mes} />
      ) : (
        <div className="grid grid-cols-[1fr_380px] gap-3">
          <div className="card-surface overflow-hidden">
            <div
              className="flex items-center gap-2 px-4 py-3"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              <input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por cliente, número, documento o CAE…"
                className="h-8 flex-1 rounded-md border px-3 text-[13px] outline-none"
                style={inputStyle}
              />
              <select
                value={filtroEstado}
                onChange={(e) => setFiltroEstado(e.target.value)}
                className="h-8 rounded-md border px-2 text-[13px]"
                style={inputStyle}
              >
                <option value="">Todos los estados</option>
                <option value="pendiente">Pendientes de CAE</option>
                <option value="emitido">Emitidos</option>
                <option value="rechazado">Rechazados</option>
                <option value="anulado">Anulados</option>
                <option value="descartados">Borradores descartados · historial</option>
              </select>
            </div>

            {cargando ? (
              <div
                className="flex items-center gap-2 px-4 py-6 text-[13px]"
                style={{ color: "var(--muted-foreground)" }}
              >
                <Loader2 size={14} className="animate-spin" /> Buscando los comprobantes del
                período…
              </div>
            ) : visibles.length === 0 ? (
              <div className="px-4 py-6 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                No hay comprobantes en {nombreDelMes(mes)}.
              </div>
            ) : (
              <table className="w-full text-[13px]">
                <thead style={{ background: "#f9fafc" }}>
                  <tr style={{ color: "var(--muted-foreground)" }}>
                    <th className="px-4 py-2 text-left font-medium">Fecha</th>
                    <th className="px-4 py-2 text-left font-medium">Tipo</th>
                    <th className="px-4 py-2 text-left font-medium">Número</th>
                    <th className="px-4 py-2 text-left font-medium">Cliente</th>
                    <th className="px-4 py-2 text-left font-medium">CAE</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                    <th className="px-4 py-2 text-left font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.map((c) => {
                    const e = ETIQUETA_ESTADO[c.estado];
                    return (
                      <tr
                        key={c.id}
                        onClick={() => setSeleccionado(c.id)}
                        className="cursor-pointer"
                        style={{
                          borderTop: "1px solid #eef1f6",
                          background: seleccionado === c.id ? "#f9fafc" : "transparent",
                        }}
                      >
                        <td className="px-4 py-2 tabular">{fechaCorta(c.fecha)}</td>
                        <td className="px-4 py-2 font-medium">{c.tipo}</td>
                        <td className="px-4 py-2 tabular">{etiquetaNumero(c)}</td>
                        <td className="px-4 py-2">{c.receptor_nombre}</td>
                        <td
                          className="px-4 py-2 tabular"
                          style={{ color: "var(--muted-foreground)" }}
                        >
                          {c.cae ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-right tabular">
                          {c.tipo.startsWith("NC") ? "−" : ""}
                          {formatARS(Number(c.total))}
                        </td>
                        <td className="px-4 py-2">
                          <Chip tone={e.tono}>{c.estado === "anulado" && !c.cae ? "Borrador descartado" : e.texto}</Chip>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <Vista
            puedeAutorizar={puedeAutorizar && !!sucursalOperativa}
            onRevisar={() => actual && setRevisando(actual.id)}
            comprobante={actual}
            lineas={lineas}
            cargando={cargandoLineas}
            esDueno={esDueno}
            onCae={() => actual && setCargandoCae(actual)}
            onPedirCae={() => actual && void pedirCaeAArca(actual.id)}
            pidiendoCae={pidiendoCae}
            avisoCae={avisoCae}
            onRechazar={() => actual && setRechazando(actual)}
            onDescartar={() => actual && setDescartando(actual)}
            onNotaCredito={() => actual && setAcreditando(actual)}
          />
        </div>
      )}

      {eligiendoVenta && (
        <ElegirVenta
          sucursalId={sucursalOperativa?.id ?? null}
          onCerrar={() => setEligiendoVenta(false)}
          onListo={(id) => {
            setEligiendoVenta(false);
            setVista("comprobantes");
            setSeleccionado(id);
            void cargar();
          }}
        />
      )}

      {revisando && sucursalOperativa && (
        <RevisionFiscal
          id={revisando}
          sucursalId={sucursalOperativa.id}
          onCerrar={() => setRevisando(null)}
          onListo={() => {
            setRevisando(null);
            void cargar();
          }}
        />
      )}

      {cargandoCae && (
        <RegistrarCae
          comprobante={cargandoCae}
          onCerrar={() => setCargandoCae(null)}
          onListo={() => {
            setCargandoCae(null);
            void cargar();
          }}
        />
      )}

      {descartando && esDueno && sucursalOperativa && (
        <MotivoSimple
          titulo="Descartar borrador sin enviar"
          ayuda="Se retira de los borradores activos y se conserva en el historial. No se elimina la venta, sus cobros ni su stock: seguirá pendiente de facturación. No se envía nada a Gateway."
          etiqueta="Motivo del descarte (3 a 1000 caracteres)"
          textoBoton="Confirmar descarte"
          onCerrar={() => setDescartando(null)}
          onEnviar={(motivo) => supa.rpc("descartar_borrador_fiscal", {
            p_id: descartando.id, p_sucursal_id: sucursalOperativa.id, p_motivo: motivo,
          })}
          onListo={() => { setDescartando(null); void cargar(); }}
        />
      )}

      {rechazando && (
        <MotivoSimple
          titulo="Marcar como rechazado"
          ayuda="Copiá lo que contestó ARCA. Queda escrito en el comprobante para poder corregirlo y volver a presentarlo."
          etiqueta="Qué dijo ARCA"
          textoBoton="Marcar rechazado"
          onCerrar={() => setRechazando(null)}
          onEnviar={(motivo) =>
            supa.rpc("rechazar_comprobante", {
              p_comprobante_id: rechazando.id,
              p_motivo: motivo,
            })
          }
          onListo={() => {
            setRechazando(null);
            void cargar();
          }}
        />
      )}

      {acreditando && (
        <MotivoSimple
          titulo="Hacer una nota de crédito"
          ayuda="Un comprobante emitido no se borra ni se corrige: se deja sin efecto con una nota de crédito. Va a quedar pendiente de CAE, igual que una factura. Recién cuando la nota tenga su propio CAE el comprobante original queda anulado."
          etiqueta="Por qué se anula"
          textoBoton="Preparar nota de crédito"
          onCerrar={() => setAcreditando(null)}
          onEnviar={(motivo) =>
            supa.rpc("preparar_nota_credito", {
              p_comprobante_id: acreditando.id,
              p_motivo: motivo,
            })
          }
          onListo={() => {
            setAcreditando(null);
            void cargar();
          }}
        />
      )}
    </>
  );
}

function BotonVista({
  activa,
  onClick,
  children,
}: {
  activa: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px]"
      style={{
        borderColor: activa ? "var(--primary)" : "var(--border)",
        color: activa ? "var(--primary)" : "var(--foreground)",
        background: activa ? "#fdf1ec" : "var(--surface)",
        fontWeight: activa ? 500 : 400,
      }}
    >
      {children}
    </button>
  );
}

/* ── La vista previa: el comprobante como se va a imprimir ─────────────── */

export function Vista({
  puedeAutorizar,
  onRevisar,
  comprobante,
  lineas,
  cargando,
  esDueno,
  onCae,
  onPedirCae,
  pidiendoCae,
  avisoCae,
  onRechazar,
  onDescartar,
  onNotaCredito,
}: {
  puedeAutorizar: boolean;
  onRevisar: () => void;
  comprobante: Comprobante | null;
  lineas: Linea[];
  cargando: boolean;
  esDueno: boolean;
  onCae: () => void;
  onPedirCae: () => void;
  pidiendoCae: boolean;
  avisoCae: string | null;
  onRechazar: () => void;
  onDescartar: () => void;
  onNotaCredito: () => void;
}) {
  if (!comprobante) {
    return (
      <aside className="card-surface p-5 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
        Elegí un comprobante de la lista para verlo.
      </aside>
    );
  }

  const c = comprobante;
  const estado = ETIQUETA_ESTADO[c.estado];
  const esNota = c.tipo.startsWith("NC");

  return (
    <aside className="card-surface p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[15px] font-semibold">{c.emisor_nombre}</div>
          {c.emisor_direccion && (
            <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              {c.emisor_direccion}
            </div>
          )}
          <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            CUIT: {c.emisor_cuit} · {labelCondicion(c.emisor_condicion_iva)}
          </div>
        </div>
        <div
          className="flex h-9 w-9 items-center justify-center rounded-md border text-[15px] font-semibold"
          style={{ borderColor: "var(--border)" }}
        >
          {esNota ? "NC" : c.tipo}
        </div>
      </div>

      <div
        className="mt-3 flex items-center justify-between"
        style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}
      >
        <div>
          <div className="text-[13px] font-medium">{NOMBRE_TIPO[c.tipo] ?? c.tipo}</div>
          <div className="tabular text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            {etiquetaNumero(c)} · {fechaCorta(c.fecha)}
          </div>
        </div>
        <Chip tone={estado.tono}>{c.estado === "anulado" && !c.cae ? "Borrador descartado" : estado.texto}</Chip>
      </div>

      <div
        className="mt-3 text-[12px]"
        style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}
      >
        <div className="font-medium text-[13px]">{c.receptor_nombre}</div>
        <div style={{ color: "var(--muted-foreground)" }}>
          {c.receptor_documento
            ? `${c.receptor_tipo_documento}: ${c.receptor_documento}`
            : "Sin identificar"}{" "}
          · {labelCondicion(c.receptor_condicion_iva)}
        </div>
        {c.receptor_direccion && (
          <div style={{ color: "var(--muted-foreground)" }}>{c.receptor_direccion}</div>
        )}
      </div>

      <div className="mt-3" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        {cargando ? (
          <div
            className="flex items-center gap-2 text-[12px]"
            style={{ color: "var(--muted-foreground)" }}
          >
            <Loader2 size={13} className="animate-spin" /> Abriendo el detalle…
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <tbody>
              {lineas.map((l) => (
                <tr key={l.id}>
                  <td className="py-1 pr-2">
                    {l.descripcion}
                    {Number(l.cantidad) !== 1 && (
                      <span style={{ color: "var(--muted-foreground)" }}>
                        {" "}
                        × {Number(l.cantidad)}
                      </span>
                    )}
                  </td>
                  <td className="py-1 text-right tabular">{formatARS(Number(l.subtotal))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div
        className="mt-3 space-y-1 text-[12px]"
        style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}
      >
        {/* En una factura C el IVA no se discrimina: el monotributista no lo
            cobra aparte. Mostrar "IVA 0" confundiría. */}
        {c.tipo !== "C" && c.tipo !== "NCC" && (
          <>
            <Linea2 etiqueta="Neto gravado" valor={Number(c.neto)} />
            <Linea2 etiqueta="IVA 21%" valor={Number(c.iva)} />
          </>
        )}
        <div className="flex items-center justify-between pt-1 text-[14px] font-semibold">
          <span>Total</span>
          <span className="tabular">{formatARS(Number(c.total))}</span>
        </div>
      </div>

      {c.estado === "emitido" && c.cae && (
        <div
          className="mt-3 rounded-md px-3 py-2 text-[12px] tabular"
          style={{ background: "var(--success-bg)", color: "var(--success)" }}
        >
          CAE: {c.cae} · Vto. {c.cae_vencimiento ? fechaCorta(c.cae_vencimiento) : "—"}
        </div>
      )}

      {c.estado === "rechazado" && c.observacion && (
        <div className="mt-3">
          <Alerta tono="danger">{c.observacion}</Alerta>
        </div>
      )}

      {c.estado === "anulado" && (
        <div className="mt-3">
          <Alerta tono="warning">
            {c.cae ? "Anulado con una nota de crédito." : "Borrador descartado. La venta no se eliminó."}{c.motivo ? ` Motivo: ${c.motivo}` : ""}
          </Alerta>
        </div>
      )}

      {avisoCae && (
        <div className="mt-3">
          <Alerta tono="info">{avisoCae}</Alerta>
        </div>
      )}

      {/* Se dibuja siempre pero no se ve: la hoja de estilos lo muestra solo al
          imprimir. Va acá y no en un modal para que "Imprimir" salga derecho al
          papel, sin un paso intermedio que nadie quiere en el mostrador. */}
      <TicketComprobante comprobante={c} lineas={lineas} />

      <div className="mt-4 flex flex-wrap gap-2">
        {esDueno && puedeAutorizar && (c.estado === "pendiente" || c.estado === "rechazado") &&
          c.cae === null && c.numero === null && c.job_id === null && c.idempotency_key === null &&
          c.emitido_at === null && c.envio_solicitado_at === null && c.intento === 0 && (
          <button className="rounded-md border px-3 py-2 text-sm" onClick={onDescartar}>
            Descartar borrador
          </button>
        )}
        {puedeAutorizar && c.estado !== "anulado" && !c.cae && !c.job_id && !c.idempotency_key && (
          <button className="rounded-md border px-3 py-2 text-sm" onClick={onRevisar}>
            Revisar borrador · {c.revision_estado}
          </button>
        )}
        {c.idempotency_key && !c.job_id && !c.cae && (
          <Alerta tono="warning">
            Envío por conciliar. No se vuelve a emitir hasta verificar el resultado con Gateway.
          </Alerta>
        )}
        {(c.estado === "emitido" || (c.estado !== "anulado" && !c.cae && !c.tipo.startsWith("NC"))) && (
          <button
            onClick={() => window.print()}
            disabled={cargando || lineas.length === 0}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white"
            style={{ background: "var(--primary)" }}
          >
            <Printer size={13} /> {c.cae ? "Imprimir factura" : "Imprimir ticket interno"}
          </button>
        )}

        {/* El camino automático primero, porque es el que se va a usar siempre.
            El manual queda al lado y no se saca: si el gateway se cae o ARCA no
            contesta, el contador tiene que poder cargar el CAE igual. Es la
            diferencia entre facturar con demora y no facturar. */}
        {puedeAutorizar && (c.estado === "pendiente" || c.estado === "rechazado") && (
          <button
            onClick={onPedirCae}
            disabled={
              pidiendoCae || (!c.job_id && (!!c.idempotency_key || c.revision_estado !== "listo"))
            }
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
            style={{ background: "var(--primary)" }}
          >
            {pidiendoCae ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <ShieldCheck size={13} />
            )}
            {c.job_id ? "Consultar resultado" : "Autorizar emisión a ARCA"}
          </button>
        )}
        {puedeAutorizar && (c.estado === "pendiente" || c.estado === "rechazado") && (
          <button
            onClick={onCae}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px]"
            style={inputStyle}
          >
            Registrar CAE a mano
          </button>
        )}
        {puedeAutorizar && c.estado === "pendiente" && !c.idempotency_key && !c.job_id && (
          <button
            onClick={onRechazar}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px]"
            style={inputStyle}
          >
            <XCircle size={13} /> Marcar rechazado
          </button>
        )}
        {c.estado === "emitido" && !esNota && esDueno && (
          <button
            onClick={onNotaCredito}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px]"
            style={inputStyle}
          >
            <RotateCcw size={13} /> Nota de crédito
          </button>
        )}
      </div>
    </aside>
  );
}

function Linea2({ etiqueta, valor }: { etiqueta: string; valor: number }) {
  return (
    <div className="flex items-center justify-between" style={{ color: "var(--muted-foreground)" }}>
      <span>{etiqueta}</span>
      <span className="tabular">{formatARS(valor)}</span>
    </div>
  );
}

/* ── Facturar una venta ────────────────────────────────────────────────── */

function ElegirVenta({
  sucursalId,
  onCerrar,
  onListo,
}: {
  sucursalId: string | null;
  onCerrar: () => void;
  onListo: (comprobanteId: string) => void;
}) {
  const [ventas, setVentas] = useState<VentaSinFacturar[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");

  useEffect(() => {
    let vigente = true;
    void (async () => {
      let consulta = supa
        .from("ventas")
        .select("id, numero, total, created_at, cliente:clientes(nombre)")
        .eq("estado", "completada")
        .order("created_at", { ascending: false })
        .limit(200);
      if (sucursalId) consulta = consulta.eq("sucursal_id", sucursalId);

      // Se piden las dos cosas juntas y se cruzan acá: la base no tiene un
      // "ventas sin comprobante" y armar una vista para esto sería de más.
      const [v, c] = await Promise.all([
        consulta,
        supa
          .from("comprobantes")
          .select("venta_id")
          .in("tipo", ["A", "B", "C"])
          .in("estado", ["pendiente", "emitido"]),
      ]);
      if (!vigente) return;
      const fallo = v.error ?? c.error;
      if (fallo) setError(fallo.message);
      else {
        const facturadas = new Set((c.data ?? []).map((f) => f.venta_id));
        setVentas(
          ((v.data ?? []) as unknown as VentaSinFacturar[]).filter((x) => !facturadas.has(x.id)),
        );
      }
      setCargando(false);
    })();
    return () => {
      vigente = false;
    };
  }, [sucursalId]);

  const visibles = useMemo(() => {
    const t = busqueda.trim().toLowerCase();
    if (!t) return ventas;
    return ventas.filter(
      (v) => String(v.numero).includes(t) || (v.cliente?.nombre ?? "").toLowerCase().includes(t),
    );
  }, [ventas, busqueda]);

  async function facturar(venta: VentaSinFacturar) {
    setEnviando(venta.id);
    setError(null);
    const { data, error: fallo } = await supa.rpc("preparar_comprobante", {
      p_venta_id: venta.id,
    });
    setEnviando(null);
    if (fallo) setError(fallo.message);
    else onListo(data as string);
  }

  return (
    <Modal titulo="Facturar una venta" ancho="max-w-2xl" onCerrar={onCerrar}>
      {error && (
        <div className="mb-3">
          <Alerta tono="danger">{error}</Alerta>
        </div>
      )}

      <p className="mb-3 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
        El tipo de comprobante lo decide la condición del cliente frente a la de la sucursal. Si la
        venta no tiene cliente cargado, sale como consumidor final.
      </p>

      <input
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        placeholder="Buscar por número o cliente…"
        className="mb-3 h-9 w-full rounded-md border px-3 text-[13px] outline-none"
        style={inputStyle}
      />

      {cargando ? (
        <div
          className="flex items-center gap-2 py-6 text-[13px]"
          style={{ color: "var(--muted-foreground)" }}
        >
          <Loader2 size={14} className="animate-spin" /> Buscando ventas sin facturar…
        </div>
      ) : visibles.length === 0 ? (
        <div className="py-6 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
          No quedan ventas sin facturar.
        </div>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          <table className="w-full text-[13px]">
            <thead style={{ background: "#f9fafc" }}>
              <tr style={{ color: "var(--muted-foreground)" }}>
                <th className="px-3 py-2 text-left font-medium">Venta</th>
                <th className="px-3 py-2 text-left font-medium">Fecha</th>
                <th className="px-3 py-2 text-left font-medium">Cliente</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {visibles.map((v) => (
                <tr key={v.id} style={{ borderTop: "1px solid #eef1f6" }}>
                  <td className="px-3 py-2 tabular">#{v.numero}</td>
                  <td className="px-3 py-2 tabular">{fechaCorta(v.created_at)}</td>
                  <td className="px-3 py-2">{v.cliente?.nombre ?? "Consumidor final"}</td>
                  <td className="px-3 py-2 text-right tabular">{formatARS(Number(v.total))}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => void facturar(v)}
                      disabled={enviando !== null}
                      className="rounded-md border px-2.5 py-1 text-[12px]"
                      style={inputStyle}
                    >
                      {enviando === v.id ? "Armando…" : "Facturar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <BotonSecundario onClick={onCerrar}>Cerrar</BotonSecundario>
      </div>
    </Modal>
  );
}

/* ── Registrar el CAE que devolvió ARCA ────────────────────────────────── */

function RegistrarCae({
  comprobante,
  onCerrar,
  onListo,
}: {
  comprobante: Comprobante;
  onCerrar: () => void;
  onListo: () => void;
}) {
  const [numero, setNumero] = useState("");
  const [cae, setCae] = useState("");
  const [vencimiento, setVencimiento] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    const { error: fallo } = await supa.rpc("registrar_cae", {
      p_comprobante_id: comprobante.id,
      p_numero: Number(numero),
      p_cae: cae.trim(),
      p_cae_vencimiento: vencimiento,
    });
    setEnviando(false);
    if (fallo) setError(fallo.message);
    else onListo();
  }

  return (
    <Modal titulo="Registrar el CAE" onCerrar={onCerrar}>
      <form onSubmit={(e) => void enviar(e)}>
        {error && (
          <div className="mb-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}

        <p className="mb-3 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
          Copiá tal cual el número y el CAE que devolvió ARCA para {NOMBRE_TIPO[comprobante.tipo]}{" "}
          punto de venta {String(comprobante.punto_venta).padStart(5, "0")}.
        </p>

        <label className="block text-[13px]">
          Número de comprobante
          <input
            value={numero}
            onChange={(e) => setNumero(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            placeholder="12845"
            required
            className={inputCls}
            style={inputStyle}
          />
        </label>

        <label className="mt-3 block text-[13px]">
          CAE
          <input
            value={cae}
            onChange={(e) => setCae(e.target.value.replace(/\D/g, "").slice(0, 14))}
            inputMode="numeric"
            placeholder="14 números"
            required
            className={inputCls}
            style={inputStyle}
          />
        </label>

        <label className="mt-3 block text-[13px]">
          Vencimiento del CAE
          <input
            type="date"
            value={vencimiento}
            onChange={(e) => setVencimiento(e.target.value)}
            required
            className={inputCls}
            style={inputStyle}
          />
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando} disabled={cae.length !== 14}>
            Registrar CAE
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

/* ── Un motivo escrito a mano: rechazo y nota de crédito ───────────────── */

export function MotivoSimple({
  titulo,
  ayuda,
  etiqueta,
  textoBoton,
  onCerrar,
  onEnviar,
  onListo,
}: {
  titulo: string;
  ayuda: string;
  etiqueta: string;
  textoBoton: string;
  onCerrar: () => void;
  onEnviar: (motivo: string) => PromiseLike<{ error: { message: string } | null }>;
  onListo: () => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      const { error: fallo } = await onEnviar(motivo.trim());
      if (fallo) setError(fallo.message);
      else onListo();
    } catch {
      setError("No se pudo confirmar el resultado. Actualizá los comprobantes antes de reintentar.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Modal titulo={titulo} onCerrar={onCerrar}>
      <form onSubmit={(e) => void enviar(e)}>
        {error && (
          <div className="mb-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}

        <p className="mb-3 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
          {ayuda}
        </p>

        <label className="block text-[13px]">
          {etiqueta}
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            rows={3}
            required
            className="mt-1 w-full rounded-md border px-2.5 py-2 text-[13px] outline-none"
            style={inputStyle}
          />
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando} disabled={motivo.trim() === ""}>
            {textoBoton}
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

/* ── Libro IVA: lo que se le lleva al contador ─────────────────────────── */

function LibroIva({
  filas,
  cargando,
  mes,
}: {
  filas: FilaLibro[];
  cargando: boolean;
  mes: string;
}) {
  const ventas = filas.filter((f) => f.origen === "venta");
  const compras = filas.filter((f) => f.origen === "compra");

  const sumar = (xs: FilaLibro[], campo: "neto" | "iva" | "total") =>
    xs.reduce((s, f) => s + Number(f[campo]), 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Tarjeta
          titulo="IVA débito fiscal"
          detalle="Lo que se cobró en las ventas"
          valor={sumar(ventas, "iva")}
        />
        <Tarjeta
          titulo="IVA crédito fiscal"
          detalle="Solo el de las facturas A de compra"
          valor={sumar(compras, "iva")}
        />
        <Tarjeta
          titulo="Saldo del período"
          detalle="Débito menos crédito"
          valor={sumar(ventas, "iva") - sumar(compras, "iva")}
        />
      </div>

      <div className="mb-1">
        <Alerta tono="info">
          En las facturas B y C de compra el IVA viene adentro del precio y no se puede separar: por
          eso figuran con IVA cero. Solo la factura A da crédito fiscal.
        </Alerta>
      </div>

      <BloqueLibro
        titulo="Ventas"
        filas={ventas}
        cargando={cargando}
        vacio={`No hay comprobantes emitidos en ${nombreDelMes(mes)}.`}
      />
      <BloqueLibro
        titulo="Compras"
        filas={compras}
        cargando={cargando}
        vacio={`No hay facturas de compra cargadas en ${nombreDelMes(mes)}.`}
      />
    </div>
  );
}

function Tarjeta({ titulo, detalle, valor }: { titulo: string; detalle: string; valor: number }) {
  return (
    <div className="card-surface p-4">
      <div className="text-[13px] font-medium">{titulo}</div>
      <div className="mt-1 text-[20px] font-semibold tabular">{formatARS(valor)}</div>
      <div className="mt-1 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
        {detalle}
      </div>
    </div>
  );
}

function BloqueLibro({
  titulo,
  filas,
  cargando,
  vacio,
}: {
  titulo: string;
  filas: FilaLibro[];
  cargando: boolean;
  vacio: string;
}) {
  return (
    <div className="card-surface overflow-hidden">
      <div
        className="px-4 py-3 text-[13px] font-medium"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        {titulo}
      </div>
      {cargando ? (
        <div
          className="flex items-center gap-2 px-4 py-6 text-[13px]"
          style={{ color: "var(--muted-foreground)" }}
        >
          <Loader2 size={14} className="animate-spin" /> Armando el libro…
        </div>
      ) : filas.length === 0 ? (
        <div className="px-4 py-6 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
          {vacio}
        </div>
      ) : (
        <table className="w-full text-[13px]">
          <thead style={{ background: "#f9fafc" }}>
            <tr style={{ color: "var(--muted-foreground)" }}>
              <th className="px-4 py-2 text-left font-medium">Fecha</th>
              <th className="px-4 py-2 text-left font-medium">Tipo</th>
              <th className="px-4 py-2 text-left font-medium">Comprobante</th>
              <th className="px-4 py-2 text-left font-medium">
                {titulo === "Ventas" ? "Cliente" : "Proveedor"}
              </th>
              <th className="px-4 py-2 text-left font-medium">Documento</th>
              <th className="px-4 py-2 text-right font-medium">Neto</th>
              <th className="px-4 py-2 text-right font-medium">IVA</th>
              <th className="px-4 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f, i) => (
              <tr key={`${f.comprobante}-${i}`} style={{ borderTop: "1px solid #eef1f6" }}>
                <td className="px-4 py-2 tabular">{fechaCorta(f.fecha)}</td>
                <td className="px-4 py-2">{f.tipo}</td>
                <td className="px-4 py-2 tabular">{f.comprobante}</td>
                <td className="px-4 py-2">{f.contraparte}</td>
                <td className="px-4 py-2 tabular" style={{ color: "var(--muted-foreground)" }}>
                  {f.documento ?? "—"}
                </td>
                <td className="px-4 py-2 text-right tabular">{formatARS(Number(f.neto))}</td>
                <td className="px-4 py-2 text-right tabular">{formatARS(Number(f.iva))}</td>
                <td className="px-4 py-2 text-right tabular">{formatARS(Number(f.total))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
