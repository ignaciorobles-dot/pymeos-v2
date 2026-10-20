import { useEffect, useRef, useState } from "react";
import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";
import { pedirCae } from "@/lib/comprobantes";
import { ejecutarLoteFiscal } from "@/lib/lote-fiscal";
import type { ButtonHTMLAttributes } from "react";
import { Alerta, Modal, inputCls, inputStyle } from "@/components/ui-bits/Modal";

function BotonPrimario(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="rounded-md px-3 py-2 text-sm text-white disabled:opacity-50"
      style={{ background: "var(--primary)" }}
      {...props}
    />
  );
}
function BotonSecundario(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
      {...props}
    />
  );
}

type Pendiente = {
  venta_id: string;
  numero: number;
  fecha: string;
  total: number;
  cliente: string;
  comprobante_id: string | null;
  estado: string;
  revision: string;
  total_filas: number;
};
type Snapshot = {
  huella: string;
  comprobante: {
    id: string;
    sucursal_id: string;
    tipo: string;
    fecha: string;
    total: number;
    neto: number;
    iva: number;
    receptor_nombre: string;
    receptor_documento: string | null;
    receptor_condicion_iva: string;
    revision_estado: string;
    job_id: string | null;
    idempotency_key: string | null;
    cae: string | null;
  };
  lineas: { id: string; descripcion: string; cantidad: number; subtotal: number }[];
};

