import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { CamposFiscales, type DatosFiscales } from "@/components/clientes/CamposFiscales";
import { useSesion, useSucursalOperativa, type Sucursal } from "@/lib/sesion";
import { limpiarDocumento, validarFiscal } from "@/lib/fiscal";
import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";
import {
  ArrowLeftRight,
  Banknote,
  Check,
  CreditCard,
  Loader2,
  QrCode,
  ReceiptText,
  Search,
  Trash2,
  TriangleAlert,
  UserPlus,
  Wallet,
} from "lucide-react";

export const Route = createFileRoute("/ventas")({
  head: () => ({
    meta: [
      { title: "Ventas / POS — PymeOS" },
      { name: "description", content: "Punto de venta para atender clientes en el mostrador." },
    ],
  }),
  component: Ventas,
});

type FilaStock = { sucursal_id: string; cantidad: number };

type Variante = {
  id: string;
  talle: string | null;
  color: string | null;
  sku: string | null;
  codigo_barras: string | null;
  precio: number;
  activa: boolean;
  stock: FilaStock[];
};

type Producto = {
  id: string;
  nombre: string;
  marca: string | null;
  activo: boolean;
  variantes: Variante[];
};

type MedioPago = {
  id: string;
  nombre: string;
  recargo_porcentaje: number;
  es_cuenta_corriente: boolean;
  afecta_caja: boolean;
  orden: number;
};

type Cliente = { id: string; nombre: string; telefono: string | null; saldo: number };

/**
 * Una línea del carrito. `cantidad` negativa es mercadería que vuelve al local
 * en un cambio: el mismo comprobante saca un par y recibe otro.
 */
type LineaCarrito = {
  varianteId: string;
  etiqueta: string;
  detalle: string;
  precio: number;
  cantidad: number;
  stockActual: number;
};

type Pago = { medioId: string; monto: string };

const SELECT_CATALOGO =
  "id, nombre, marca, activo, " +
  "variantes ( id, talle, color, sku, codigo_barras, precio, activa, stock ( sucursal_id, cantidad ) )";

const ICONOS: Record<string, typeof Banknote> = {
  efectivo: Banknote,
  débito: CreditCard,
  debito: CreditCard,
  crédito: CreditCard,
  credito: CreditCard,
  transferencia: ArrowLeftRight,
  "mercado pago": QrCode,
};

function iconoDe(nombre: string) {
  return ICONOS[nombre.trim().toLowerCase()] ?? Wallet;
}

function cantidadEn(v: Variante, sucursalId: string) {
  return v.stock.find((s) => s.sucursal_id === sucursalId)?.cantidad ?? 0;
}

