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
import { useSesion, useSucursalOperativa } from "@/lib/sesion";
import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";
import { AlertTriangle, Loader2, Plus } from "lucide-react";

export const Route = createFileRoute("/cheques")({
  head: () => ({
    meta: [
      { title: "Cheques — PymeOS" },
      { name: "description", content: "Cartera de cheques: qué entra, qué sale y cuándo." },
    ],
  }),
  component: Cheques,
});

type EstadoCheque =
  | "en_cartera" | "depositado" | "acreditado" | "endosado" | "descontado"
  | "emitido" | "debitado" | "rechazado" | "anulado";

type Cheque = {
  id: string;
  tipo: "tercero" | "propio";
  numero: string;
  banco: string;
  echeq: boolean;
  importe: number;
  fecha_emision: string;
  fecha_pago: string;
  estado: EstadoCheque;
  librador_nombre: string | null;
  cliente_id: string | null;
  cuenta_bancaria: string | null;
  entregado_a: string | null;
  nota: string | null;
  clientes: { nombre: string } | null;
};

type MovimientoCheque = {
  id: string;
  de_estado: string | null;
  a_estado: EstadoCheque;
  nota: string | null;
  created_at: string;
  usuarios: { nombre: string } | null;
  sucursales: { alias: string } | null;
};

type ClienteMin = { id: string; nombre: string };

const ETIQUETA: Record<EstadoCheque, string> = {
  en_cartera: "En cartera",
  depositado: "Depositado",
  acreditado: "Acreditado",
  endosado: "Endosado",
  descontado: "Descontado",
  emitido: "Emitido",
  debitado: "Debitado",
  rechazado: "Rechazado",
  anulado: "Anulado",
};

/** colores de badge: ambar = requiere seguimiento, verde = resuelto bien, rojo = problema */
const BADGE: Record<EstadoCheque, { bg: string; fg: string }> = {
  en_cartera: { bg: "#e8f0fe", fg: "#1d4ed8" },
  depositado: { bg: "#fef3e2", fg: "#b45309" },
  acreditado: { bg: "#e3f6ee", fg: "#0f7a4d" },
  endosado: { bg: "#f1eafd", fg: "#6d3fc4" },
  descontado: { bg: "#f1eafd", fg: "#6d3fc4" },
  emitido: { bg: "#fef3e2", fg: "#b45309" },
  debitado: { bg: "#e3f6ee", fg: "#0f7a4d" },
  rechazado: { bg: "#fdecea", fg: "#c0261b" },
  anulado: { bg: "#eef1f5", fg: "#667085" },
};

/** acciones que ofrece la pantalla; la base igual valida el grafo (la UI solo acompaña) */
const ACCIONES: Partial<Record<EstadoCheque, { destino: EstadoCheque; lbl: string; confirmar?: string }[]>> = {
  en_cartera: [
    { destino: "depositado", lbl: "Depositar" },
    { destino: "endosado", lbl: "Endosar" },
    { destino: "descontado", lbl: "Descontar" },
    { destino: "anulado", lbl: "Anular", confirmar: "¿Anular este cheque? Solo para cargas erróneas." },
  ],
  depositado: [
    { destino: "acreditado", lbl: "Se acreditó" },
    { destino: "rechazado", lbl: "Rechazado", confirmar: "¿Marcar rechazado? Si vino de un cliente, su deuda vuelve a la cuenta corriente." },
  ],
  endosado: [{ destino: "rechazado", lbl: "Rechazado", confirmar: "¿Marcar rechazado? El endoso rebota contra el negocio." }],
  descontado: [{ destino: "rechazado", lbl: "Rechazado", confirmar: "¿Marcar rechazado?" }],
  emitido: [
    { destino: "debitado", lbl: "Se debitó" },
    { destino: "rechazado", lbl: "Rechazado", confirmar: "¿Marcar rechazado? Revisá fondos: la deuda con el proveedor sigue viva." },
    { destino: "anulado", lbl: "Anular", confirmar: "¿Anular este cheque propio? Solo si nunca se entregó." },
  ],
  rechazado: [{ destino: "en_cartera", lbl: "Volver a cartera" }],
};

const VIVOS: EstadoCheque[] = ["en_cartera", "depositado", "endosado", "descontado", "emitido", "rechazado"];

