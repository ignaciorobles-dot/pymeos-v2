import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Ban, Camera, Loader2, Plus, Trash2, UserPlus, Wallet } from "lucide-react";
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
import { DialogoProveedor } from "@/components/ui-bits/DialogoProveedor";
import { useSesion, useSucursalOperativa, type Sucursal } from "@/lib/sesion";
import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";

export const Route = createFileRoute("/compras")({
  head: () => ({
    meta: [
      { title: "Compras — PymeOS" },
      {
        name: "description",
        content: "Compras a proveedores: entra la mercadería al stock y queda la deuda.",
      },
    ],
  }),
  component: Compras,
});

type Proveedor = {
  id: string;
  nombre: string;
  cuit: string | null;
  condicion_iva: string;
  telefono: string | null;
  saldo: number;
  activo: boolean;
};

type Compra = {
  id: string;
  numero: number;
  fecha: string;
  total: number;
  estado: string;
  tipo_comprobante: string;
  punto_venta: string | null;
  numero_comprobante: string | null;
  motivo_anulacion: string | null;
  proveedor: { nombre: string } | null;
  sucursal: { nombre: string } | null;
  compra_lineas: { cantidad: number }[];
};

type MedioPago = { id: string; nombre: string; es_cuenta_corriente: boolean; orden: number };

type Variante = {
  id: string;
  talle: string | null;
  color: string | null;
  sku: string | null;
  codigo_barras: string | null;
  costo: number | null;
  activa: boolean;
};

type Producto = { id: string; nombre: string; marca: string | null; variantes: Variante[] };

/** Una línea de la compra que se está cargando. */
type LineaCompra = {
  varianteId: string;
  etiqueta: string;
  detalle: string;
  cantidad: string;
  costo: string;
};

const COMPROBANTES: { valor: string; texto: string }[] = [
  { valor: "factura_a", texto: "Factura A" },
  { valor: "factura_b", texto: "Factura B" },
  { valor: "factura_c", texto: "Factura C" },
  { valor: "remito", texto: "Remito" },
  { valor: "ticket", texto: "Ticket" },
  { valor: "otro", texto: "Otro" },
];

function hoyISO(): string {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(
    hoy.getDate(),
  ).padStart(2, "0")}`;
}

function fechaCorta(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a.slice(2)}`;
}