function aNumero(texto: string): number {
  const n = Number(texto.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/** Redondeo a dos decimales, el mismo que hace la base. */
function r2(n: number) {
  return Math.round(n * 100) / 100;
}

function Ventas() {
  const sucursalOperativa = useSucursalOperativa();
  const { usuario } = useSesion();
  const esDueno = usuario?.rol === "dueno";

  const [productos, setProductos] = useState<Producto[]>([]);
  const [medios, setMedios] = useState<MedioPago[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  const [busqueda, setBusqueda] = useState("");
  const [avisoEscaneo, setAvisoEscaneo] = useState<string | null>(null);
  const campoBusqueda = useRef<HTMLInputElement>(null);
  const [carrito, setCarrito] = useState<LineaCarrito[]>([]);
  const [descuento, setDescuento] = useState("");
  const [clienteId, setClienteId] = useState<string>("");
  const [pagos, setPagos] = useState<Pago[]>([]);
  const [dividido, setDividido] = useState(false);
  const [nota, setNota] = useState("");

  const [origen, setOrigen] = useState<{ id: string; numero: number } | null>(null);
  const [abrirCambio, setAbrirCambio] = useState(false);
  const [abrirCliente, setAbrirCliente] = useState(false);

  const [cobrando, setCobrando] = useState(false);
  const [errorCobro, setErrorCobro] = useState<string | null>(null);
  const [listo, setListo] = useState<{ numero: number; total: number } | null>(null);

  /**
   * La base rechaza un cobro en efectivo con la caja cerrada, y con razón. Pero
   * enterarse recién al apretar Cobrar, con el cliente enfrente y la mercadería
   * en el mostrador, es tarde: el aviso tiene que estar antes de armar el carrito.
   * `null` mientras no se sabe todavía.
   */
  const [cajaAbierta, setCajaAbierta] = useState<boolean | null>(null);
  const [abrirDia, setAbrirDia] = useState(false);

  const cargar = useCallback(async () => {
    const [cat, mp, cl] = await Promise.all([
      supa.from("productos").select(SELECT_CATALOGO).eq("activo", true).order("nombre"),
      supa
        .from("medios_pago")
        .select("id, nombre, recargo_porcentaje, es_cuenta_corriente, afecta_caja, orden")
        .eq("activo", true)
        .order("orden"),
      supa.from("clientes").select("id, nombre, telefono, saldo").eq("activo", true).order("nombre"),
    ]);

    const error = cat.error ?? mp.error ?? cl.error;
    if (error) setErrorCarga(error.message);
    else {
      setErrorCarga(null);
      setProductos((cat.data ?? []) as unknown as Producto[]);
      setMedios((mp.data ?? []) as MedioPago[]);
      setClientes((cl.data ?? []) as Cliente[]);
    }
    setCargando(false);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const mirarCaja = useCallback(async () => {
    if (!sucursalOperativa) {
      setCajaAbierta(null);
      return;
    }
    const { data, error } = await supa
      .from("turnos_caja")
      .select("id")
      .eq("sucursal_id", sucursalOperativa.id)
      .eq("estado", "abierto")
      .maybeSingle();
    // Si la consulta falla no se inventa un estado: sin dato no se muestra aviso
    // y la base sigue siendo la que decide.
    setCajaAbierta(error ? null : data !== null);
  }, [sucursalOperativa]);

  useEffect(() => {
    void mirarCaja();
  }, [mirarCaja]);

  // Un solo pago, con el medio por defecto, hasta que alguien lo divida.
  useEffect(() => {
    if (medios.length > 0 && pagos.length === 0) setPagos([{ medioId: medios[0].id, monto: "" }]);
  }, [medios, pagos.length]);

  const sucursalId = sucursalOperativa?.id ?? "";

  const resultados = useMemo(() => {
    const texto = busqueda.trim().toLowerCase();
    const filas = productos.flatMap((p) =>
      p.variantes
        .filter((v) => v.activa)
        .map((v) => ({ producto: p, variante: v })),
    );
    if (!texto) return filas.slice(0, 24);
    return filas
      .filter(({ producto, variante }) =>
        [producto.nombre, producto.marca, variante.talle, variante.color, variante.sku, variante.codigo_barras]
          .filter(Boolean)
          .some((c) => String(c).toLowerCase().includes(texto)),
      )
      .slice(0, 60);
  }, [productos, busqueda]);

  const subtotal = useMemo(() => carrito.reduce((s, l) => s + l.precio * l.cantidad, 0), [carrito]);
  const descuentoNum = Math.max(0, aNumero(descuento));
  const aCobrar = r2(subtotal - descuentoNum);

  const recargos = useMemo(
    () =>
      pagos.reduce((s, p) => {
        const medio = medios.find((m) => m.id === p.medioId);
        if (!medio) return s;
        return s + r2(aNumero(p.monto) * (medio.recargo_porcentaje / 100));
      }, 0),
    [pagos, medios],
  );

  const total = r2(aCobrar + recargos);
  const asignado = r2(pagos.reduce((s, p) => s + aNumero(p.monto), 0));
  const cliente = clientes.find((c) => c.id === clienteId) ?? null;
  const hayFiado = pagos.some((p) => medios.find((m) => m.id === p.medioId)?.es_cuenta_corriente);

  /** Efectivo: lo único que hoy entra al cajón, y por eso lo único que exige caja abierta. */
  const hayEfectivo = pagos.some((p) => {
    const medio = medios.find((m) => m.id === p.medioId);
    if (!medio?.afecta_caja) return false;
    return dividido ? aNumero(p.monto) !== 0 : true;
  });
  const trabadoPorCaja = hayEfectivo && cajaAbierta === false;

  /** Con un solo medio, el monto lo pone el sistema: nadie tipea el total a mano. */
  const montoDe = (p: Pago) => (dividido ? p.monto : String(aCobrar));

  const agregar = (producto: Producto, variante: Variante) => {
    setCarrito((c) => {
      const existente = c.find((l) => l.varianteId === variante.id && l.cantidad > 0);
      if (existente) {
        return c.map((l) => (l === existente ? { ...l, cantidad: l.cantidad + 1 } : l));
      }
      return [
        ...c,
        {
          varianteId: variante.id,
          etiqueta: producto.nombre,
          detalle: [variante.talle ? `T.${variante.talle}` : null, variante.color].filter(Boolean).join(" · "),
          precio: Number(variante.precio),
          cantidad: 1,
          stockActual: cantidadEn(variante, sucursalId),
        },
      ];
    });
  };

  /**
   * El código de barras se compara exacto: la pistola escribe el código entero
   * y de golpe. Lo demás va por "contiene", que es como busca una persona.
   */
  const porCodigo = (codigo: string) => {
    for (const producto of productos) {
      for (const variante of producto.variantes) {
        if (variante.activa && variante.codigo_barras?.trim().toLowerCase() === codigo) {
          return { producto, variante };
        }
      }
    }
    return null;
  };

  /** Vuelve el foco al buscador para que el próximo escaneo entre sin tocar nada. */
  const enfocarBusqueda = () => campoBusqueda.current?.focus();

  const escribir = (valor: string) => {
    setAvisoEscaneo(null);
    // Muchas pistolas no mandan Enter al final. Si lo tipeado ya es un código
    // completo, el producto entra solo y la caja queda limpia para el siguiente.
    const codigo = valor.trim().toLowerCase();
    if (codigo.length >= 6) {
      const hallado = porCodigo(codigo);
      if (hallado && sucursalOperativa) {
        agregar(hallado.producto, hallado.variante);
        setBusqueda("");
        return;
      }
    }
    setBusqueda(valor);
  };

  const confirmarBusqueda = () => {
    const texto = busqueda.trim();
    if (!texto || !sucursalOperativa) return;
    const hallado = porCodigo(texto.toLowerCase());
    if (hallado) {
      agregar(hallado.producto, hallado.variante);
      setBusqueda("");
      setAvisoEscaneo(null);
      return;
    }
    // Si quedó una sola fila, apretar Enter significa esa: obligar a mover el
    // mouse hasta el único resultado visible sería trabajo de más.
    if (resultados.length === 1) {
      agregar(resultados[0].producto, resultados[0].variante);
      setBusqueda("");
      setAvisoEscaneo(null);
      return;
    }
    if (resultados.length === 0) {
      setAvisoEscaneo(
        `No hay ningún producto con el código ${texto}. Puede que no esté cargado o que la variante esté dada de baja.`,
      );
    }
  };

  const limpiar = () => {
    setCarrito([]);
    setDescuento("");
    setClienteId("");
    setNota("");
    setOrigen(null);
    setDividido(false);
    setPagos(medios.length > 0 ? [{ medioId: medios[0].id, monto: "" }] : []);
    setErrorCobro(null);
    setAvisoEscaneo(null);
    // Cerrada una venta, la siguiente empieza escaneando: el foco vuelve solo.
    enfocarBusqueda();
  };

  const problema = (): string | null => {
    if (!sucursalOperativa) return "Este equipo no tiene una sucursal activa.";
    if (carrito.length === 0) return "El carrito está vacío.";
    if (descuentoNum > subtotal) return "El descuento no puede ser mayor que la venta.";
    if (pagos.length === 0) return "Falta elegir cómo se paga.";
    if (dividido && asignado !== aCobrar) {
      return `Los pagos suman ${formatARS(asignado)} y hay que cobrar ${formatARS(aCobrar)}.`;
    }
    if (hayFiado && !clienteId) return "Para fiar hay que elegir el cliente.";
    if (trabadoPorCaja) {
      return "La caja está cerrada: no se puede cobrar en efectivo hasta abrirla.";
    }
    return null;
  };

  const cobrar = async () => {
    const falla = problema();
    if (falla) {
      setErrorCobro(falla);
      return;
    }
    setCobrando(true);
    setErrorCobro(null);

    const { data, error } = await supa.rpc("registrar_venta", {
      p_sucursal_id: sucursalId,
      p_lineas: carrito.map((l) => ({ variante_id: l.varianteId, cantidad: l.cantidad })),
      p_pagos: pagos
        .map((p) => ({ medio_pago_id: p.medioId, monto: aNumero(montoDe(p)) }))
        .filter((p) => p.monto !== 0),
      p_cliente_id: clienteId || null,
      p_descuento: descuentoNum,
      p_nota: nota.trim() || null,
      p_venta_origen_id: origen?.id ?? null,
    });

    if (error) {
      setErrorCobro(error.message);
      setCobrando(false);
      return;
    }

    const { data: venta } = await supa.from("ventas").select("numero, total").eq("id", data as string).single();
    setListo({ numero: venta?.numero ?? 0, total: Number(venta?.total ?? total) });
    setCobrando(false);
    limpiar();
    void cargar();
  };

  if (cargando) {
    return (
      <>
        <PageHeader title="Ventas / POS" subtitle="Cargando el catálogo…" />
        <div className="card-surface grid place-items-center py-16">
          <Loader2 size={20} className="animate-spin" style={{ color: "var(--muted-foreground)" }} />
        </div>
      </>
    );
  }

  if (errorCarga) {
    return (
      <>
        <PageHeader title="Ventas / POS" />
        <Alerta tono="danger">No se pudo leer el catálogo: {errorCarga}</Alerta>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Ventas / POS"
        subtitle={
          origen
            ? `Cambio contra el ticket #${origen.numero}`
            : sucursalOperativa
              ? `Nueva venta · ${sucursalOperativa.alias}`
              : "Sin sucursal activa"
        }
        actions={
          sucursalOperativa ? (
            <button
              onClick={() => setAbrirDia(true)}
              className="flex h-9 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium"
              style={{ borderColor: "var(--border)", background: "var(--surface)" }}
            >
              <ReceiptText size={14} /> Ventas del día
            </button>
          ) : undefined
        }
      />

      {/* Antes del carrito, no después: enterarse al cobrar es enterarse tarde. */}
      {sucursalOperativa && cajaAbierta === false && (
        <div className="mb-3">
          <Alerta tono="warning">
            La caja de {sucursalOperativa.alias} está cerrada. Se puede cobrar con tarjeta,
            transferencia o cuenta corriente, pero <strong>no en efectivo</strong>: la plata no
            tendría dónde entrar y el arqueo del día quedaría mal. Abrila en Caja.
          </Alerta>
        </div>
      )}

      {!sucursalOperativa && (
        <div className="mb-3">
          <Alerta tono="warning">
            Estás mirando las dos sucursales juntas, o esta computadora no tiene ninguna activa. No
            se puede vender así: una venta siempre se guarda en la sucursal del equipo. Configurala
            en Configuración y volvé.
          </Alerta>
        </div>
      )}

      {listo && (
        <div className="mb-3">
          <Alerta tono="info">
            <span className="inline-flex items-center gap-2">
              <Check size={14} />
              Ticket #{listo.numero} guardado por {formatARS(listo.total)}.
            </span>
          </Alerta>
        </div>
      )}

      <div className="grid grid-cols-[1fr_400px] gap-3" style={{ height: "calc(100vh - 168px)" }}>
        {/* Buscador + grilla */}
        <div className="card-surface flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 p-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--muted-foreground)" }} />
              <input
                autoFocus
                ref={campoBusqueda}
                value={busqueda}
                onChange={(e) => escribir(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    confirmarBusqueda();
                  }
                }}
                placeholder="Escaneá el código de barras o buscá por nombre, marca, talle o SKU…"
                className="h-11 w-full rounded-md border pl-10 pr-3 text-[14px] outline-none"
                style={{ borderColor: "var(--border)" }}
              />
            </div>
            <button
              onClick={() => setAbrirCambio(true)}
              disabled={!sucursalOperativa}
              className="flex h-11 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium disabled:opacity-40"
              style={{ borderColor: "var(--border)" }}
              title="Recibir un producto de una venta anterior"
            >
              <ArrowLeftRight size={14} /> Cambio
            </button>
          </div>

          {avisoEscaneo && (
            <div
              className="flex items-start gap-2 px-3 py-2 text-[12px]"
              style={{ background: "var(--warning-bg)", color: "var(--warning)" }}
            >
              <TriangleAlert size={14} className="mt-px shrink-0" />
              <span>{avisoEscaneo}</span>
            </div>
          )}

          {productos.length === 0 ? (
            <div className="grid flex-1 place-items-center p-6 text-center">
              <div className="max-w-sm">
                <div className="text-[14px] font-semibold">Todavía no hay productos cargados</div>
                <p className="mt-1 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                  No se puede vender lo que el sistema no conoce. Cargá los modelos en Stock y
                  después las cantidades con el conteo físico.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 overflow-y-auto p-3">
              {resultados.map(({ producto, variante }) => {
                const stock = sucursalId ? cantidadEn(variante, sucursalId) : variante.stock.reduce((s, f) => s + f.cantidad, 0);
                return (
                  <button
                    key={variante.id}
                    onClick={() => {
                      agregar(producto, variante);
                      enfocarBusqueda();
                    }}
                    disabled={!sucursalOperativa}
                    className="card-surface flex flex-col gap-1 p-2.5 text-left transition-colors hover:border-[var(--primary)] disabled:opacity-40"
                  >
                    <div className="truncate text-[13px] font-medium">{producto.nombre}</div>
                    <div className="truncate text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                      {producto.marca ? `${producto.marca} · ` : ""}
                      {[variante.talle ? `T.${variante.talle}` : null, variante.color].filter(Boolean).join(" · ") || "sin variante"}
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <div className="text-[13px] font-semibold tabular">{formatARS(Number(variante.precio))}</div>
                      <div
                        className="text-[11px] tabular"
                        style={{ color: stock < 0 ? "var(--danger)" : stock <= 3 ? "var(--warning)" : "var(--muted-foreground)" }}
                      >
                        {stock} u.
                      </div>
                    </div>
                  </button>
                );
              })}
              {resultados.length === 0 && (
                <div className="col-span-3 py-10 text-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                  Nada coincide con “{busqueda}”.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Carrito */}
        <div className="card-surface flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="text-[14px] font-semibold">Carrito</div>
            <button
              onClick={() => setAbrirCliente(true)}
              className="flex items-center gap-1 text-[12px] font-medium"
              style={{ color: "var(--primary)" }}
            >
              <UserPlus size={13} /> Cliente nuevo
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {carrito.length === 0 ? (
              <div className="grid h-full place-items-center text-center">
                <div>
                  <div className="text-[13px] font-medium">Carrito vacío</div>
                  <div className="mt-1 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                    Buscá un producto para empezar.
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {carrito.map((l, i) => {
                  const vuelve = l.cantidad < 0;
                  return (
                    <div
                      key={`${l.varianteId}-${i}`}
                      className="flex items-center gap-2 rounded-md p-2"
                      style={{ background: vuelve ? "var(--violet-bg)" : "#f9fafc" }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium">{l.etiqueta}</div>
                        <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                          {l.detalle} · {formatARS(l.precio)} c/u
                          {vuelve && " · vuelve al local"}
                        </div>
                      </div>
                      {!vuelve && (
                        <div className="flex items-center rounded-md border" style={{ borderColor: "var(--border)" }}>
                          <button
                            onClick={() =>
                              setCarrito((c) => c.map((x, j) => (j === i ? { ...x, cantidad: Math.max(1, x.cantidad - 1) } : x)))
                            }
                            className="px-2 py-0.5"
                          >
                            −
                          </button>
                          <span className="min-w-[24px] text-center text-[13px] tabular">{l.cantidad}</span>
                          <button
                            onClick={() => setCarrito((c) => c.map((x, j) => (j === i ? { ...x, cantidad: x.cantidad + 1 } : x)))}
                            className="px-2 py-0.5"
                          >
                            +
                          </button>
                        </div>
                      )}
                      {vuelve && <span className="text-[13px] tabular">{l.cantidad}</span>}
                      <div className="w-24 text-right text-[13px] font-semibold tabular">
                        {formatARS(l.precio * l.cantidad)}
                      </div>
                      <button onClick={() => setCarrito((c) => c.filter((_, j) => j !== i))} style={{ color: "var(--danger)" }}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}

                {carrito.some((l) => l.cantidad > 0 && l.cantidad > l.stockActual) && (
                  <div className="flex items-start gap-1.5 rounded-md p-2 text-[11px]" style={{ background: "var(--warning-bg)", color: "var(--warning)" }}>
                    <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                    <span>
                      Estás vendiendo más de lo que dice el sistema. Si el producto está en el local,
                      vendé igual: el stock queda en negativo y después se cuenta.
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
            {/* Cliente */}
            <div className="mb-2">
              <select
                value={clienteId}
                onChange={(e) => setClienteId(e.target.value)}
                className="h-9 w-full rounded-md border px-2 text-[13px] outline-none"
                style={inputStyle}
              >
                <option value="">Sin cliente (venta de mostrador)</option>
                {clientes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                    {c.saldo > 0 ? ` — debe ${formatARS(c.saldo)}` : c.saldo < 0 ? ` — a favor ${formatARS(-c.saldo)}` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1 text-[13px]">
              <div className="flex justify-between">
                <span style={{ color: "var(--muted-foreground)" }}>Subtotal</span>
                <span className="tabular">{formatARS(subtotal)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span style={{ color: "var(--muted-foreground)" }}>Descuento</span>
                <input
                  value={descuento}
                  onChange={(e) => setDescuento(e.target.value)}
                  inputMode="decimal"
                  placeholder="0"
                  className="h-7 w-28 rounded-md border px-2 text-right text-[13px] tabular outline-none"
                  style={inputStyle}
                />
              </div>
              {recargos > 0 && (
                <div className="flex justify-between">
                  <span style={{ color: "var(--muted-foreground)" }}>Recargo</span>
                  <span className="tabular">{formatARS(recargos)}</span>
                </div>
              )}
              <div className="mt-2 flex items-baseline justify-between border-t pt-2" style={{ borderColor: "var(--border)" }}>
                <span className="text-[13px] font-medium">Total</span>
                <span className="text-[24px] font-bold tabular">{formatARS(total)}</span>
              </div>
            </div>

            {/* Medios de pago: salen de la base, el recargo también. */}
            {!dividido ? (
              <div className="mt-3 grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(medios.length, 5)}, minmax(0, 1fr))` }}>
                {medios.map((m) => {
                  const Icono = iconoDe(m.nombre);
                  const elegido = pagos[0]?.medioId === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => setPagos([{ medioId: m.id, monto: "" }])}
                      className="flex flex-col items-center gap-1 rounded-md border py-2 text-[11px] font-medium"
                      style={{
                        borderColor: elegido ? "var(--primary)" : "var(--border)",
                        background: elegido ? "#fdf3ef" : "var(--surface)",
                        color: elegido ? "var(--primary)" : "var(--foreground)",
                      }}
                      title={m.recargo_porcentaje > 0 ? `Recarga ${m.recargo_porcentaje}%` : undefined}
                    >
                      <Icono size={14} />
                      <span className="max-w-full truncate px-1">{m.nombre}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-3 space-y-1.5">
                {pagos.map((p, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <select
                      value={p.medioId}
                      onChange={(e) => setPagos((ps) => ps.map((x, j) => (j === i ? { ...x, medioId: e.target.value } : x)))}
                      className="h-9 flex-1 rounded-md border px-2 text-[13px] outline-none"
                      style={inputStyle}
                    >
                      {medios.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.nombre}
                          {m.recargo_porcentaje > 0 ? ` (+${m.recargo_porcentaje}%)` : ""}
                        </option>
                      ))}
                    </select>
                    <input
                      value={p.monto}
                      onChange={(e) => setPagos((ps) => ps.map((x, j) => (j === i ? { ...x, monto: e.target.value } : x)))}
                      inputMode="decimal"
                      placeholder="0"
                      className="h-9 w-28 rounded-md border px-2 text-right text-[13px] tabular outline-none"
                      style={inputStyle}
                    />
                    {pagos.length > 1 && (
                      <button onClick={() => setPagos((ps) => ps.filter((_, j) => j !== i))} style={{ color: "var(--danger)" }}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
                <div className="flex items-center justify-between text-[11px]">
                  <button onClick={() => setPagos((ps) => [...ps, { medioId: medios[0].id, monto: "" }])} style={{ color: "var(--primary)" }}>
                    + Otro medio
                  </button>
                  <span className="tabular" style={{ color: asignado === aCobrar ? "var(--muted-foreground)" : "var(--danger)" }}>
                    {formatARS(asignado)} de {formatARS(aCobrar)}
                  </span>
                </div>
              </div>
            )}

            <button
              onClick={() => {
                setDividido((d) => !d);
                setPagos([{ medioId: pagos[0]?.medioId ?? medios[0]?.id, monto: dividido ? "" : String(aCobrar) }]);
              }}
              className="mt-1.5 text-[11px]"
              style={{ color: "var(--muted-foreground)" }}
            >
              {dividido ? "Volver a un solo medio de pago" : "Dividir el pago entre varios medios"}
            </button>

            {hayFiado && !clienteId && (
              <p className="mt-2 text-[11px]" style={{ color: "var(--danger)" }}>
                Para fiar hay que elegir el cliente. Fiarle a nadie es perder la mercadería.
              </p>
            )}

            {errorCobro && (
              <p className="mt-2 text-[11px]" style={{ color: "var(--danger)" }}>
                {errorCobro}
              </p>
            )}

            <button
              onClick={() => void cobrar()}
              disabled={cobrando || problema() !== null}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-md py-3 text-[15px] font-semibold text-white disabled:opacity-40"
              style={{ background: "var(--primary)" }}
            >
              {cobrando ? <Loader2 size={16} className="animate-spin" /> : <Wallet size={16} />}
              {total < 0 ? `Devolver ${formatARS(-total)}` : `Cobrar ${formatARS(total)}`}
            </button>

            {carrito.length > 0 && (
              <button onClick={limpiar} className="mt-1.5 w-full text-center text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                Cancelar la venta
              </button>
            )}
          </div>
        </div>
      </div>

      {abrirCambio && sucursalOperativa && (
        <DialogoCambio
          sucursal={sucursalOperativa}
          onCerrar={() => setAbrirCambio(false)}
          onElegir={(venta, lineas) => {
            setOrigen({ id: venta.id, numero: venta.numero });
            setCarrito((c) => [...c, ...lineas]);
            setAbrirCambio(false);
          }}
        />
      )}

      {abrirDia && sucursalOperativa && (
        <DialogoVentasDelDia
          sucursal={sucursalOperativa}
          esDueno={esDueno}
          onCerrar={() => setAbrirDia(false)}
          onAnulada={() => {
            // Anular devuelve stock y puede tocar la caja: las dos cosas que esta
            // pantalla muestra. Se releen las dos, no una.
            void cargar();
            void mirarCaja();
          }}
        />
      )}

      {abrirCliente && (
        <DialogoCliente
          condicionEmisor={sucursalOperativa?.condicion_iva ?? null}
          onCerrar={() => setAbrirCliente(false)}
          onCreado={(nuevo) => {
            setClientes((cs) => [...cs, nuevo].sort((a, b) => a.nombre.localeCompare(b.nombre, "es")));
            setClienteId(nuevo.id);
            setAbrirCliente(false);
          }}
        />
      )}
    </>
  );
}

/* ─────────────────────────── Cambio contra un ticket ─────────────────────────── */

type LineaOriginal = {
  variante_id: string;
  cantidad: number;
  precio_unitario: number;
  variantes: { talle: string | null; color: string | null; productos: { nombre: string } | null } | null;
};

type VentaOriginal = { id: string; numero: number; created_at: string; estado: string; venta_lineas: LineaOriginal[] };

function DialogoCambio({
  sucursal,
  onCerrar,
  onElegir,
}: {
  sucursal: Sucursal;
  onCerrar: () => void;
  onElegir: (venta: VentaOriginal, lineas: LineaCarrito[]) => void;
}) {
  const [numero, setNumero] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [venta, setVenta] = useState<VentaOriginal | null>(null);
  /** Cuánto de cada variante ya volvió en cambios anteriores contra este mismo ticket. */
  const [devuelto, setDevuelto] = useState<Record<string, number>>({});
  const [elegidas, setElegidas] = useState<Record<string, number>>({});

  const buscar = async () => {
    const n = Number(numero);
    if (!Number.isInteger(n) || n <= 0) {
      setError("Poné el número de ticket.");
      return;
    }
    setBuscando(true);
    setError(null);
    setVenta(null);

    const { data, error: err } = await supa
      .from("ventas")
      .select(
        "id, numero, created_at, estado, venta_lineas ( variante_id, cantidad, precio_unitario, variantes ( talle, color, productos ( nombre ) ) )",
      )
      .eq("sucursal_id", sucursal.id)
      .eq("numero", n)
      .maybeSingle();

    if (err) {
      setError(err.message);
      setBuscando(false);
      return;
    }
    if (!data) {
      setError(`No hay ningún ticket #${n} en ${sucursal.alias}.`);
      setBuscando(false);
      return;
    }
    const v = data as unknown as VentaOriginal;
    if (v.estado !== "completada") {
      setError(`El ticket #${n} está anulado. No se puede cambiar contra una venta anulada.`);
      setBuscando(false);
      return;
    }

    // Lo que ya volvió: la base lo va a rechazar igual, pero es mejor no ofrecerlo.
    const { data: cambios } = await supa
      .from("ventas")
      .select("venta_lineas ( variante_id, cantidad )")
      .eq("venta_origen_id", v.id)
      .eq("estado", "completada");

    const yaVuelto: Record<string, number> = {};
    for (const c of (cambios ?? []) as unknown as { venta_lineas: { variante_id: string; cantidad: number }[] }[]) {
      for (const l of c.venta_lineas) {
        if (l.cantidad < 0) yaVuelto[l.variante_id] = (yaVuelto[l.variante_id] ?? 0) - l.cantidad;
      }
    }

    setDevuelto(yaVuelto);
    setVenta(v);
    setElegidas({});
    setBuscando(false);
  };

  const disponibles = (venta?.venta_lineas ?? [])
    .filter((l) => l.cantidad > 0)
    .map((l) => ({ ...l, resta: l.cantidad - (devuelto[l.variante_id] ?? 0) }))
    .filter((l) => l.resta > 0);

  const confirmar = () => {
    if (!venta) return;
    const lineas: LineaCarrito[] = disponibles
      .filter((l) => (elegidas[l.variante_id] ?? 0) > 0)
      .map((l) => ({
        varianteId: l.variante_id,
        etiqueta: l.variantes?.productos?.nombre ?? "Producto",
        detalle: [l.variantes?.talle ? `T.${l.variantes.talle}` : null, l.variantes?.color].filter(Boolean).join(" · "),
        precio: Number(l.precio_unitario),
        cantidad: -(elegidas[l.variante_id] ?? 0),
        stockActual: 0,
      }));
    if (lineas.length === 0) {
      setError("Elegí al menos un producto que vuelva.");
      return;
    }
    onElegir(venta, lineas);
  };

  return (
    <Modal titulo="Cambio: recibir un producto de una venta anterior" onCerrar={onCerrar}>
      <p className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
        Un cambio es una sola venta: entra el par que vuelve y sale el nuevo. Se cobra la
        diferencia, no todo de nuevo. El producto vuelve al precio que tenía en ese ticket.
      </p>

      <div className="mt-3 flex items-end gap-2">
        <div className="flex-1">
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Número de ticket de {sucursal.alias}
          </label>
          <input
            autoFocus
            value={numero}
            onChange={(e) => setNumero(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void buscar()}
            inputMode="numeric"
            placeholder="Ej: 128"
            className={inputCls}
            style={inputStyle}
          />
        </div>
        <button
          type="button"
          onClick={() => void buscar()}
          disabled={buscando}
          className="h-9 rounded-md border px-3 text-[13px] disabled:opacity-50"
          style={inputStyle}
        >
          {buscando ? "Buscando…" : "Buscar"}
        </button>
      </div>

      {error && (
        <div className="mt-3">
          <Alerta tono="danger">{error}</Alerta>
        </div>
      )}

      {venta && (
        <div className="mt-3">
          <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Ticket #{venta.numero} del {new Date(venta.created_at).toLocaleDateString("es-AR")}
          </div>

          {disponibles.length === 0 ? (
            <div className="mt-2">
              <Alerta tono="warning">De este ticket ya volvió todo. No queda nada para recibir.</Alerta>
            </div>
          ) : (
            <div className="mt-2 space-y-1.5">
              {disponibles.map((l) => (
                <div key={l.variante_id} className="flex items-center gap-2 rounded-md p-2" style={{ background: "#f9fafc" }}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{l.variantes?.productos?.nombre ?? "Producto"}</div>
                    <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                      {[l.variantes?.talle ? `T.${l.variantes.talle}` : null, l.variantes?.color].filter(Boolean).join(" · ")} ·{" "}
                      {formatARS(Number(l.precio_unitario))} · quedan {l.resta} para cambiar
                    </div>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={l.resta}
                    value={elegidas[l.variante_id] ?? 0}
                    onChange={(e) =>
                      setElegidas((x) => ({
                        ...x,
                        [l.variante_id]: Math.max(0, Math.min(l.resta, Number(e.target.value) || 0)),
                      }))
                    }
                    className="h-9 w-16 rounded-md border px-2 text-center text-[13px] tabular outline-none"
                    style={inputStyle}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
        <button
          type="button"
          onClick={confirmar}
          disabled={!venta || disponibles.length === 0}
          className="rounded-md px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
          style={{ background: "var(--primary)" }}
        >
          Agregar al carrito
        </button>
      </div>
    </Modal>
  );
}

/* ─────────────────────────── Ventas del día ─────────────────────────── */

type PagoDeVenta = { monto: number; medios_pago: { nombre: string } | null };

type VentaDelDia = {
  id: string;
  numero: number;
  created_at: string;
  estado: string;
  total: number;
  usuario_id: string;
  motivo_anulacion: string | null;
  venta_origen_id: string | null;
  clientes: { nombre: string } | null;
  pagos: PagoDeVenta[];
};

/** Arranque del día de hoy en la hora del local, que es la que mira el vendedor. */
function arranqueDelDia() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function hora(iso: string) {
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Lo que se vendió hoy en esta sucursal, en orden y con quién lo hizo. Existe
 * porque la pregunta de las siete de la tarde es siempre la misma: "¿cuánto
 * hicimos?" y "¿el ticket de la señora cuál era?". Sin esto había que abrir la
 * caja y leer movimientos sueltos.
 *
 * Anular vive acá y no en una pantalla aparte: se anula el ticket que se acaba
 * de hacer mal, y es el que está arriba de todo en esta lista.
 */
function DialogoVentasDelDia({
  sucursal,
  esDueno,
  onCerrar,
  onAnulada,
}: {
  sucursal: Sucursal;
  esDueno: boolean;
  onCerrar: () => void;
  onAnulada: () => void;
}) {
  const [ventas, setVentas] = useState<VentaDelDia[]>([]);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [anulando, setAnulando] = useState<string | null>(null);
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [errorAnular, setErrorAnular] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    const [{ data, error: err }, { data: gente }] = await Promise.all([
      supa
        .from("ventas")
        .select(
          "id, numero, created_at, estado, total, usuario_id, motivo_anulacion, venta_origen_id, " +
            "clientes ( nombre ), pagos ( monto, medios_pago ( nombre ) )",
        )
        .eq("sucursal_id", sucursal.id)
        .gte("created_at", arranqueDelDia())
        .order("numero", { ascending: false }),
      supa.from("usuarios").select("user_id, nombre"),
    ]);

    if (err) setError(err.message);
    else {
      setError(null);
      setVentas((data ?? []) as unknown as VentaDelDia[]);
    }
    setNombres(
      Object.fromEntries(
        ((gente ?? []) as { user_id: string; nombre: string }[]).map((u) => [u.user_id, u.nombre]),
      ),
    );
    setCargando(false);
  }, [sucursal.id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const vivas = ventas.filter((v) => v.estado === "completada");
  const facturado = vivas.reduce((s, v) => s + Number(v.total), 0);

  const anular = async (venta: VentaDelDia) => {
    if (!motivo.trim()) {
      setErrorAnular("Escribí por qué se anula. Sin motivo no se puede auditar después.");
      return;
    }
    setEnviando(true);
    setErrorAnular(null);
    const { error: err } = await supa.rpc("anular_venta", {
      p_venta_id: venta.id,
      p_motivo: motivo.trim(),
    });
    if (err) {
      setErrorAnular(err.message);
      setEnviando(false);
      return;
    }
    setEnviando(false);
    setAnulando(null);
    setMotivo("");
    await cargar();
    onAnulada();
  };

  return (
    <Modal titulo={`Ventas de hoy — ${sucursal.alias}`} ancho="max-w-3xl" onCerrar={onCerrar}>
      {cargando ? (
        <div className="grid place-items-center py-10">
          <Loader2 size={18} className="animate-spin" style={{ color: "var(--muted-foreground)" }} />
        </div>
      ) : error ? (
        <Alerta tono="danger">No se pudieron leer las ventas: {error}</Alerta>
      ) : ventas.length === 0 ? (
        <div className="py-10 text-center">
          <div className="text-[13px] font-medium">Todavía no se vendió nada hoy</div>
          <p className="mt-1 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Los tickets van a aparecer acá apenas se cobre el primero.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-4 rounded-md px-3 py-2" style={{ background: "#f9fafc" }}>
            <div>
              <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>Tickets</div>
              <div className="text-[16px] font-semibold tabular">{vivas.length}</div>
            </div>
            <div>
              <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>Vendido</div>
              <div className="text-[16px] font-semibold tabular">{formatARS(facturado)}</div>
            </div>
            {ventas.length > vivas.length && (
              <div>
                <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>Anuladas</div>
                <div className="text-[16px] font-semibold tabular" style={{ color: "var(--danger)" }}>
                  {ventas.length - vivas.length}
                </div>
              </div>
            )}
          </div>

          <div className="max-h-[55vh] overflow-y-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0" style={{ background: "var(--surface)" }}>
                <tr style={{ color: "var(--muted-foreground)" }}>
                  <th className="px-2 py-2 text-left font-medium">Ticket</th>
                  <th className="px-2 py-2 text-left font-medium">Hora</th>
                  <th className="px-2 py-2 text-left font-medium">Cliente</th>
                  <th className="px-2 py-2 text-left font-medium">Cobro</th>
                  <th className="px-2 py-2 text-left font-medium">Vendió</th>
                  <th className="px-2 py-2 text-right font-medium">Total</th>
                  {esDueno && <th className="px-2 py-2" />}
                </tr>
              </thead>
              <tbody>
                {ventas.map((v) => {
                  const anulada = v.estado !== "completada";
                  const medios =
                    v.pagos
                      .map((p) => p.medios_pago?.nombre)
                      .filter(Boolean)
                      .join(" + ") || "—";
                  return (
                    <tr key={v.id} style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="px-2 py-2 tabular font-medium">
                        #{v.numero}
                        {v.venta_origen_id && (
                          <span className="ml-1 text-[11px]" style={{ color: "var(--violet)" }}>
                            cambio
                          </span>
                        )}
                        {anulada && (
                          <div className="text-[11px]" style={{ color: "var(--danger)" }}>
                            anulada{v.motivo_anulacion ? `: ${v.motivo_anulacion}` : ""}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2 tabular" style={{ color: "var(--muted-foreground)" }}>
                        {hora(v.created_at)}
                      </td>
                      <td className="px-2 py-2">{v.clientes?.nombre ?? "Mostrador"}</td>
                      <td className="px-2 py-2" style={{ color: "var(--muted-foreground)" }}>{medios}</td>
                      <td className="px-2 py-2">{nombres[v.usuario_id] ?? "—"}</td>
                      <td
                        className="px-2 py-2 text-right tabular font-semibold"
                        style={{
                          color: anulada ? "var(--muted-foreground)" : "var(--foreground)",
                          textDecoration: anulada ? "line-through" : undefined,
                        }}
                      >
                        {formatARS(Number(v.total))}
                      </td>
                      {esDueno && (
                        <td className="px-2 py-2 text-right">
                          {!anulada && anulando !== v.id && (
                            <button
                              onClick={() => {
                                setAnulando(v.id);
                                setMotivo("");
                                setErrorAnular(null);
                              }}
                              className="text-[12px] font-medium"
                              style={{ color: "var(--danger)" }}
                            >
                              Anular
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* El motivo va abajo y no en la fila: la fila es angosta y el motivo es
              lo único que después explica la anulación en una auditoría. */}
          {anulando && (
            <div className="mt-3 rounded-md p-3" style={{ background: "var(--danger-bg)" }}>
              <div className="flex items-start gap-1.5 text-[12px]" style={{ color: "var(--danger)" }}>
                <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                <span>
                  Anular el ticket #{ventas.find((v) => v.id === anulando)?.numero} devuelve la
                  mercadería al stock, borra la deuda si se había fiado y saca de la caja lo que se
                  había cobrado en efectivo. No se puede deshacer.
                </span>
              </div>
              <input
                autoFocus
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Por qué se anula (ej: se cargó el talle equivocado)"
                className={inputCls}
                style={inputStyle}
              />
              {errorAnular && (
                <p className="mt-2 text-[11px]" style={{ color: "var(--danger)" }}>
                  {errorAnular}
                </p>
              )}
              <div className="mt-2 flex justify-end gap-2">
                <BotonSecundario onClick={() => setAnulando(null)}>No anular</BotonSecundario>
                <button
                  type="button"
                  disabled={enviando}
                  onClick={() => {
                    const v = ventas.find((x) => x.id === anulando);
                    if (v) void anular(v);
                  }}
                  className="rounded-md px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
                  style={{ background: "var(--danger)" }}
                >
                  {enviando ? "Anulando…" : "Sí, anular"}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {!esDueno && ventas.length > 0 && (
        <p className="mt-3 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          Anular un ticket es cosa de un dueño. Si te equivocaste, pedíselo: la base tampoco te lo
          va a dejar hacer desde acá.
        </p>
      )}
    </Modal>
  );
}

/* ─────────────────────────── Cliente nuevo ─────────────────────────── */

function DialogoCliente({
  condicionEmisor,
  onCerrar,
  onCreado,
}: {
  condicionEmisor: string | null;
  onCerrar: () => void;
  onCreado: (c: Cliente) => void;
}) {
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [fiscal, setFiscal] = useState<DatosFiscales>({
    condicion_iva: "consumidor_final",
    tipo_documento: "DNI",
    documento: "",
  });
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nombre.trim()) {
      setError("El nombre no puede quedar vacío: es con lo que después se lo busca.");
      return;
    }
    const mal = validarFiscal(fiscal);
    if (mal) {
      setError(mal);
      return;
    }
    setGuardando(true);
    setError(null);
    const documento = limpiarDocumento(fiscal.documento, fiscal.tipo_documento);
    const { data, error: err } = await supa
      .from("clientes")
      .insert({
        nombre: nombre.trim(),
        documento: documento || null,
        telefono: telefono.trim() || null,
        condicion_iva: fiscal.condicion_iva,
        tipo_documento: fiscal.tipo_documento,
      })
      .select("id, nombre, telefono, saldo")
      .single();

    if (err) {
      setError(err.message);
      setGuardando(false);
      return;
    }
    onCreado(data as Cliente);
  };

  return (
    <Modal titulo="Cliente nuevo" onCerrar={onCerrar}>
      <form onSubmit={(e) => void guardar(e)}>
      <div className="space-y-3">
        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Nombre y apellido
          </label>
          <input autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} className={inputCls} style={inputStyle} />
        </div>
        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Teléfono
          </label>
          <input value={telefono} onChange={(e) => setTelefono(e.target.value)} className={inputCls} style={inputStyle} />
        </div>
        {/* El mostrador pide lo mismo que la pantalla de clientes: un cliente
            cargado a medias no se puede facturar, y se descubre tarde. */}
        <CamposFiscales datos={fiscal} onCambio={setFiscal} condicionEmisor={condicionEmisor} />
      </div>

      <p className="mt-3 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
        El saldo no se carga a mano: arranca en cero y se mueve solo con lo que se fía y lo que se
        cobra.
      </p>

      {error && (
        <div className="mt-3">
          <Alerta tono="danger">{error}</Alerta>
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
        <BotonPrimario enviando={guardando}>Guardar cliente</BotonPrimario>
      </div>
      </form>
    </Modal>
  );
}