function fechaCorta(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

function hoyISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ===== flujo por vencimiento (compromiso bancario futuro, estilo Nativo) ===== */

type Tramo = { etiqueta: string; entran: number; salen: number; neto: number; cantidad: number };

export function flujoPorVencimiento(cheques: Cheque[], hoy: string): Tramo[] {
  const dia = (offset: number) => {
    const d = new Date(hoy + "T00:00:00");
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const tramos: { etiqueta: string; desde: string | null; hasta: string | null }[] = [
    { etiqueta: "Vencidos", desde: null, hasta: hoy },
    { etiqueta: "Esta semana", desde: hoy, hasta: dia(7) },
    { etiqueta: "Próxima semana", desde: dia(7), hasta: dia(14) },
    { etiqueta: "Hasta 30 días", desde: dia(14), hasta: dia(30) },
    { etiqueta: "Más adelante", desde: dia(30), hasta: null },
  ];
  // endosados/descontados afuera: esa plata ya se usó
  const relevantes = cheques.filter(
    (c) =>
      (c.tipo === "tercero" && (c.estado === "en_cartera" || c.estado === "depositado")) ||
      (c.tipo === "propio" && c.estado === "emitido"),
  );
  return tramos.map(({ etiqueta, desde, hasta }) => {
    const del = relevantes.filter((c) => {
      const f = c.fecha_pago.slice(0, 10);
      if (desde === null) return f < (hasta as string);
      if (hasta === null) return f >= desde;
      return f >= desde && f < hasta;
    });
    const entran = del.filter((c) => c.tipo === "tercero").reduce((a, c) => a + Number(c.importe), 0);
    const salen = del.filter((c) => c.tipo === "propio").reduce((a, c) => a + Number(c.importe), 0);
    return { etiqueta, entran, salen, neto: entran - salen, cantidad: del.length };
  });
}

/* ===== pantalla ===== */

const FORM_VACIO = {
  tipo: "tercero" as "tercero" | "propio",
  numero: "",
  banco: "",
  importe: "",
  echeq: false,
  fecha_emision: hoyISO(),
  fecha_pago: hoyISO(),
  librador_nombre: "",
  librador_cuit: "",
  cliente_id: "",
  cuenta_bancaria: "",
  entregado_a: "",
  nota: "",
};

function Cheques() {
  const { usuario } = useSesion();
  const sucursal = useSucursalOperativa();
  const soloLectura = !sucursal;

  const [cheques, setCheques] = useState<Cheque[] | null>(null);
  const [clientes, setClientes] = useState<ClienteMin[]>([]);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"cartera" | "propios" | "historico">("cartera");
  const [alta, setAlta] = useState(false);
  const [form, setForm] = useState(FORM_VACIO);
  const [errAlta, setErrAlta] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [historial, setHistorial] = useState<MovimientoCheque[] | null>(null);
  const [aviso, setAviso] = useState("");

  const cargar = useCallback(async () => {
    const [ch, cl] = await Promise.all([
      supa
        .from("cheques")
        .select("id, tipo, numero, banco, echeq, importe, fecha_emision, fecha_pago, estado, librador_nombre, cliente_id, cuenta_bancaria, entregado_a, nota, clientes ( nombre )")
        .order("fecha_pago", { ascending: true }),
      supa.from("clientes").select("id, nombre").eq("activo", true).order("nombre"),
    ]);
    if (ch.error) {
      setError(ch.error.message);
      return;
    }
    setCheques((ch.data ?? []) as unknown as Cheque[]);
    if (!cl.error) setClientes((cl.data ?? []) as ClienteMin[]);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const hoy = hoyISO();
  const lista = cheques ?? [];
  const terceros = lista.filter((c) => c.tipo === "tercero" && VIVOS.includes(c.estado));
  const propios = lista.filter((c) => c.tipo === "propio" && VIVOS.includes(c.estado));
  const historico = lista.filter((c) => !VIVOS.includes(c.estado));
  const visibles = tab === "cartera" ? terceros : tab === "propios" ? propios : historico;

  const flujo = useMemo(() => flujoPorVencimiento(lista, hoy), [lista, hoy]);
  const hayFlujo = flujo.some((t) => t.cantidad > 0);
  const enCartera = terceros.filter((c) => c.estado === "en_cartera").reduce((a, c) => a + Number(c.importe), 0);
  const comprometido = propios.filter((c) => c.estado === "emitido").reduce((a, c) => a + Number(c.importe), 0);

  const detalle = detalleId ? lista.find((c) => c.id === detalleId) ?? null : null;

  useEffect(() => {
    if (!detalleId) {
      setHistorial(null);
      return;
    }
    void (async () => {
      const { data, error: err } = await supa
        .from("cheque_movimientos")
        .select("id, de_estado, a_estado, nota, created_at, usuarios ( nombre ), sucursales ( alias )")
        .eq("cheque_id", detalleId)
        .order("created_at", { ascending: false });
      if (!err) setHistorial((data ?? []) as unknown as MovimientoCheque[]);
    })();
  }, [detalleId]);

  const transicionar = async (c: Cheque, destino: EstadoCheque, confirmar?: string) => {
    if (!sucursal) return;
    if (confirmar && !window.confirm(confirmar)) return;
    setAviso("");
    const { error: err } = await supa.rpc("transicionar_cheque", {
      p_cheque_id: c.id,
      p_sucursal_id: sucursal.id,
      p_destino: destino,
    });
    if (err) {
      setError(err.message);
      return;
    }
    if (destino === "rechazado" && c.tipo === "tercero" && c.cliente_id) {
      setAviso(
        `La deuda de ${c.clientes?.nombre ?? "el cliente"} (${formatARS(Number(c.importe))}) volvió a su cuenta corriente.`,
      );
    }
    await cargar();
  };

  const guardarAlta = async () => {
    if (!sucursal) return;
    setErrAlta("");
    const importe = Number(form.importe);
    if (!form.numero.trim() || !form.banco.trim()) {
      setErrAlta("Completá número y banco.");
      return;
    }
    if (!Number.isFinite(importe) || importe <= 0) {
      setErrAlta("El importe tiene que ser mayor a cero.");
      return;
    }
    if (form.fecha_pago < form.fecha_emision) {
      setErrAlta("La fecha de pago no puede ser anterior a la de emisión.");
      return;
    }
    setGuardando(true);
    const { error: err } = await supa.rpc("registrar_cheque", {
      p_sucursal_id: sucursal.id,
      p_tipo: form.tipo,
      p_numero: form.numero.trim(),
      p_banco: form.banco.trim(),
      p_importe: importe,
      p_fecha_emision: form.fecha_emision,
      p_fecha_pago: form.fecha_pago,
      p_echeq: form.echeq,
      p_librador_nombre: form.tipo === "tercero" ? form.librador_nombre.trim() || null : null,
      p_librador_cuit: form.tipo === "tercero" ? form.librador_cuit.trim() || null : null,
      p_cliente_id: form.tipo === "tercero" && form.cliente_id ? form.cliente_id : null,
      p_cuenta_bancaria: form.tipo === "propio" ? form.cuenta_bancaria.trim() || null : null,
      p_entregado_a: form.tipo === "propio" ? form.entregado_a.trim() || null : null,
      p_nota: form.nota.trim() || null,
    });
    setGuardando(false);
    if (err) {
      setErrAlta(
        err.message.includes("cheques_no_duplicado")
          ? `Ya hay un cheque ${form.tipo === "propio" ? "propio" : "de terceros"} Nº ${form.numero} de ${form.banco}.`
          : err.message,
      );
      return;
    }
    setForm(FORM_VACIO);
    setAlta(false);
    await cargar();
  };

  const vencido = (c: Cheque) =>
    (c.estado === "en_cartera" || c.estado === "emitido") && c.fecha_pago.slice(0, 10) < hoy;
  const vencidos = flujo[0];

  return (
    <>
      <PageHeader
        title="Cheques"
        subtitle={`${terceros.length} en gestión · ${formatARS(enCartera)} en cartera · ${formatARS(comprometido)} comprometido en propios`}
        actions={
          soloLectura ? undefined : (
            <button
              type="button"
              onClick={() => { setForm(FORM_VACIO); setErrAlta(""); setAlta(true); }}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white"
              style={{ background: "var(--primary)" }}
            >
              <Plus size={14} />
              Cargar cheque
            </button>
          )
        }
      />

      {soloLectura && (
        <div className="mb-3">
          <Alerta tono="warning">Viendo las dos sucursales: solo lectura. Para operar, activá una sucursal.</Alerta>
        </div>
      )}
      {error && (
        <div className="mb-3">
          <Alerta tono="danger">{error}</Alerta>
        </div>
      )}
      {aviso && (
        <div className="mb-3">
          <Alerta tono="info">{aviso}</Alerta>
        </div>
      )}

      {hayFlujo && (
        <div className="card-surface mb-4 overflow-x-auto p-4" style={{ background: "var(--surface)" }}>
          <h2 className="mb-2 text-[14px] font-semibold">Flujo por vencimiento</h2>
          <table className="w-full text-[13px]">
            <thead>
              <tr style={{ color: "var(--muted-foreground)" }}>
                <th className="py-1.5 pr-3 text-left font-medium"></th>
                {flujo.map((t) => (
                  <th key={t.etiqueta} className="px-3 py-1.5 text-right font-medium">
                    {t.etiqueta}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-1.5 pr-3">Entran (terceros)</td>
                {flujo.map((t) => (
                  <td key={t.etiqueta} className="px-3 py-1.5 text-right tabular-nums">
                    {t.entran ? formatARS(t.entran) : "—"}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="py-1.5 pr-3">Salen (propios)</td>
                {flujo.map((t) => (
                  <td key={t.etiqueta} className="px-3 py-1.5 text-right tabular-nums">
                    {t.salen ? `-${formatARS(t.salen)}` : "—"}
                  </td>
                ))}
              </tr>
              <tr className="border-t font-semibold" style={{ borderColor: "var(--border)" }}>
                <td className="py-1.5 pr-3">Neto</td>
                {flujo.map((t) => (
                  <td
                    key={t.etiqueta}
                    className="px-3 py-1.5 text-right tabular-nums"
                    style={{ color: t.cantidad === 0 ? undefined : t.neto < 0 ? "#c0261b" : "#0f7a4d" }}
                  >
                    {t.cantidad ? formatARS(t.neto) : "—"}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          {vencidos.cantidad > 0 && (
            <p className="mt-2 flex items-center gap-1.5 text-[12.5px]" style={{ color: "#c0261b" }}>
              <AlertTriangle size={14} />
              {vencidos.cantidad} cheque{vencidos.cantidad > 1 ? "s" : ""} vencido{vencidos.cantidad > 1 ? "s" : ""} sin
              resolver — un cheque prescribe a los 30 días de su fecha de pago.
            </p>
          )}
        </div>
      )}

      <div className="mb-3 flex gap-1 border-b" style={{ borderColor: "var(--border)" }}>
        {(
          [
            ["cartera", `Cartera (${terceros.length})`],
            ["propios", `Propios (${propios.length})`],
            ["historico", `Histórico (${historico.length})`],
          ] as const
        ).map(([clave, etiqueta]) => (
          <button
            key={clave}
            onClick={() => setTab(clave)}
            className="px-3.5 py-2 text-[13px] font-medium"
            style={{
              color: tab === clave ? "var(--primary)" : "var(--muted-foreground)",
              borderBottom: tab === clave ? "2px solid var(--primary)" : "2px solid transparent",
              marginBottom: -1,
            }}
          >
            {etiqueta}
          </button>
        ))}
      </div>

      <div className="card-surface overflow-hidden" style={{ background: "var(--surface)" }}>
        {cheques === null ? (
          <div className="grid place-items-center py-10" style={{ color: "var(--muted-foreground)" }}>
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : visibles.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            {tab === "cartera" &&
              "Sin cheques de terceros en gestión. Cargá el primero cuando un cliente pague con cheque."}
            {tab === "propios" &&
              "Sin cheques propios pendientes. Cargá los que emitas para saber cuánto se debita y cuándo."}
            {tab === "historico" && "Todavía no hay cheques resueltos."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: "#f9fafc", color: "var(--muted-foreground)" }}>
                  <th className="px-3 py-2 text-left font-medium">Cheque</th>
                  <th className="px-3 py-2 text-left font-medium">
                    {tab === "propios" ? "Entregado a" : "Librador / cliente"}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">Pago</th>
                  <th className="px-3 py-2 text-right font-medium">Importe</th>
                  <th className="px-3 py-2 text-left font-medium">Estado</th>
                  <th className="px-3 py-2 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setDetalleId(c.id)}
                    className="cursor-pointer border-t"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <td className="px-3 py-2">
                      Nº {c.numero} · {c.banco}
                      {c.echeq && (
                        <span
                          className="ml-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{ background: "#eef1f5", color: "#667085" }}
                        >
                          e-cheq
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {c.tipo === "tercero"
                        ? c.clientes?.nombre ?? c.librador_nombre ?? "—"
                        : c.entregado_a ?? "—"}
                    </td>
                    <td className="px-3 py-2" style={vencido(c) ? { color: "#c0261b", fontWeight: 600 } : undefined}>
                      {fechaCorta(c.fecha_pago)}
                      {vencido(c) && " ⚠"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatARS(Number(c.importe))}</td>
                    <td className="px-3 py-2">
                      <span
                        className="rounded-full px-2 py-0.5 text-[11.5px] font-medium"
                        style={{ background: BADGE[c.estado].bg, color: BADGE[c.estado].fg }}
                      >
                        {ETIQUETA[c.estado]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                      {!soloLectura &&
                        (ACCIONES[c.estado] ?? []).map((a) => (
                          <button
                            key={a.destino}
                            onClick={() => void transicionar(c, a.destino, a.confirmar)}
                            className="ml-1 rounded-md px-2 py-1 text-[12px] font-medium"
                            style={{ color: "var(--primary)" }}
                          >
                            {a.lbl}
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {alta && sucursal && (
        <Modal titulo="Cargar cheque" onCerrar={() => setAlta(false)} ancho="max-w-lg">
          {errAlta && (
            <div className="mb-3">
              <Alerta tono="danger">{errAlta}</Alerta>
            </div>
          )}
          <form onSubmit={(e) => { e.preventDefault(); void guardarAlta(); }}>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[12.5px] font-medium">
              Tipo
              <select
                className={inputCls}
                style={inputStyle}
                value={form.tipo}
                onChange={(e) => setForm({ ...form, tipo: e.target.value as "tercero" | "propio" })}
              >
                <option value="tercero">De tercero (lo recibí)</option>
                <option value="propio">Propio (lo emití)</option>
              </select>
            </label>
            <label className="text-[12.5px] font-medium">
              Formato
              <select
                className={inputCls}
                style={inputStyle}
                value={form.echeq ? "e" : "p"}
                onChange={(e) => setForm({ ...form, echeq: e.target.value === "e" })}
              >
                <option value="p">Papel</option>
                <option value="e">E-cheq</option>
              </select>
            </label>
            <label className="text-[12.5px] font-medium">
              Número
              <input
                className={inputCls}
                style={inputStyle}
                value={form.numero}
                onChange={(e) => setForm({ ...form, numero: e.target.value })}
              />
            </label>
            <label className="text-[12.5px] font-medium">
              Banco
              <input
                className={inputCls}
                style={inputStyle}
                value={form.banco}
                onChange={(e) => setForm({ ...form, banco: e.target.value })}
              />
            </label>
            <label className="text-[12.5px] font-medium">
              Importe
              <input
                className={inputCls}
                style={inputStyle}
                type="number"
                min="0"
                value={form.importe}
                onChange={(e) => setForm({ ...form, importe: e.target.value })}
              />
            </label>
            <label className="text-[12.5px] font-medium">
              Emisión
              <input
                className={inputCls}
                style={inputStyle}
                type="date"
                value={form.fecha_emision}
                onChange={(e) => setForm({ ...form, fecha_emision: e.target.value })}
              />
            </label>
            <label className="text-[12.5px] font-medium">
              Fecha de pago
              <input
                className={inputCls}
                style={inputStyle}
                type="date"
                value={form.fecha_pago}
                onChange={(e) => setForm({ ...form, fecha_pago: e.target.value })}
              />
            </label>
            <div aria-hidden />

            {form.tipo === "tercero" ? (
              <>
                <label className="text-[12.5px] font-medium">
                  Librador (quien lo firmó)
                  <input
                    className={inputCls}
                    style={inputStyle}
                    value={form.librador_nombre}
                    onChange={(e) => setForm({ ...form, librador_nombre: e.target.value })}
                  />
                </label>
                <label className="text-[12.5px] font-medium">
                  CUIT del librador
                  <input
                    className={inputCls}
                    style={inputStyle}
                    value={form.librador_cuit}
                    onChange={(e) => setForm({ ...form, librador_cuit: e.target.value })}
                  />
                </label>
                <label className="col-span-2 text-[12.5px] font-medium">
                  Recibido del cliente (si rebota, su deuda vuelve sola a la cuenta corriente)
                  <select
                    className={inputCls}
                    style={inputStyle}
                    value={form.cliente_id}
                    onChange={(e) => setForm({ ...form, cliente_id: e.target.value })}
                  >
                    <option value="">— Sin cliente asociado —</option>
                    {clientes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nombre}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <>
                <label className="text-[12.5px] font-medium">
                  Cuenta bancaria
                  <input
                    className={inputCls}
                    style={inputStyle}
                    placeholder="ej. Galicia CC $"
                    value={form.cuenta_bancaria}
                    onChange={(e) => setForm({ ...form, cuenta_bancaria: e.target.value })}
                  />
                </label>
                <label className="text-[12.5px] font-medium">
                  Entregado a
                  <input
                    className={inputCls}
                    style={inputStyle}
                    placeholder="proveedor / destinatario"
                    value={form.entregado_a}
                    onChange={(e) => setForm({ ...form, entregado_a: e.target.value })}
                  />
                </label>
              </>
            )}

            <label className="col-span-2 text-[12.5px] font-medium">
              Nota
              <input
                className={inputCls}
                style={inputStyle}
                value={form.nota}
                onChange={(e) => setForm({ ...form, nota: e.target.value })}
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <BotonSecundario onClick={() => setAlta(false)}>Cancelar</BotonSecundario>
            <BotonPrimario enviando={guardando}>Guardar cheque</BotonPrimario>
          </div>
          </form>
        </Modal>
      )}

      {detalle && (
        <Modal titulo={`Cheque Nº ${detalle.numero} · ${detalle.banco}`} onCerrar={() => setDetalleId(null)} ancho="max-w-lg">
          <p className="mb-3 text-[13.5px]">
            {formatARS(Number(detalle.importe))} · {detalle.tipo === "tercero" ? "de tercero" : "propio"}
            {detalle.echeq ? " · e-cheq" : ""} ·{" "}
            <span
              className="rounded-full px-2 py-0.5 text-[11.5px] font-medium"
              style={{ background: BADGE[detalle.estado].bg, color: BADGE[detalle.estado].fg }}
            >
              {ETIQUETA[detalle.estado]}
            </span>
          </p>
          <table className="mb-3 w-full text-[13px]">
            <tbody>
              <tr>
                <td className="py-1 pr-3" style={{ color: "var(--muted-foreground)" }}>Emisión</td>
                <td>{fechaCorta(detalle.fecha_emision)}</td>
              </tr>
              <tr>
                <td className="py-1 pr-3" style={{ color: "var(--muted-foreground)" }}>Fecha de pago</td>
                <td>{fechaCorta(detalle.fecha_pago)}</td>
              </tr>
              {detalle.librador_nombre && (
                <tr>
                  <td className="py-1 pr-3" style={{ color: "var(--muted-foreground)" }}>Librador</td>
                  <td>{detalle.librador_nombre}</td>
                </tr>
              )}
              {detalle.clientes && (
                <tr>
                  <td className="py-1 pr-3" style={{ color: "var(--muted-foreground)" }}>Recibido de</td>
                  <td>{detalle.clientes.nombre}</td>
                </tr>
              )}
              {detalle.cuenta_bancaria && (
                <tr>
                  <td className="py-1 pr-3" style={{ color: "var(--muted-foreground)" }}>Cuenta</td>
                  <td>{detalle.cuenta_bancaria}</td>
                </tr>
              )}
              {detalle.entregado_a && (
                <tr>
                  <td className="py-1 pr-3" style={{ color: "var(--muted-foreground)" }}>Entregado a</td>
                  <td>{detalle.entregado_a}</td>
                </tr>
              )}
              {detalle.nota && (
                <tr>
                  <td className="py-1 pr-3" style={{ color: "var(--muted-foreground)" }}>Nota</td>
                  <td>{detalle.nota}</td>
                </tr>
              )}
            </tbody>
          </table>
          <h3 className="mb-1.5 text-[13px] font-semibold">Historial</h3>
          {historial === null ? (
            <div className="grid place-items-center py-4" style={{ color: "var(--muted-foreground)" }}>
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : (
            <table className="w-full text-[12.5px]">
              <tbody>
                {historial.map((m) => (
                  <tr key={m.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                    <td className="whitespace-nowrap py-1.5 pr-3">{fechaCorta(m.created_at)}</td>
                    <td className="py-1.5 pr-3">
                      <span
                        className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                        style={{
                          background: BADGE[m.a_estado]?.bg ?? "#eef1f5",
                          color: BADGE[m.a_estado]?.fg ?? "#667085",
                        }}
                      >
                        {ETIQUETA[m.a_estado] ?? m.a_estado}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3" style={{ color: "var(--muted-foreground)" }}>
                      {m.usuarios?.nombre ?? ""}
                      {m.sucursales?.alias ? ` · ${m.sucursales.alias}` : ""}
                    </td>
                    <td className="py-1.5" style={{ color: "var(--muted-foreground)" }}>
                      {m.nota ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </>
  );
}
