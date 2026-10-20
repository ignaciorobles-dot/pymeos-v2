import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/layout/AppShell";
import { Chip } from "@/components/ui-bits/Chip";
import { Alerta } from "@/components/ui-bits/Modal";
import { formatARS } from "@/lib/format";
import { useSesion, useSucursalOperativa } from "@/lib/sesion";
import { supa } from "@/lib/supabase";
import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import {
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  ShoppingBag,
  Wallet,
  Receipt,
  HandCoins,
  Loader2,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard — PymeOS" },
      { name: "description", content: "Panel general de operaciones de PymeOS." },
    ],
  }),
  component: Dashboard,
});

/**
 * Todos los números de esta pantalla salen de la base, no del navegador.
 *
 * Sumar las ventas del mes trayéndolas todas y sumándolas acá funciona con
 * doscientas ventas y se cae con veinte mil. Las funciones `resumen_tablero`,
 * `ventas_por_dia`, `ultimos_movimientos` y `detalle_stock_bajo` hacen la
 * cuenta en Postgres y devuelven lo justo.
 *
 * También corren el corte de mes en la hora de Rosario: el servidor está en
 * UTC, así que una venta de las 22:30 del 31 sería del mes siguiente si la
 * cuenta se hiciera acá.
 */

type Resumen = {
  ventas: number;
  ventas_previo: number;
  costo: number;
  costo_previo: number;
  gastos: number;
  gastos_previo: number;
  resultado: number;
  resultado_previo: number;
  tickets: number;
  tickets_previo: number;
  ticket_promedio: number;
  ticket_promedio_previo: number;
  stock_bajo: number;
  por_cobrar: number;
};

type PuntoVenta = { dia: string; total: number; tickets: number };

type Movimiento = {
  cuando: string;
  tipo: string;
  detalle: string | null;
  monto: number;
  sucursal: string | null;
  quien: string | null;
  ruta: string;
};

type FaltanteStock = {
  variante_id: string;
  producto: string;
  marca: string | null;
  talle: string | null;
  color: string | null;
  cantidad: number;
  sucursal: string | null;
};

