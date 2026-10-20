import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Alerta,
  BotonPrimario,
  BotonSecundario,
  Modal,
  inputCls,
  inputStyle,
} from "@/components/ui-bits/Modal";
import { useSesion, useSucursalOperativa, type Sucursal } from "@/lib/sesion";
import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";
import { ArrowDown, ArrowUp, Lock, Unlock } from "lucide-react";

export const Route = createFileRoute("/caja")({
  head: () => ({
    meta: [
      { title: "Caja — PymeOS" },
      {
        name: "description",
        content: "Caja diaria por sucursal con apertura, movimientos y cierre con arqueo.",
      },
    ],
  }),
  component: Caja,
});

type Turno = {
  id: string;
  numero: number;
  monto_apertura: number;
  abierto_por: string | null;
  abierto_at: string;
};

type Cierre = {
  id: string;
  numero: number;
  cerrado_at: string;
  cerrado_por: string | null;
  monto_esperado: number;
  monto_contado: number;
  diferencia: number;
  nota_cierre: string | null;
};

type Movimiento = {
  momento: string;
  tipo: string;
  detalle: string;
  monto: number;
  quien: string;
};

const ETIQUETA_TIPO: Record<string, string> = {
  apertura: "Apertura",
  venta: "Venta",
  cobro: "Cobro de cuenta",
  ingreso: "Ingreso",
  retiro: "Retiro",
  anulacion: "Anulación",
};