function aNumero(texto: string): number {
  const n = Number(texto.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function comprobanteDe(c: Compra): string {
  const nombre = COMPROBANTES.find((x) => x.valor === c.tipo_comprobante)?.texto ?? c.tipo_comprobante;
  if (!c.numero_comprobante) return nombre;
  return c.punto_venta ? `${nombre} ${c.punto_venta}-${c.numero_comprobante}` : `${nombre} ${c.numero_comprobante}`;
}

function Compras() {
  const { usuario, sucursalEquipo, verTodas } = useSesion();
  const sucursalOperativa = useSucursalOperativa();
  const esDueno = usuario?.rol === "dueno";
  const puedeEditarProveedores = esDueno || usuario?.rol === "contador";

  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [compras, setCompras] = useState<Compra[]>([]);
  const [medios, setMedios] = useState<MedioPago[]>([]);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  const [nuevoProveedor, setNuevoProveedor] = useState(false);
  const [pagando, setPagando] = useState<Proveedor | null>(null);
  const [anulando, setAnulando] = useState<Compra | null>(null);

  const cargar = useCallback(async () => {
    setErrorCarga(null);

    // Igual que en gastos: parado en una sucursal se ven las compras de esa
    // sucursal; en "ver las dos" se ven las de las dos, y ahí es solo mirar.
    let consulta = supa
      .from("compras")
      .select(
        "id, numero, fecha, total, estado, tipo_comprobante, punto_venta, numero_comprobante, " +
          "motivo_anulacion, proveedor:proveedores(nombre), sucursal:sucursales(nombre), " +
          "compra_lineas(cantidad)",
      )
      .order("fecha", { ascending: false })
      .order("numero", { ascending: false })
      .limit(60);

    if (sucursalOperativa) consulta = consulta.eq("sucursal_id", sucursalOperativa.id);

    const [prov, filas, mp, cat] = await Promise.all([
      supa
        .from("proveedores")
        .select("id, nombre, cuit, condicion_iva, telefono, saldo, activo")
        .order("nombre"),
      consulta,
      supa
        .from("medios_pago")
        .select("id, nombre, es_cuenta_corriente, orden")
        .eq("activo", true)
        .order("orden"),
      supa
        .from("productos")
        .select("id, nombre, marca, variantes ( id, talle, color, sku, codigo_barras, costo, activa )")
        .eq("activo", true)
        .order("nombre"),
    ]);

    const fallo = prov.error ?? filas.error ?? mp.error ?? cat.error;
    if (fallo) setErrorCarga(fallo.message);
    else {
      setProveedores((prov.data ?? []) as Proveedor[]);
      setCompras((filas.data ?? []) as unknown as Compra[]);
      setMedios((mp.data ?? []) as MedioPago[]);
      setProductos((cat.data ?? []) as unknown as Producto[]);
    }
    setCargando(false);
  }, [sucursalOperativa]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const activos = useMemo(() => proveedores.filter((p) => p.activo), [proveedores]);
  const deuda = useMemo(
    () => activos.reduce((s, p) => s + Math.max(0, Number(p.saldo)), 0),
    [activos],
  );

  const alcance = sucursalOperativa
    ? sucursalOperativa.nombre
    : verTodas
      ? "Las dos sucursales"
      : "Sin sucursal activa";

  return (
    <>
      <PageHeader
        title="Compras"
        subtitle={`${activos.length} proveedores · ${
          deuda > 0 ? `${formatARS(deuda)} de deuda` : "sin deuda"
        } · ${alcance}`}
        actions={
          puedeEditarProveedores ? (
            <button
              onClick={() => setNuevoProveedor(true)}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px]"
              style={inputStyle}
            >
              <UserPlus size={13} /> Nuevo proveedor
            </button>
          ) : null
        }
      />

      {errorCarga && (
        <div className="mb-3">
          <Alerta tono="danger">{errorCarga}</Alerta>
        </div>
      )}

      {!sucursalEquipo && (
        <div className="mb-3">
          <Alerta tono="warning">
            Este equipo todavía no tiene una sucursal activa. La mercadería entra al depósito
            donde está parada la computadora: elegilo en Configuración.
          </Alerta>
        </div>
      )}

      <div className="grid grid-cols-[280px_1fr] gap-3">
        <div className="card-surface p-4">
          <div className="text-[14px] font-semibold">Proveedores</div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Lo que dice cada uno es lo que se le debe hoy.
          </div>

          <div className="mt-3 space-y-2">
            {activos.map((p) => (
              <button
                key={p.id}
                onClick={() => setPagando(p)}
                disabled={!puedeEditarProveedores}
                className="flex w-full items-center justify-between rounded-md p-2 text-left text-[13px] disabled:cursor-default"
                style={{ background: "#f9fafc" }}
              >
                <span className="truncate pr-2">{p.nombre}</span>
                <span
                  className="shrink-0 text-[11px] tabular"
                  style={{
                    color: Number(p.saldo) > 0 ? "var(--warning)" : "var(--muted-foreground)",
                  }}
                >
                  {Number(p.saldo) > 0 ? formatARS(Number(p.saldo)) : "al día"}
                </span>
              </button>
            ))}
            {!cargando && activos.length === 0 && (
              <p className="py-3 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                Todavía no hay proveedores cargados.
              </p>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <PanelCargarCompra
            sucursal={sucursalOperativa}
            proveedores={activos}
            medios={medios}
            productos={productos}
            onGuardado={cargar}
          />

          <div className="card-surface overflow-hidden">
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              <div className="text-[14px] font-semibold">Compras recientes</div>
              <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                {alcance}
              </div>
            </div>

            {cargando ? (
              <div
                className="flex items-center gap-2 px-4 py-6 text-[13px]"
                style={{ color: "var(--muted-foreground)" }}
              >
                <Loader2 size={14} className="animate-spin" /> Buscando las compras…
              </div>
            ) : compras.length === 0 ? (
              <div className="px-4 py-6 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                Todavía no se cargó ninguna compra.
              </div>
            ) : (
              <table className="w-full text-[13px]">
                <thead style={{ background: "#f9fafc" }}>
                  <tr style={{ color: "var(--muted-foreground)" }}>
                    <th className="px-4 py-2 text-left font-medium">Compra</th>
                    <th className="px-4 py-2 text-left font-medium">Proveedor</th>
                    <th className="px-4 py-2 text-left font-medium">Comprobante</th>
                    <th className="px-4 py-2 text-left font-medium">Fecha</th>
                    <th className="px-4 py-2 text-right font-medium">Pares</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                    {esDueno && <th className="px-4 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {compras.map((c) => {
                    const anulada = c.estado === "anulada";
                    const pares = c.compra_lineas.reduce((s, l) => s + l.cantidad, 0);
                    return (
                      <tr
                        key={c.id}
                        style={{
                          borderTop: "1px solid var(--border)",
                          opacity: anulada ? 0.5 : 1,
                        }}
                      >
                        <td className="px-4 py-2 tabular font-medium">#{c.numero}</td>
                        <td className="px-4 py-2">
                          {c.proveedor?.nombre ?? "—"}
                          {anulada && (
                            <span
                              className="ml-2 text-[11px]"
                              style={{ color: "var(--muted-foreground)" }}
                            >
                              anulada · {c.motivo_anulacion ?? ""}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <Chip tone="neutral">{comprobanteDe(c)}</Chip>
                        </td>
                        <td
                          className="px-4 py-2 tabular"
                          style={{ color: "var(--muted-foreground)" }}
                        >
                          {fechaCorta(c.fecha)}
                        </td>
                        <td className="px-4 py-2 text-right tabular">{pares}</td>
                        <td
                          className="px-4 py-2 text-right tabular font-medium"
                          style={anulada ? { textDecoration: "line-through" } : undefined}
                        >
                          {formatARS(Number(c.total))}
                        </td>
                        {esDueno && (
                          <td className="px-4 py-2 text-right">
                            {!anulada && (
                              <button
                                onClick={() => setAnulando(c)}
                                className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]"
                                style={inputStyle}
                              >
                                <Ban size={11} /> Anular
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {nuevoProveedor && (
        <DialogoProveedor
          onCerrar={() => setNuevoProveedor(false)}
          onListo={async () => {
            setNuevoProveedor(false);
            await cargar();
          }}
        />
      )}

      {pagando && (
        <DialogoPago
          proveedor={pagando}
          sucursal={sucursalOperativa}
          medios={medios}
          onCerrar={() => setPagando(null)}
          onListo={async () => {
            setPagando(null);
            await cargar();
          }}
        />
      )}

      {anulando && (
        <DialogoAnular
          compra={anulando}
          onCerrar={() => setAnulando(null)}
          onListo={async () => {
            setAnulando(null);
            await cargar();
          }}
        />
      )}
    </>
  );
}

/**
 * La carga de la compra. No tiene selector de sucursal a propósito: la
 * mercadería entra al depósito donde está parado el equipo.
 *
 * Lo que se paga acá se paga; lo que no, queda como deuda con el proveedor. Por
 * eso no hay una opción "cuenta corriente": no pagar ya es eso.
 */
function PanelCargarCompra({
  sucursal,
  proveedores,
  medios,
  productos,
  onGuardado,
}: {
  sucursal: Sucursal | null;
  proveedores: Proveedor[];
  medios: MedioPago[];
  productos: Producto[];
  onGuardado: () => Promise<void>;
}) {
  const [proveedorId, setProveedorId] = useState("");
  const [tipo, setTipo] = useState("factura_a");
  const [puntoVenta, setPuntoVenta] = useState("");
  const [numero, setNumero] = useState("");
  const [fecha, setFecha] = useState(hoyISO);
  const [nota, setNota] = useState("");

  const [busqueda, setBusqueda] = useState("");
  const [lineas, setLineas] = useState<LineaCompra[]>([]);
  const [pagos, setPagos] = useState<{ medioId: string; monto: string }[]>([]);

  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState<number | null>(null);

  // Cuenta corriente no es una forma de pagar: es no pagar, y eso ya lo hace
  // solo lo que se deja sin cubrir.
  const mediosContado = useMemo(() => medios.filter((m) => !m.es_cuenta_corriente), [medios]);

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

  const total = useMemo(
    () => lineas.reduce((s, l) => s + aNumero(l.cantidad) * aNumero(l.costo), 0),
    [lineas],
  );
  const pagado = useMemo(() => pagos.reduce((s, p) => s + aNumero(p.monto), 0), [pagos]);
  const queda = total - pagado;

  function agregar(producto: Producto, variante: Variante) {
    setBusqueda("");
    setLineas((ls) => {
      if (ls.some((l) => l.varianteId === variante.id)) return ls;
      return [
        ...ls,
        {
          varianteId: variante.id,
          etiqueta: producto.nombre,
          detalle: [variante.talle ? `T.${variante.talle}` : null, variante.color]
            .filter(Boolean)
            .join(" · "),
          cantidad: "1",
          costo: variante.costo != null ? String(variante.costo) : "",
        },
      ];
    });
  }

  function cambiar(varianteId: string, campo: "cantidad" | "costo", valor: string) {
    setLineas((ls) => ls.map((l) => (l.varianteId === varianteId ? { ...l, [campo]: valor } : l)));
  }

  function limpiar() {
    setLineas([]);
    setPagos([]);
    setNumero("");
    setNota("");
  }

  const problema = (): string | null => {
    if (!sucursal) return "Este equipo no tiene una sucursal activa.";
    if (!proveedorId) return "Falta elegir el proveedor.";
    if (lineas.length === 0) return "Una compra sin mercadería no es una compra.";
    if (lineas.some((l) => aNumero(l.cantidad) <= 0)) return "Hay una línea sin cantidad.";
    if (lineas.some((l) => l.costo.trim() === "")) return "Falta el costo de alguna línea.";
    if (pagos.some((p) => aNumero(p.monto) <= 0)) return "Hay un pago en cero.";
    if (pagado > total) return "Los pagos suman más que la compra.";
    return null;
  };

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    const falla = problema();
    if (falla) {
      setError(falla);
      return;
    }
    setEnviando(true);
    setError(null);
    setListo(null);

    const { data, error: err } = await supa.rpc("registrar_compra", {
      p_sucursal_id: sucursal!.id,
      p_proveedor_id: proveedorId,
      p_lineas: lineas.map((l) => ({
        variante_id: l.varianteId,
        cantidad: Math.round(aNumero(l.cantidad)),
        costo_unitario: aNumero(l.costo),
      })),
      p_pagos: pagos.map((p) => ({ medio_pago_id: p.medioId, monto: aNumero(p.monto) })),
      p_fecha: fecha,
      p_tipo_comprobante: tipo,
      p_punto_venta: puntoVenta || null,
      p_numero_comprobante: numero || null,
      p_nota: nota || null,
    });
    setEnviando(false);

    if (err) {
      setError(err.message);
      return;
    }
    limpiar();
    setListo(lineas.reduce((s, l) => s + Math.round(aNumero(l.cantidad)), 0));
    void data;
    await onGuardado();
  }

  return (
    <div className="card-surface p-5">
      <div className="text-[14px] font-semibold">Cargar compra</div>
      <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
        Entra la mercadería al depósito de {sucursal ? sucursal.nombre : "la sucursal del equipo"} y
        queda anotado lo que se le debe al proveedor.
      </div>

      {/* La lectura de la factura por foto todavía no existe. Antes había acá un
          botón que simulaba leerla: se sacó, porque un botón que finge trabajar
          es peor que uno que no está. */}
      <div
        className="mt-3 flex items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-[12px]"
        style={{ borderColor: "var(--border)", color: "var(--muted-foreground)" }}
      >
        <Camera size={16} />
        Leer la factura desde una foto es el paso que sigue en este módulo. Por ahora la compra se
        carga a mano, que es la vía que igual tiene que existir siempre.
      </div>

      {!sucursal ? (
        <div className="mt-3">
          <Alerta tono="warning">
            Para cargar una compra hay que estar parado en una sucursal. Si estás mirando las dos
            juntas, salí de ese modo: mirar todo junto sí, operar sobre «las dos» no existe.
          </Alerta>
        </div>
      ) : (
        <form onSubmit={(e) => void guardar(e)} className="mt-4 space-y-3 text-[13px]">
          <div className="grid grid-cols-[2fr_1fr_1fr] gap-2">
            <label
              className="block text-[12px] font-medium"
              style={{ color: "var(--muted-foreground)" }}
            >
              Proveedor
              <select
                value={proveedorId}
                onChange={(e) => setProveedorId(e.target.value)}
                required
                className={inputCls}
                style={inputStyle}
              >
                <option value="">Elegí uno</option>
                {proveedores.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </select>
            </label>
            <label
              className="block text-[12px] font-medium"
              style={{ color: "var(--muted-foreground)" }}
            >
              Comprobante
              <select
                value={tipo}
                onChange={(e) => setTipo(e.target.value)}
                className={inputCls}
                style={inputStyle}
              >
                {COMPROBANTES.map((c) => (
                  <option key={c.valor} value={c.valor}>
                    {c.texto}
                  </option>
                ))}
              </select>
            </label>
            <label
              className="block text-[12px] font-medium"
              style={{ color: "var(--muted-foreground)" }}
            >
              Fecha
              <input
                type="date"
                value={fecha}
                max={hoyISO()}
                onChange={(e) => setFecha(e.target.value)}
                required
                className={inputCls}
                style={inputStyle}
              />
            </label>
          </div>

          <div className="grid grid-cols-[1fr_2fr_3fr] gap-2">
            <label
              className="block text-[12px] font-medium"
              style={{ color: "var(--muted-foreground)" }}
            >
              Punto de venta
              <input
                value={puntoVenta}
                onChange={(e) => setPuntoVenta(e.target.value)}
                placeholder="0001"
                className={`${inputCls} tabular`}
                style={inputStyle}
              />
            </label>
            <label
              className="block text-[12px] font-medium"
              style={{ color: "var(--muted-foreground)" }}
            >
              Número
              <input
                value={numero}
                onChange={(e) => setNumero(e.target.value)}
                placeholder="00012345"
                className={`${inputCls} tabular`}
                style={inputStyle}
              />
            </label>
            <label
              className="block text-[12px] font-medium"
              style={{ color: "var(--muted-foreground)" }}
            >
              Nota
              <input
                value={nota}
                onChange={(e) => setNota(e.target.value)}
                placeholder="Opcional"
                className={inputCls}
                style={inputStyle}
              />
            </label>
          </div>

          <div>
            <div className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
              Mercadería
            </div>
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar producto por nombre, código o talle…"
              className={inputCls}
              style={inputStyle}
            />
            {resultados.length > 0 && (
              <div
                className="mt-1 max-h-48 overflow-y-auto rounded-md border"
                style={{ borderColor: "var(--border)" }}
              >
                {resultados.map(({ producto, variante }) => (
                  <button
                    key={variante.id}
                    type="button"
                    onClick={() => agregar(producto, variante)}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px]"
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <span className="truncate">
                      {producto.nombre}
                      <span className="ml-2 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                        {[variante.talle ? `T.${variante.talle}` : null, variante.color]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <Plus size={13} />
                  </button>
                ))}
              </div>
            )}
          </div>

          {lineas.length > 0 && (
            <table className="w-full text-[13px]">
              <thead style={{ color: "var(--muted-foreground)" }}>
                <tr>
                  <th className="py-1 text-left font-medium">Producto</th>
                  <th className="w-20 py-1 text-right font-medium">Cant.</th>
                  <th className="w-32 py-1 text-right font-medium">Costo unit.</th>
                  <th className="w-28 py-1 text-right font-medium">Subtotal</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {lineas.map((l) => (
                  <tr key={l.varianteId} style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="py-2">
                      {l.etiqueta}
                      <span className="ml-2 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                        {l.detalle}
                      </span>
                    </td>
                    <td className="py-1 text-right">
                      <input
                        value={l.cantidad}
                        onChange={(e) => cambiar(l.varianteId, "cantidad", e.target.value)}
                        inputMode="numeric"
                        className="h-8 w-16 rounded-md border px-2 text-right text-[13px] tabular outline-none"
                        style={inputStyle}
                      />
                    </td>
                    <td className="py-1 text-right">
                      <input
                        value={l.costo}
                        onChange={(e) => cambiar(l.varianteId, "costo", e.target.value)}
                        inputMode="decimal"
                        placeholder="0"
                        className="h-8 w-28 rounded-md border px-2 text-right text-[13px] tabular outline-none"
                        style={inputStyle}
                      />
                    </td>
                    <td className="py-2 text-right tabular font-medium">
                      {formatARS(aNumero(l.cantidad) * aNumero(l.costo))}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        aria-label="Sacar"
                        onClick={() =>
                          setLineas((ls) => ls.filter((x) => x.varianteId !== l.varianteId))
                        }
                        style={{ color: "var(--muted-foreground)" }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="border-t pt-3" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
                Cómo se paga
              </div>
              <button
                type="button"
                onClick={() =>
                  setPagos((p) =>
                    mediosContado.length === 0
                      ? p
                      : [...p, { medioId: mediosContado[0].id, monto: "" }],
                  )
                }
                className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]"
                style={inputStyle}
              >
                <Plus size={11} /> Agregar pago
              </button>
            </div>

            {pagos.length === 0 ? (
              <div className="mt-2 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                Sin pagos cargados, la compra entera queda como deuda con el proveedor. Es lo normal
                cuando se paga a 30 días.
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                {pagos.map((p, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <select
                      value={p.medioId}
                      onChange={(e) =>
                        setPagos((ps) =>
                          ps.map((x, j) => (i === j ? { ...x, medioId: e.target.value } : x)),
                        )
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
                        setPagos((ps) =>
                          ps.map((x, j) => (i === j ? { ...x, monto: e.target.value } : x)),
                        )
                      }
                      inputMode="decimal"
                      placeholder="0"
                      className="h-9 w-32 rounded-md border px-2 text-right text-[13px] tabular outline-none"
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      aria-label="Sacar pago"
                      onClick={() => setPagos((ps) => ps.filter((_, j) => j !== i))}
                      style={{ color: "var(--muted-foreground)" }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div
            className="flex items-center justify-between border-t pt-3"
            style={{ borderColor: "var(--border)" }}
          >
            <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              {queda > 0 ? `Queda debiendo ${formatARS(queda)}` : "Queda pagada"}
            </div>
            <div className="text-[18px] font-bold tabular">{formatARS(total)}</div>
          </div>

          {error && <Alerta tono="danger">{error}</Alerta>}
          {listo !== null && (
            <Alerta tono="info">Compra guardada. Entraron {listo} unidades al depósito.</Alerta>
          )}

          <div className="flex justify-end gap-2">
            <BotonSecundario onClick={limpiar}>Descartar</BotonSecundario>
            <BotonPrimario enviando={enviando} disabled={lineas.length === 0}>
              Confirmar e ingresar al stock
            </BotonPrimario>
          </div>
        </form>
      )}
    </div>
  );
}

/** Pagarle a un proveedor por fuera de una compra: baja la deuda y toca la caja. */
function DialogoPago({
  proveedor,
  sucursal,
  medios,
  onCerrar,
  onListo,
}: {
  proveedor: Proveedor;
  sucursal: Sucursal | null;
  medios: MedioPago[];
  onCerrar: () => void;
  onListo: () => Promise<void>;
}) {
  const mediosContado = medios.filter((m) => !m.es_cuenta_corriente);
  const [medioId, setMedioId] = useState(mediosContado[0]?.id ?? "");
  const [monto, setMonto] = useState("");
  const [nota, setNota] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pagar(e: React.FormEvent) {
    e.preventDefault();
    if (!sucursal) return;
    setEnviando(true);
    setError(null);

    const { error: err } = await supa.rpc("pagar_proveedor", {
      p_proveedor_id: proveedor.id,
      p_sucursal_id: sucursal.id,
      p_monto: aNumero(monto),
      p_medio_pago_id: medioId,
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
    <Modal titulo={`Pagarle a ${proveedor.nombre}`} onCerrar={onCerrar}>
      {!sucursal ? (
        <Alerta tono="warning">
          Un pago sale de una caja, y la caja es la del local donde está parado el equipo. Salí del
          modo «ver las dos» para poder pagar.
        </Alerta>
      ) : (
        <form onSubmit={(e) => void pagar(e)} className="space-y-3">
          <Alerta tono="info">
            {Number(proveedor.saldo) > 0
              ? `Hoy se le debe ${formatARS(Number(proveedor.saldo))}.`
              : "Hoy no se le debe nada. Un pago igual queda registrado y le deja saldo a favor."}
          </Alerta>

          <div className="grid grid-cols-2 gap-2">
            <label
              className="block text-[12px] font-medium"
              style={{ color: "var(--muted-foreground)" }}
            >
              Monto
              <input
                value={monto}
                onChange={(e) => setMonto(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                required
                autoFocus
                className={`${inputCls} tabular`}
                style={inputStyle}
              />
            </label>
            <label
              className="block text-[12px] font-medium"
              style={{ color: "var(--muted-foreground)" }}
            >
              Con qué
              <select
                value={medioId}
                onChange={(e) => setMedioId(e.target.value)}
                className={inputCls}
                style={inputStyle}
              >
                {mediosContado.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nombre}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label
            className="block text-[12px] font-medium"
            style={{ color: "var(--muted-foreground)" }}
          >
            Nota
            <input
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              placeholder="Opcional"
              className={inputCls}
              style={inputStyle}
            />
          </label>

          <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Si se paga en efectivo, la plata sale de la caja de {sucursal.nombre} y queda el
            movimiento. Para eso la caja tiene que estar abierta.
          </div>

          {error && <Alerta tono="danger">{error}</Alerta>}

          <div className="flex justify-end gap-2 pt-1">
            <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
            <BotonPrimario enviando={enviando} disabled={aNumero(monto) <= 0 || !medioId}>
              <Wallet size={13} /> Registrar pago
            </BotonPrimario>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Anular no borra: saca del depósito lo que había entrado y revierte la deuda. */
function DialogoAnular({
  compra,
  onCerrar,
  onListo,
}: {
  compra: Compra;
  onCerrar: () => void;
  onListo: () => Promise<void>;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function anular(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    const { error: err } = await supa.rpc("anular_compra", {
      p_compra_id: compra.id,
      p_motivo: motivo,
    });
    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    await onListo();
  }

  return (
    <Modal titulo={`Anular compra #${compra.numero}`} onCerrar={onCerrar}>
      <form onSubmit={(e) => void anular(e)}>
        <Alerta tono="warning">
          {compra.proveedor?.nombre ?? "Proveedor"} · {formatARS(Number(compra.total))}. La
          mercadería sale del depósito y la deuda vuelve atrás. Si algo de eso ya se vendió, la
          base no va a dejar anular: se corrige con un ajuste de stock.
        </Alerta>
        <label className="mt-3 block text-[12px]">
          Por qué se anula
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Se cargó dos veces"
            className={inputCls}
            style={inputStyle}
            autoFocus
            required
          />
        </label>
        {error && (
          <div className="mt-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando} disabled={!motivo.trim()}>
            Anular
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}