/** La fecha estaba escrita a mano ("martes 28 de julio") y envejeció sola. */
function hoyEnLetras() {
  return new Intl.DateTimeFormat("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
}

/**
 * La variación contra el mismo pedazo del mes anterior, en texto.
 *
 * Cuando el mes anterior fue cero no se inventa un porcentaje: dividir por cero
 * daría "+∞%" o, peor, un número que parece real. Se dice que no hay con qué
 * comparar y listo.
 */
function variacion(actual: number, previo: number): { texto: string; sube: boolean | null } {
  if (previo === 0) {
    if (actual === 0) return { texto: "sin movimiento", sube: null };
    return { texto: "sin mes anterior para comparar", sube: null };
  }
  const pct = ((actual - previo) / Math.abs(previo)) * 100;
  const signo = pct >= 0 ? "+" : "";
  return {
    texto: `${signo}${pct.toFixed(1).replace(".", ",")}% vs mes anterior`,
    sube: pct >= 0,
  };
}

/** "2026-08-12" -> "12/8", que es como se lee un eje de días. */
function diaCorto(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)}/${Number(m)}`;
}

function horaCorta(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

function fechaCorta(iso: string): string {
  return new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });
}

/** Los movimientos de hoy muestran la hora; los de ayer, la fecha. */
function cuandoCorto(iso: string): string {
  const d = new Date(iso);
  const hoy = new Date();
  const mismoDia =
    d.getDate() === hoy.getDate() &&
    d.getMonth() === hoy.getMonth() &&
    d.getFullYear() === hoy.getFullYear();
  return mismoDia ? horaCorta(iso) : fechaCorta(iso);
}

function tonoDeMovimiento(tipo: string, monto: number): "success" | "danger" | "violet" | "neutral" {
  if (tipo === "Venta anulada") return "neutral";
  if (tipo === "Venta") return "success";
  if (monto < 0) return "danger";
  return "violet";
}

/** Una tarjeta de las de arriba. `a` en null es una tarjeta que no lleva a ningún lado. */
type Tarjeta = {
  label: string;
  value: string;
  texto: string;
  /** true sube, false baja, null no hay con qué comparar. */
  sube: boolean | null;
  icon: typeof ShoppingBag;
  a: string | null;
  ayuda?: string;
  tone?: "warning";
};

const RANGOS = [
  { etiqueta: "7d", dias: 7 },
  { etiqueta: "30d", dias: 30 },
  { etiqueta: "90d", dias: 90 },
] as const;

function Dashboard() {
  const { sucursalEquipo, verTodas } = useSesion();
  const sucursalOperativa = useSucursalOperativa();

  // En "ver las dos" el tablero suma las dos sucursales. Acá está permitido y
  // en el resto del sistema no, porque esto solo mira: no existe ninguna
  // operación que se guarde "en las dos".
  const sucursalId = verTodas ? null : (sucursalOperativa?.id ?? sucursalEquipo?.id ?? null);

  // Se calcula recién en el navegador: el servidor puede estar en otra zona
  // horaria y armar un texto distinto al del cliente, que es justo lo que
  // rompe la hidratación.
  const [hoy, setHoy] = useState<string | null>(null);
  useEffect(() => setHoy(hoyEnLetras()), []);

  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [serie, setSerie] = useState<PuntoVenta[]>([]);
  const [movimientos, setMovimientos] = useState<Movimiento[]>([]);
  const [faltantes, setFaltantes] = useState<FaltanteStock[]>([]);
  const [dias, setDias] = useState<number>(30);
  const [cargando, setCargando] = useState(true);
  const [cargandoSerie, setCargandoSerie] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);

    const [resu, movs, stockBajo] = await Promise.all([
      supa.rpc("resumen_tablero", { p_sucursal_id: sucursalId, p_stock_minimo: 3 }),
      supa.rpc("ultimos_movimientos", { p_sucursal_id: sucursalId, p_limite: 8 }),
      supa.rpc("detalle_stock_bajo", { p_sucursal_id: sucursalId, p_minimo: 3, p_limite: 6 }),
    ]);

    const fallo = resu.error ?? movs.error ?? stockBajo.error;
    if (fallo) {
      setError(fallo.message);
      setCargando(false);
      return;
    }

    // La función devuelve una sola fila; PostgREST igual la manda como lista.
    const fila = Array.isArray(resu.data) ? resu.data[0] : resu.data;
    setResumen((fila ?? null) as Resumen | null);
    setMovimientos((movs.data ?? []) as Movimiento[]);
    setFaltantes((stockBajo.data ?? []) as FaltanteStock[]);
    setCargando(false);
  }, [sucursalId]);

  const cargarSerie = useCallback(async () => {
    setCargandoSerie(true);
    const { data, error: err } = await supa.rpc("ventas_por_dia", {
      p_sucursal_id: sucursalId,
      p_dias: dias,
    });
    if (!err) setSerie((data ?? []) as PuntoVenta[]);
    setCargandoSerie(false);
  }, [sucursalId, dias]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  useEffect(() => {
    void cargarSerie();
  }, [cargarSerie]);

  const alcance = verTodas ? "Ambas sucursales" : (sucursalOperativa?.nombre ?? sucursalEquipo?.nombre ?? "");

  /**
   * Cada tarjeta lleva a la pantalla donde está el detalle de ese número. Mirar
   * un total y no poder abrirlo es la queja más común: el tablero se vuelve un
   * póster.
   */
  const tarjetas = useMemo<Tarjeta[]>(() => {
    const r = resumen;
    const num = (n: number | undefined) => (typeof n === "number" ? n : 0);

    return [
      {
        label: "Ventas del mes",
        value: formatARS(num(r?.ventas)),
        ...variacion(num(r?.ventas), num(r?.ventas_previo)),
        icon: ShoppingBag,
        a: "/ventas" as const,
      },
      {
        label: "Gastos",
        value: formatARS(num(r?.gastos)),
        // En gastos, subir es malo: la flecha verde va cuando bajan.
        ...(() => {
          const v = variacion(num(r?.gastos), num(r?.gastos_previo));
          return { texto: v.texto, sube: v.sube === null ? null : !v.sube };
        })(),
        icon: Wallet,
        a: "/gastos" as const,
      },
      {
        label: "Resultado",
        value: formatARS(num(r?.resultado)),
        ...variacion(num(r?.resultado), num(r?.resultado_previo)),
        icon: TrendingUp,
        a: "/resultado" as const,
        // Ventas menos el costo de lo que se vendió menos los gastos. La
        // mercadería comprada no resta acá: comprar no es perder plata, es
        // cambiar plata por stock.
        ayuda: "Ventas − costo de lo vendido − gastos",
      },
      {
        label: "Ticket promedio",
        value: formatARS(num(r?.ticket_promedio)),
        ...variacion(num(r?.ticket_promedio), num(r?.ticket_promedio_previo)),
        icon: Receipt,
        a: "/ventas" as const,
        ayuda: `${num(r?.tickets)} ${num(r?.tickets) === 1 ? "venta" : "ventas"} este mes`,
      },
      {
        label: "Por cobrar",
        value: formatARS(num(r?.por_cobrar)),
        texto: "lo fiado que falta cobrar",
        sube: null,
        icon: HandCoins,
        a: "/clientes" as const,
      },
      {
        label: "Stock bajo",
        value: `${num(r?.stock_bajo)} ${num(r?.stock_bajo) === 1 ? "variante" : "variantes"}`,
        texto: num(r?.stock_bajo) > 0 ? "requiere reposición" : "todo con stock",
        sube: null,
        icon: AlertTriangle,
        tone: (num(r?.stock_bajo) > 0 ? "warning" : undefined) as "warning" | undefined,
        a: "/stock" as const,
      },
    ];
  }, [resumen]);

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={hoy ? `Resumen del negocio — hoy, ${hoy}` : "Resumen del negocio"}
      />

      {error && (
        <div className="mb-3">
          <Alerta tono="danger">No se pudieron traer los números: {error}</Alerta>
        </div>
      )}

      <div className="grid grid-cols-6 gap-3">
        {tarjetas.map((m) => {
          const Icon = m.icon;
          const colorDelta =
            m.tone === "warning"
              ? "var(--warning)"
              : m.sube === null
                ? "var(--muted-foreground)"
                : m.sube
                  ? "var(--success)"
                  : "var(--danger)";

          const adentro = (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                  {m.label}
                </span>
                <div
                  className="grid h-7 w-7 place-items-center rounded-md"
                  style={{
                    background: m.tone === "warning" ? "var(--warning-bg)" : "#eef1f6",
                    color: m.tone === "warning" ? "var(--warning)" : "var(--muted-foreground)",
                  }}
                >
                  <Icon size={14} />
                </div>
              </div>
              <div className="mt-2 text-[20px] font-semibold tabular">
                {cargando ? <span style={{ color: "var(--muted-foreground)" }}>—</span> : m.value}
              </div>
              <div
                className="mt-1 flex items-center gap-1 text-[12px]"
                style={{ color: colorDelta }}
              >
                {m.tone === "warning" && <AlertTriangle size={12} />}
                {m.sube === true && <TrendingUp size={12} />}
                {m.sube === false && <TrendingDown size={12} />}
                {m.texto}
              </div>
              {m.ayuda && (
                <div className="mt-0.5 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                  {m.ayuda}
                </div>
              )}
            </>
          );

          if (!m.a) return <div key={m.label} className="card-surface p-4">{adentro}</div>;

          return (
            <Link key={m.label} to={m.a} className="card-surface card-link block p-4">
              {adentro}
            </Link>
          );
        })}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <div className="card-surface col-span-2 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 text-[14px] font-semibold">
                Ventas — últimos {dias} días
                {cargandoSerie && (
                  <Loader2 size={13} className="animate-spin" style={{ color: "var(--muted-foreground)" }} />
                )}
              </div>
              <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                {alcance}
              </div>
            </div>
            <div className="flex gap-1 rounded-md border p-0.5" style={{ borderColor: "var(--border)" }}>
              {RANGOS.map((r) => (
                <button
                  key={r.etiqueta}
                  type="button"
                  onClick={() => setDias(r.dias)}
                  className="rounded px-2.5 py-1 text-[12px]"
                  style={{
                    background: dias === r.dias ? "var(--background)" : "transparent",
                    fontWeight: dias === r.dias ? 600 : 400,
                  }}
                >
                  {r.etiqueta}
                </button>
              ))}
            </div>
          </div>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <AreaChart data={serie}>
                <defs>
                  <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#b84a24" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="#b84a24" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" vertical={false} />
                <XAxis
                  dataKey="dia"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11, fill: "#667085" }}
                  tickFormatter={diaCorto}
                  minTickGap={16}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11, fill: "#667085" }}
                  width={40}
                  tickFormatter={(v) => `${Math.round(v / 1000)}k`}
                />
                <Tooltip
                  formatter={(v: number) => formatARS(v)}
                  labelFormatter={(l: string) => diaCorto(l)}
                  contentStyle={{ borderRadius: 8, fontSize: 12, border: "1px solid #e4e7ef" }}
                />
                <Area type="monotone" dataKey="total" name="Ventas" stroke="#b84a24" strokeWidth={2} fill="url(#g1)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[14px] font-semibold">Alertas de stock</div>
            {faltantes.length > 0 && <Chip tone="warning">{resumen?.stock_bajo ?? faltantes.length} críticos</Chip>}
          </div>

          {cargando ? (
            <div className="py-6 text-center text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              Cargando…
            </div>
          ) : faltantes.length === 0 ? (
            <div className="py-6 text-center text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              No hay variantes con poco stock.
            </div>
          ) : (
            <div className="space-y-2">
              {faltantes.map((f) => (
                <div
                  key={`${f.variante_id}-${f.sucursal}`}
                  className="flex items-center gap-2.5 rounded-md p-2"
                  style={{ background: "var(--warning-bg)" }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">
                      {f.producto}
                      {f.marca ? ` · ${f.marca}` : ""}
                    </div>
                    <div className="text-[11px]" style={{ color: "var(--warning)" }}>
                      {[f.talle ? `T.${f.talle}` : null, f.color, f.sucursal]
                        .filter(Boolean)
                        .join(" · ")}
                      {" · "}
                      {f.cantidad} u.
                    </div>
                  </div>
                  {/* Reponer todavía no carga stock: por ahora abre la pantalla
                      donde se cuenta. */}
                  <Link
                    to="/stock"
                    className="rounded-md px-2 py-1 text-[11px] font-medium"
                    style={{ background: "#fff", color: "var(--warning)", border: "1px solid #f3d9a5" }}
                  >
                    Reponer
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 card-surface">
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <div className="text-[14px] font-semibold">Últimos movimientos</div>
          {/* Mezcla ventas, gastos, compras y los movimientos de caja hechos a
              mano. Los que nacen de una venta quedan afuera: si entraran, cada
              venta en efectivo aparecería dos veces. */}
          <Link to="/caja" className="text-[12px] font-medium" style={{ color: "var(--primary)" }}>
            Ver la caja
          </Link>
        </div>

        {cargando ? (
          <div className="px-4 py-8 text-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            Cargando…
          </div>
        ) : movimientos.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            Todavía no hay movimientos.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr style={{ color: "var(--muted-foreground)" }}>
                <th className="px-4 py-2 text-left font-medium">Cuándo</th>
                <th className="px-4 py-2 text-left font-medium">Tipo</th>
                <th className="px-4 py-2 text-left font-medium">Detalle</th>
                <th className="px-4 py-2 text-left font-medium">Sucursal</th>
                <th className="px-4 py-2 text-left font-medium">Quién</th>
                <th className="px-4 py-2 text-right font-medium">Monto</th>
              </tr>
            </thead>
            <tbody>
              {movimientos.map((m, i) => (
                <tr key={`${m.cuando}-${i}`} style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="px-4 py-2 tabular" style={{ color: "var(--muted-foreground)" }}>
                    {cuandoCorto(m.cuando)}
                  </td>
                  <td className="px-4 py-2">
                    <Chip tone={tonoDeMovimiento(m.tipo, m.monto)}>{m.tipo}</Chip>
                  </td>
                  <td className="px-4 py-2">
                    <Link to={m.ruta} className="card-link">
                      {m.detalle ?? "—"}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{m.sucursal ?? "—"}</td>
                  <td className="px-4 py-2" style={{ color: "var(--muted-foreground)" }}>
                    {m.quien ?? "—"}
                  </td>
                  <td
                    className="px-4 py-2 text-right tabular font-medium"
                    style={{ color: m.monto < 0 ? "var(--danger)" : "var(--foreground)" }}
                  >
                    {m.monto < 0 ? "-" : ""}
                    {formatARS(Math.abs(m.monto))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