export function RevisionFiscal({
  id,
  sucursalId,
  onCerrar,
  onListo,
}: {
  id: string;
  sucursalId: string;
  onCerrar: () => void;
  onListo: () => void;
}) {
  const [datos, setDatos] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [nota, setNota] = useState("");
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => {
    let vivo = true;
    void supa.rpc("vista_revision_fiscal", { p_id: id }).then(({ data, error }) => {
      if (!vivo) return;
      if (error || !data) setError(error?.message ?? "No se encontró el comprobante");
      else setDatos(data as Snapshot);
    });
    return () => {
      vivo = false;
    };
  }, [id]);
  async function guardar(listo: boolean) {
    if (!datos || ocupado) return;
    setOcupado(true);
    setError("");
    const { error } = await supa.rpc("revisar_comprobante", {
      p_id: id,
      p_sucursal_id: sucursalId,
      p_huella: datos.huella,
      p_listo: listo,
      p_nota: nota,
    });
    setOcupado(false);
    if (error) setError(error.message);
    else onListo();
  }
  const c = datos?.comprobante;
  return (
    <Modal
      titulo="Revisar borrador fiscal · no emite"
      onCerrar={() => {
        if (!ocupado) onCerrar();
      }}
    >
      {error && <Alerta tono="danger">{error}</Alerta>}
      {!datos && !error && <p>Cargando datos actuales…</p>}
      {datos && c && (
        <div className="space-y-3 text-sm">
          <p>
            {c.tipo} · {c.fecha} · {c.receptor_nombre} · {c.receptor_documento ?? "Sin identificar"}{" "}
            · {c.receptor_condicion_iva}
          </p>
          <table className="w-full">
            <thead>
              <tr>
                <th>Detalle</th>
                <th>Cantidad</th>
                <th>Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {datos.lineas.map((l) => (
                <tr key={l.id}>
                  <td>{l.descripcion}</td>
                  <td>{l.cantidad}</td>
                  <td>{formatARS(Number(l.subtotal))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Neto {formatARS(Number(c.neto))} · IVA {formatARS(Number(c.iva))} · Total{" "}
            {formatARS(Number(c.total))}
          </p>
          <p>
            Revisá cliente, productos e importes. Aprobar no envía nada: la emisión se autoriza
            después. Si la venta tiene un error, observá el borrador y corregí la operación desde
            Ventas; no sobrescribas el historial.
          </p>
          <label className="block">
            Nota de revisión
            <textarea
              className={inputCls}
              style={inputStyle}
              value={nota}
              onChange={(e) => setNota(e.target.value)}
            />
          </label>
          {c.job_id || c.idempotency_key || c.cae ? (
            <Alerta tono="info">
              Este comprobante ya fue enviado. Consultá o conciliá su resultado; no se modifica ni
              se reenvía.
            </Alerta>
          ) : (
            <div className="flex gap-2">
              <BotonSecundario disabled={ocupado} onClick={() => void guardar(false)}>
                Dejar observado
              </BotonSecundario>
              <BotonPrimario disabled={ocupado} onClick={() => void guardar(true)}>
                Revisado, listo para autorizar
              </BotonPrimario>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function MesaFiscal({
  mes,
  sucursalId,
  puedeAutorizar,
  onAbrir,
  onCambio,
}: {
  mes: string;
  sucursalId: string | null;
  puedeAutorizar: boolean;
  onAbrir: (id: string) => void;
  onCambio: () => void;
}) {
  const [filas, setFilas] = useState<Pendiente[]>([]);
  const [pagina, setPagina] = useState(0);
  const [dia, setDia] = useState("");
  const [revision, setRevision] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const bloqueo = useRef(false);
  const [version, setVersion] = useState(0);
  const [confirmar, setConfirmar] = useState(false);
  const [resultados, setResultados] = useState<Record<string, string>>({});
  useEffect(() => {
    setPagina(0);
    setDia("");
    setSeleccion([]);
    setResultados({});
  }, [mes, sucursalId]);
  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setError("");
    setSeleccion([]);
    const [a, m] = mes.split("-").map(Number);
    const desde = dia.startsWith(mes) ? dia : `${mes}-01`;
    const hasta = dia.startsWith(mes) ? dia : `${mes}-${new Date(a, m, 0).getDate()}`;
    void supa
      .rpc("ventas_pendientes_fiscales", {
        p_sucursal_id: sucursalId,
        p_desde: desde,
        p_hasta: hasta,
        p_offset: pagina * 100,
      })
      .then(({ data, error }) => {
        if (!vivo) return;
        setCargando(false);
        if (error) {
          setError(error.message);
          setFilas([]);
        } else setFilas((data ?? []) as Pendiente[]);
      });
    return () => {
      vivo = false;
    };
  }, [mes, sucursalId, pagina, dia, version]);
  const refrescar = () => {
    setVersion((v) => v + 1);
    onCambio();
  };
  const elegibles = filas.filter((f) => f.comprobante_id && f.revision === "listo");
  const total = filas
    .filter((f) => seleccion.includes(f.comprobante_id ?? ""))
    .reduce((n, f) => n + Number(f.total), 0);
  async function preparar(f: Pendiente) {
    if (bloqueo.current || !sucursalId) return;
    bloqueo.current = true;
    setOcupado(true);
    setError("");
    try {
      const { data, error } = await supa.rpc("preparar_comprobante", { p_venta_id: f.venta_id });
      if (error) setError(error.message);
      else {
        refrescar();
        onAbrir(data as string);
      }
    } finally {
      bloqueo.current = false;
      setOcupado(false);
    }
  }
  async function enviar() {
    if (bloqueo.current || !sucursalId || !puedeAutorizar) return;
    bloqueo.current = true;
    setOcupado(true);
    setConfirmar(false);
    setResultados({});
    const ids = [...seleccion];
    try {
      await ejecutarLoteFiscal(
        ids,
        (id) => pedirCae(id, sucursalId),
        (id, r) => {
          const texto =
            r instanceof Error
              ? r.message
              : !r.ok
                ? r.error
                : r.datos.estado === "emitido"
                  ? `Emitida · CAE ${r.datos.cae}`
                  : r.datos.estado === "rechazado"
                    ? `Rechazada: ${r.datos.observacion}`
                    : "Pedido recibido · esperando CAE (todavía no emitida)";
          setResultados((prev) => ({ ...prev, [id]: texto }));
        },
      );
    } finally {
      bloqueo.current = false;
      setOcupado(false);
      setSeleccion([]);
      refrescar();
    }
  }
  return (
    <section className="card-surface p-4 space-y-4">
      <h2 className="text-lg font-semibold">Pendientes de revisión y emisión</h2>
      <p className="text-sm">
        Ventas sin CAE, organizadas por fecha. Ninguna se envía al vender ni al preparar el
        borrador. Las no seleccionadas conservan su estado, importe e historial. El Libro IVA es una
        vista separada de los comprobantes emitidos.
      </p>
      <div className="flex flex-wrap gap-3 items-center">
        <label>
          Día (opcional){" "}
          <input
            aria-label="Filtrar pendientes por día"
            type="date"
            min={`${mes}-01`}
            value={dia}
            disabled={ocupado}
            onChange={(e) => {
              setDia(e.target.value);
              setPagina(0);
            }}
            style={inputStyle}
          />
        </label>
        <BotonSecundario
          disabled={ocupado}
          onClick={() => {
            setDia("");
            setPagina(0);
          }}
        >
          Todo el mes
        </BotonSecundario>
        <BotonSecundario disabled={ocupado} onClick={refrescar}>
          Actualizar
        </BotonSecundario>
      </div>
      {!sucursalId && (
        <Alerta tono="info">Vista conjunta de solo lectura. Elegí una sucursal para operar.</Alerta>
      )}
      {error && <Alerta tono="danger">{error}</Alerta>}
      {ocupado && (
        <Alerta tono="info">
          Procesando. No cierres esta pantalla. Si se interrumpe, actualizá y consultá los
          resultados antes de volver a seleccionar.
        </Alerta>
      )}
      {puedeAutorizar && sucursalId && (
        <div className="flex gap-2 items-center">
          <BotonSecundario
            disabled={ocupado || cargando}
            onClick={() => setSeleccion(elegibles.map((f) => f.comprobante_id!))}
          >
            Seleccionar revisadas de esta página
          </BotonSecundario>
          <BotonSecundario disabled={ocupado} onClick={() => setSeleccion([])}>
            Limpiar
          </BotonSecundario>
          <BotonPrimario
            disabled={ocupado || cargando || !seleccion.length}
            onClick={() => setConfirmar(true)}
          >
            Autorizar {seleccion.length} · {formatARS(total)}
          </BotonPrimario>
        </div>
      )}
      {cargando ? (
        <p>Cargando pendientes…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Elegir</th>
                <th>Día</th>
                <th>Venta</th>
                <th>Cliente</th>
                <th>Total</th>
                <th>Situación</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <tr key={f.venta_id} className="border-t">
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Seleccionar venta ${f.numero}`}
                      disabled={
                        ocupado ||
                        !puedeAutorizar ||
                        !sucursalId ||
                        f.revision !== "listo" ||
                        !f.comprobante_id
                      }
                      checked={seleccion.includes(f.comprobante_id ?? "")}
                      onChange={(e) =>
                        setSeleccion((s) =>
                          e.target.checked
                            ? [...s, f.comprobante_id!]
                            : s.filter((id) => id !== f.comprobante_id),
                        )
                      }
                    />
                  </td>
                  <td>{f.fecha}</td>
                  <td>#{f.numero}</td>
                  <td>{f.cliente}</td>
                  <td>{formatARS(Number(f.total))}</td>
                  <td>
                    {f.estado.replaceAll("_", " ")} · {f.revision.replaceAll("_", " ")}
                  </td>
                  <td className="py-2">
                    {f.comprobante_id ? (
                      <>
                        <button
                          className="underline mr-3"
                          disabled={ocupado}
                          onClick={() => onAbrir(f.comprobante_id!)}
                        >
                          Ver detalle
                        </button>
                        {puedeAutorizar && sucursalId && (
                          <button
                            className="underline"
                            disabled={ocupado}
                            onClick={() => setRevision(f.comprobante_id)}
                          >
                            Revisar
                          </button>
                        )}
                      </>
                    ) : (
                      sucursalId && (
                        <button
                          className="underline"
                          disabled={ocupado}
                          onClick={() => void preparar(f)}
                        >
                          Preparar borrador (no envía)
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filas.length && <p>No hay ventas pendientes en este período.</p>}
        </div>
      )}
      <div className="flex gap-3 items-center">
        <BotonSecundario disabled={ocupado || pagina === 0} onClick={() => setPagina((p) => p - 1)}>
          Anterior
        </BotonSecundario>
        <span>
          Página {pagina + 1} · {filas[0]?.total_filas ?? 0} pendientes del período
        </span>
        <BotonSecundario
          disabled={ocupado || (pagina + 1) * 100 >= Number(filas[0]?.total_filas ?? 0)}
          onClick={() => setPagina((p) => p + 1)}
        >
          Siguiente
        </BotonSecundario>
      </div>
      {Object.keys(resultados).length > 0 && (
        <div role="status">
          <h3>Resultado individual del último lote</h3>
          {Object.entries(resultados).map(([id, texto]) => (
            <p key={id} className="text-sm break-all">
              {id}: {texto}
            </p>
          ))}
          <p>Actualizar consulta el estado guardado; no vuelve a emitir.</p>
        </div>
      )}
      {revision && sucursalId && (
        <RevisionFiscal
          id={revision}
          sucursalId={sucursalId}
          onCerrar={() => setRevision(null)}
          onListo={() => {
            setRevision(null);
            refrescar();
          }}
        />
      )}
      {confirmar && (
        <Modal titulo="Autorizar emisión fiscal real" onCerrar={() => setConfirmar(false)}>
          <p>
            Enviar únicamente los {seleccion.length} comprobantes seleccionados por{" "}
            {formatARS(total)} a Gateway. Los demás siguen pendientes. Una vez enviados no se
            editan. Esto no es una prueba.
          </p>
          <div className="flex gap-2 mt-4">
            <BotonSecundario onClick={() => setConfirmar(false)}>Cancelar</BotonSecundario>
            <BotonPrimario onClick={() => void enviar()}>Confirmar envío a Gateway</BotonPrimario>
          </div>
        </Modal>
      )}
    </section>
  );
}