function aNumero(texto: string): number {
  const n = Number(texto.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function hora(iso: string) {
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

function fecha(iso: string) {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function colorDiferencia(d: number) {
  if (d === 0) return "var(--success)";
  return d < 0 ? "var(--danger)" : "var(--warning)";
}

function Caja() {
  const { usuario } = useSesion();
  const sucursal = useSucursalOperativa();

  const [cargando, setCargando] = useState(true);
  const [turno, setTurno] = useState<Turno | null>(null);
  const [esperado, setEsperado] = useState(0);
  const [movimientos, setMovimientos] = useState<Movimiento[]>([]);
  const [cierres, setCierres] = useState<Cierre[]>([]);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  const [abriendo, setAbriendo] = useState(false);
  const [cerrando, setCerrando] = useState(false);
  const [movimiento, setMovimiento] = useState<"ingreso" | "retiro" | null>(null);

  const esDueno = usuario?.rol === "dueno";

  const cargar = useCallback(async () => {
    if (!sucursal) {
      setTurno(null);
      setMovimientos([]);
      setCierres([]);
      setCargando(false);
      return;
    }
    setCargando(true);
    setErrorCarga(null);

    const { data: fila, error } = await supa
      .from("turnos_caja")
      .select("id, numero, monto_apertura, abierto_por, abierto_at")
      .eq("sucursal_id", sucursal.id)
      .eq("estado", "abierto")
      .maybeSingle();

    if (error) {
      setErrorCarga(error.message);
      setCargando(false);
      return;
    }

    const abierto = (fila as Turno | null) ?? null;
    setTurno(abierto);

    if (abierto) {
      // El saldo y la lista salen de la misma fuente en la base: no se pueden
      // contradecir el número grande de arriba y las filas de abajo.
      const [saldo, lista] = await Promise.all([
        supa.rpc("saldo_esperado_caja", { p_turno_id: abierto.id }),
        supa.rpc("movimientos_del_turno", { p_turno_id: abierto.id }),
      ]);
      setEsperado(Number(saldo.data ?? 0));
      setMovimientos((lista.data ?? []) as Movimiento[]);
    } else {
      setEsperado(0);
      setMovimientos([]);
    }

    const [{ data: previos }, { data: gente }] = await Promise.all([
      supa
        .from("turnos_caja")
        .select(
          "id, numero, cerrado_at, cerrado_por, monto_esperado, monto_contado, diferencia, nota_cierre",
        )
        .eq("sucursal_id", sucursal.id)
        .eq("estado", "cerrado")
        .order("cerrado_at", { ascending: false })
        .limit(5),
      supa.from("usuarios").select("user_id, nombre"),
    ]);

    setCierres((previos ?? []) as Cierre[]);
    setNombres(
      Object.fromEntries(
        ((gente ?? []) as { user_id: string; nombre: string }[]).map((u) => [u.user_id, u.nombre]),
      ),
    );
    setCargando(false);
  }, [sucursal]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const { ingresos, egresos } = useMemo(() => {
    let ing = 0;
    let egr = 0;
    for (const m of movimientos) {
      if (m.tipo === "apertura") continue;
      if (m.monto < 0) egr += -m.monto;
      else ing += m.monto;
    }
    return { ingresos: ing, egresos: egr };
  }, [movimientos]);

  const apertura = turno?.monto_apertura ?? 0;

  if (!sucursal) {
    return (
      <>
        <PageHeader title="Caja" subtitle="Sin sucursal activa" />
        <Alerta tono="warning">
          Este equipo no tiene una sucursal activa, o estás mirando las dos juntas. La caja es el
          cajón de plata de un local: para verla o moverla hay que estar parado en uno.
        </Alerta>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Caja"
        subtitle={
          turno
            ? `${sucursal.nombre} · Turno #${turno.numero} abierto desde las ${hora(turno.abierto_at)}`
            : `${sucursal.nombre} · Caja cerrada`
        }
        actions={
          turno ? (
            <>
              <button
                onClick={() => setMovimiento("ingreso")}
                className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px]"
                style={inputStyle}
              >
                <ArrowDown size={13} /> Registrar ingreso
              </button>
              {esDueno && (
                <button
                  onClick={() => setMovimiento("retiro")}
                  className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px]"
                  style={inputStyle}
                >
                  <ArrowUp size={13} /> Registrar retiro
                </button>
              )}
              <button
                onClick={() => setCerrando(true)}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white"
                style={{ background: "var(--primary)" }}
              >
                <Lock size={13} /> Cerrar caja
              </button>
            </>
          ) : (
            <button
              onClick={() => setAbriendo(true)}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white"
              style={{ background: "var(--primary)" }}
            >
              <Unlock size={13} /> Abrir caja
            </button>
          )
        }
      />

      {errorCarga && (
        <div className="mb-3">
          <Alerta tono="danger">{errorCarga}</Alerta>
        </div>
      )}

      {!turno && !cargando && (
        <div className="mb-4">
          <Alerta tono="warning">
            La caja de {sucursal.nombre} está cerrada. Mientras siga así no se puede cobrar en
            efectivo: esa plata entraría al cajón sin un turno donde contarla. Cobrar con tarjeta o
            transferencia sigue andando.
          </Alerta>
        </div>
      )}

      {turno && (
        <>
          <div className="grid grid-cols-4 gap-3">
            <div className="card-surface p-4">
              <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                Saldo inicial
              </div>
              <div className="mt-1 text-[18px] font-semibold tabular">{formatARS(apertura)}</div>
            </div>
            <div className="card-surface p-4">
              <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                Ingresos
              </div>
              <div
                className="mt-1 text-[18px] font-semibold tabular"
                style={{ color: "var(--success)" }}
              >
                + {formatARS(ingresos)}
              </div>
            </div>
            <div className="card-surface p-4">
              <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                Egresos
              </div>
              <div
                className="mt-1 text-[18px] font-semibold tabular"
                style={{ color: "var(--danger)" }}
              >
                - {formatARS(egresos)}
              </div>
            </div>
            <div
              className="card-surface p-4"
              style={{ background: "linear-gradient(135deg, #101828, #2e4062)", color: "#fff" }}
            >
              <div className="text-[12px] opacity-80">Tendría que haber</div>
              <div className="mt-1 text-[26px] font-bold tabular">{formatARS(esperado)}</div>
            </div>
          </div>

          <div className="mt-4 card-surface overflow-hidden">
            <div
              className="px-4 py-3 text-[14px] font-semibold"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              Movimientos del turno
            </div>
            {movimientos.length === 0 ? (
              <div className="px-4 py-6 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                Todavía no se movió plata en este turno.
              </div>
            ) : (
              <table className="w-full text-[13px]">
                <thead style={{ background: "#f9fafc" }}>
                  <tr style={{ color: "var(--muted-foreground)" }}>
                    <th className="px-4 py-2 text-left font-medium">Hora</th>
                    <th className="px-4 py-2 text-left font-medium">Tipo</th>
                    <th className="px-4 py-2 text-left font-medium">Detalle</th>
                    <th className="px-4 py-2 text-left font-medium">Quién</th>
                    <th className="px-4 py-2 text-right font-medium">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {movimientos.map((m, i) => (
                    <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="px-4 py-2 tabular" style={{ color: "var(--muted-foreground)" }}>
                        {hora(m.momento)}
                      </td>
                      <td className="px-4 py-2 font-medium">{ETIQUETA_TIPO[m.tipo] ?? m.tipo}</td>
                      <td className="px-4 py-2">{m.detalle}</td>
                      <td className="px-4 py-2" style={{ color: "var(--muted-foreground)" }}>
                        {m.quien}
                      </td>
                      <td
                        className="px-4 py-2 text-right tabular font-medium"
                        style={{
                          color:
                            m.monto < 0
                              ? "var(--danger)"
                              : m.tipo === "apertura"
                                ? "var(--foreground)"
                                : "var(--success)",
                        }}
                      >
                        {m.monto < 0 ? "-" : m.tipo === "apertura" ? "" : "+"}{" "}
                        {formatARS(Math.abs(m.monto))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {cierres.length > 0 && (
        <div className="mt-4 card-surface overflow-hidden">
          <div
            className="px-4 py-3 text-[14px] font-semibold"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            Últimos cierres
          </div>
          <table className="w-full text-[13px]">
            <thead style={{ background: "#f9fafc" }}>
              <tr style={{ color: "var(--muted-foreground)" }}>
                <th className="px-4 py-2 text-left font-medium">Turno</th>
                <th className="px-4 py-2 text-left font-medium">Cerrado</th>
                <th className="px-4 py-2 text-left font-medium">Quién</th>
                <th className="px-4 py-2 text-right font-medium">Esperado</th>
                <th className="px-4 py-2 text-right font-medium">Contado</th>
                <th className="px-4 py-2 text-right font-medium">Diferencia</th>
              </tr>
            </thead>
            <tbody>
              {cierres.map((c) => (
                <tr key={c.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="px-4 py-2 tabular">#{c.numero}</td>
                  <td className="px-4 py-2 tabular" style={{ color: "var(--muted-foreground)" }}>
                    {fecha(c.cerrado_at)}
                  </td>
                  <td className="px-4 py-2">
                    {(c.cerrado_por ? nombres[c.cerrado_por] : null) ?? "—"}
                    {c.nota_cierre && (
                      <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                        {c.nota_cierre}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular">{formatARS(c.monto_esperado)}</td>
                  <td className="px-4 py-2 text-right tabular">{formatARS(c.monto_contado)}</td>
                  <td
                    className="px-4 py-2 text-right tabular font-medium"
                    style={{ color: colorDiferencia(Number(c.diferencia)) }}
                  >
                    {Number(c.diferencia) > 0 ? "+" : ""}
                    {formatARS(Number(c.diferencia))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {abriendo && (
        <DialogoApertura
          sucursal={sucursal}
          onCerrar={() => setAbriendo(false)}
          onListo={async () => {
            setAbriendo(false);
            await cargar();
          }}
        />
      )}

      {movimiento && turno && (
        <DialogoMovimiento
          sucursal={sucursal}
          tipo={movimiento}
          disponible={esperado}
          onCerrar={() => setMovimiento(null)}
          onListo={async () => {
            setMovimiento(null);
            await cargar();
          }}
        />
      )}

      {cerrando && turno && (
        <DialogoCierre
          turno={turno}
          esperado={esperado}
          onCerrar={() => setCerrando(false)}
          onListo={async () => {
            setCerrando(false);
            await cargar();
          }}
        />
      )}
    </>
  );
}

function DialogoApertura({
  sucursal,
  onCerrar,
  onListo,
}: {
  sucursal: Sucursal;
  onCerrar: () => void;
  onListo: () => Promise<void>;
}) {
  const [monto, setMonto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function abrir(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    const { error: err } = await supa.rpc("abrir_caja", {
      p_sucursal_id: sucursal.id,
      p_monto_apertura: aNumero(monto),
    });
    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    await onListo();
  }

  return (
    <Modal titulo={`Abrir la caja de ${sucursal.nombre}`} onCerrar={onCerrar}>
      <form onSubmit={(e) => void abrir(e)}>
        <Alerta tono="info">
          Contá la plata que hay ahora en el cajón y poné ese número. Es contra eso que a la noche
          se compara el arqueo.
        </Alerta>
        <label className="mt-3 block text-[12px]">
          Efectivo en el cajón
          <input
            value={monto}
            onChange={(e) => setMonto(e.target.value)}
            inputMode="decimal"
            placeholder="0"
            className={inputCls}
            style={inputStyle}
            autoFocus
          />
        </label>
        {error && (
          <div className="mt-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando}>Abrir la caja</BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

function DialogoMovimiento({
  sucursal,
  tipo,
  disponible,
  onCerrar,
  onListo,
}: {
  sucursal: Sucursal;
  tipo: "ingreso" | "retiro";
  disponible: number;
  onCerrar: () => void;
  onListo: () => Promise<void>;
}) {
  const [monto, setMonto] = useState("");
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function registrar(e: React.FormEvent) {
    e.preventDefault();
    if (!motivo.trim()) {
      setError("Escribí para qué. Un movimiento sin motivo no se puede explicar después.");
      return;
    }
    setEnviando(true);
    setError(null);
    const { error: err } = await supa.rpc("registrar_movimiento_caja", {
      p_sucursal_id: sucursal.id,
      p_tipo: tipo,
      p_monto: aNumero(monto),
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
    <Modal
      titulo={tipo === "ingreso" ? "Registrar un ingreso" : "Registrar un retiro"}
      onCerrar={onCerrar}
    >
      <form onSubmit={(e) => void registrar(e)}>
        <Alerta tono={tipo === "retiro" ? "warning" : "info"}>
          {tipo === "ingreso"
            ? "Plata que entra al cajón y no viene de una venta: reponer vuelto, un aporte."
            : `Plata que sale del cajón: llevarla al banco, pagar algo en mano. Ahora hay ${formatARS(disponible)}.`}
        </Alerta>
        <label className="mt-3 block text-[12px]">
          Monto
          <input
            value={monto}
            onChange={(e) => setMonto(e.target.value)}
            inputMode="decimal"
            placeholder="0"
            className={inputCls}
            style={inputStyle}
            autoFocus
          />
        </label>
        <label className="mt-3 block text-[12px]">
          Para qué
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder={tipo === "ingreso" ? "Reposición de vuelto" : "Depósito en el banco"}
            className={inputCls}
            style={inputStyle}
          />
        </label>
        {error && (
          <div className="mt-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando}>
            {tipo === "ingreso" ? "Registrar el ingreso" : "Registrar el retiro"}
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

function DialogoCierre({
  turno,
  esperado,
  onCerrar,
  onListo,
}: {
  turno: Turno;
  esperado: number;
  onCerrar: () => void;
  onListo: () => Promise<void>;
}) {
  const [contado, setContado] = useState("");
  const [nota, setNota] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Se calcula mientras escribe: el arqueo sirve cuando el número aparece
  // antes de apretar el botón, no después.
  const diferencia = contado.trim() === "" ? null : aNumero(contado) - esperado;
  const necesitaNota = diferencia !== null && diferencia !== 0;

  async function cerrar(e: React.FormEvent) {
    e.preventDefault();
    if (necesitaNota && !nota.trim()) {
      setError("Hay diferencia. Explicá por qué antes de cerrar.");
      return;
    }
    setEnviando(true);
    setError(null);
    const { error: err } = await supa.rpc("cerrar_caja", {
      p_turno_id: turno.id,
      p_monto_contado: aNumero(contado),
      p_nota: nota.trim(),
    });
    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    await onListo();
  }

  return (
    <Modal titulo={`Cerrar el turno #${turno.numero}`} onCerrar={onCerrar}>
      <form onSubmit={(e) => void cerrar(e)}>
        <div className="rounded-md px-3 py-2" style={{ background: "#f9fafc" }}>
          <div className="flex items-center justify-between text-[13px]">
            <span style={{ color: "var(--muted-foreground)" }}>Tendría que haber</span>
            <span className="tabular font-semibold">{formatARS(esperado)}</span>
          </div>
        </div>

        <label className="mt-3 block text-[12px]">
          Contá la plata y poné cuánto hay
          <input
            value={contado}
            onChange={(e) => setContado(e.target.value)}
            inputMode="decimal"
            placeholder="0"
            className={inputCls}
            style={inputStyle}
            autoFocus
          />
        </label>

        {diferencia !== null && (
          <div className="mt-3 flex items-center justify-between text-[13px]">
            <span style={{ color: "var(--muted-foreground)" }}>Diferencia</span>
            <span className="tabular font-semibold" style={{ color: colorDiferencia(diferencia) }}>
              {diferencia > 0 ? "+" : ""}
              {formatARS(diferencia)}
              {diferencia < 0 && " (falta)"}
              {diferencia > 0 && " (sobra)"}
            </span>
          </div>
        )}

        {necesitaNota && (
          <>
            <div className="mt-3">
              <Alerta tono="warning">
                No cuadra. El cierre queda guardado con la diferencia y con tu nombre, así que
                explicá qué pasó: sirve para entenderlo dentro de un mes.
              </Alerta>
            </div>
            <label className="mt-3 block text-[12px]">
              Qué pasó
              <input
                value={nota}
                onChange={(e) => setNota(e.target.value)}
                placeholder="Se pagó un flete en mano y no se cargó"
                className={inputCls}
                style={inputStyle}
              />
            </label>
          </>
        )}

        {error && (
          <div className="mt-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando} disabled={contado.trim() === ""}>
            Cerrar la caja
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}
