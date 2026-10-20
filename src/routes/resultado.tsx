import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  BarChart,
  Bar,
  Cell,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/layout/AppShell";
import { Alerta, inputStyle } from "@/components/ui-bits/Modal";
import { useSesion, useSucursalOperativa } from "@/lib/sesion";
import { supa } from "@/lib/supabase";
import { formatARS, formatNum } from "@/lib/format";

export const Route = createFileRoute("/resultado")({
  head: () => ({
    meta: [
      { title: "Resultado — PymeOS" },
      {
        name: "description",
        content:
          "Cuánto quedó en el período: ventas menos el costo de lo vendido menos los gastos.",
      },
    ],
  }),
  component: Resultado,
});

type Totales = {
  ventas: number;
  unidades: number;
  costo: number;
  margen: number;
  gastos: number;
  resultado: number;
  tickets: number;
  ticket_promedio: number;
};

type PorSucursal = {
  sucursal_id: string;
  sucursal: string;
  ventas: number;
  costo: number;
  gastos: number;
  resultado: number;
  tickets: number;
};

type PorCategoria = { categoria: string; total: number; cuantos: number };
type PorMedio = {
  medio: string;
  cuotas: number;
  cuantos: number;
  monto: number;
  recargo: number;
};

type PorMes = {
  mes: string;
  ventas: number;
  costo: number;
  gastos: number;
  resultado: number;
};

/**
 * El mes que se está mirando, como lo escribe un `<input type="month">`. Se
 * calcula del reloj del navegador y fuera del render: si se calcula mientras
 * se dibuja, el servidor y el navegador pueden caer en días distintos y React
 * se queja de que el HTML no coincide.
 */
function mesActual(): string {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
}

/** Primer y último día del mes, como los espera la base. */
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
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a.slice(2)}`;
}

/** "ago 26", para el eje del gráfico de meses. */
function mesCorto(iso: string): string {
  const [a, m] = iso.split("-").map(Number);
  const texto = new Date(a, m - 1, 1).toLocaleDateString("es-AR", { month: "short" });
  return `${texto.replace(".", "")} ${String(a).slice(2)}`;
}

/** Qué porcentaje de las ventas es un número. Sin ventas no hay porcentaje. */
function sobreVentas(parte: number, ventas: number): string {
  if (!ventas) return "—";
  return `${((parte / ventas) * 100).toFixed(1).replace(".", ",")}%`;
}

const VACIO: Totales = {
  ventas: 0,
  unidades: 0,
  costo: 0,
  margen: 0,
  gastos: 0,
  resultado: 0,
  tickets: 0,
  ticket_promedio: 0,
};

function Resultado() {
  const { sucursalEquipo, verTodas } = useSesion();
  const sucursalOperativa = useSucursalOperativa();

  const [mes, setMes] = useState(mesActual);
  /** Con el rango libre abierto, el mes deja de mandar y mandan estas dos fechas. */
  const [libre, setLibre] = useState(false);
  const [desdeLibre, setDesdeLibre] = useState(() => rangoDelMes(mesActual()).desde);
  const [hastaLibre, setHastaLibre] = useState(() => rangoDelMes(mesActual()).hasta);

  const [totales, setTotales] = useState<Totales>(VACIO);
  const [sucursales, setSucursales] = useState<PorSucursal[]>([]);
  const [categorias, setCategorias] = useState<PorCategoria[]>([]);
  const [medios, setMedios] = useState<PorMedio[]>([]);
  const [meses, setMeses] = useState<PorMes[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  const { desde, hasta } = useMemo(
    () => (libre ? { desde: desdeLibre, hasta: hastaLibre } : rangoDelMes(mes)),
    [libre, desdeLibre, hastaLibre, mes],
  );

  // El mismo criterio que el resto del sistema: si el equipo está parado en una
  // sucursal, los números son de esa sucursal. "Ver las dos" suma las dos.
  const sucursalId = verTodas ? null : (sucursalOperativa?.id ?? sucursalEquipo?.id ?? null);

  const alRevés = desde > hasta;

  const cargar = useCallback(async () => {
    if (desde > hasta) {
      setErrorCarga("El período está al revés: la fecha de inicio es posterior a la de fin.");
      setCargando(false);
      return;
    }
    setCargando(true);
    setErrorCarga(null);

    // Las cuatro preguntas del período van juntas: es una sola pantalla y no
    // tiene sentido dibujar media con datos viejos.
    const [tot, suc, cat, ser, med] = await Promise.all([
      supa.rpc("resultado_periodo", {
        p_desde: desde,
        p_hasta: hasta,
        p_sucursal_id: sucursalId,
      }),
      supa.rpc("resultado_por_sucursal", { p_desde: desde, p_hasta: hasta }),
      supa.rpc("gastos_por_categoria", {
        p_desde: desde,
        p_hasta: hasta,
        p_sucursal_id: sucursalId,
      }),
      supa.rpc("resultado_por_mes", { p_meses: 12, p_sucursal_id: sucursalId }),
      supa.rpc("cobros_por_medio", {
        p_desde: desde,
        p_hasta: hasta,
        p_sucursal_id: sucursalId,
      }),
    ]);

    // `med` queda afuera a propósito. Es una tabla más de la pantalla: si su
    // función todavía no está en la base, no tiene por qué dejar sin resultado
    // a todo el resto. Se dibuja vacía y listo.
    const fallo = tot.error ?? suc.error ?? cat.error ?? ser.error;
    if (med.error) console.warn("resultado: cobros_por_medio no disponible", med.error.message);
    if (fallo) {
      setErrorCarga(fallo.message);
      setCargando(false);
      return;
    }

    // La función devuelve una sola fila; PostgREST igual la manda como lista.
    const fila = Array.isArray(tot.data) ? tot.data[0] : tot.data;
    setTotales(fila ? (fila as Totales) : VACIO);
    setSucursales((suc.data ?? []) as PorSucursal[]);
    setCategorias((cat.data ?? []) as PorCategoria[]);
    setMeses((ser.data ?? []) as PorMes[]);
    setMedios(med.error ? [] : ((med.data ?? []) as PorMedio[]));
    setCargando(false);
  }, [desde, hasta, sucursalId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const alcance = verTodas
    ? "Las dos sucursales"
    : (sucursalOperativa?.nombre ?? sucursalEquipo?.nombre ?? "Sin sucursal activa");

  const periodo = libre
    ? `${fechaCorta(desde)} al ${fechaCorta(hasta)}`
    : nombreDelMes(mes);

  /**
   * La cuenta, renglón por renglón, en el orden en que se explica de palabra:
   * se vendió tanto, esa mercadería había costado tanto, quedó tanto de bruto,
   * los gastos se llevaron tanto, y lo que sobra es el resultado.
   */
  const renglones = useMemo(
    () => [
      {
        clave: "ventas",
        etiqueta: "Ventas",
        monto: totales.ventas,
        signo: "" as const,
        ayuda: `${formatNum(totales.tickets)} ${totales.tickets === 1 ? "venta" : "ventas"} · ${formatNum(totales.unidades)} u.`,
        fuerte: false,
      },
      {
        clave: "costo",
        etiqueta: "Costo de lo vendido",
        monto: totales.costo,
        signo: "−" as const,
        ayuda: "Lo que había costado esa mercadería",
        fuerte: false,
      },
      {
        clave: "margen",
        etiqueta: "Margen bruto",
        monto: totales.margen,
        signo: "=" as const,
        ayuda: "Lo que deja la venta antes de los gastos",
        fuerte: true,
      },
      {
        clave: "gastos",
        etiqueta: "Gastos",
        monto: totales.gastos,
        signo: "−" as const,
        ayuda: "Lo operativo, sin contar la mercadería",
        fuerte: false,
      },
      {
        clave: "resultado",
        etiqueta: "Resultado",
        monto: totales.resultado,
        signo: "=" as const,
        ayuda: "Lo que quedó en el período",
        fuerte: true,
      },
    ],
    [totales],
  );

  const mayorGasto = categorias.length ? Math.max(...categorias.map((c) => c.total)) : 0;
  const totalGastado = categorias.reduce((a, c) => a + c.total, 0);

  return (
    <>
      <PageHeader
        title="Resultado"
        subtitle={`${periodo} · ${alcance}`}
        actions={
          <div className="flex items-center gap-2">
            {libre ? (
              <>
                <input
                  type="date"
                  value={desdeLibre}
                  onChange={(e) => setDesdeLibre(e.target.value)}
                  className="h-8 rounded-md border px-2 text-[13px]"
                  style={inputStyle}
                />
                <span className="text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                  al
                </span>
                <input
                  type="date"
                  value={hastaLibre}
                  onChange={(e) => setHastaLibre(e.target.value)}
                  className="h-8 rounded-md border px-2 text-[13px]"
                  style={inputStyle}
                />
              </>
            ) : (
              <input
                type="month"
                value={mes}
                onChange={(e) => setMes(e.target.value || mesActual())}
                className="h-8 rounded-md border px-2 text-[13px]"
                style={inputStyle}
              />
            )}
            <button
              onClick={() => {
                // Al abrir el rango libre se arranca del mes que se estaba
                // mirando: nadie quiere empezar de cero eligiendo dos fechas.
                if (!libre) {
                  const r = rangoDelMes(mes);
                  setDesdeLibre(r.desde);
                  setHastaLibre(r.hasta);
                }
                setLibre((v) => !v);
              }}
              className="h-8 rounded-md border px-3 text-[13px]"
              style={inputStyle}
            >
              {libre ? "Por mes" : "Otro período"}
            </button>
          </div>
        }
      />

      {errorCarga && (
        <div className="mb-3">
          <Alerta tono="danger">{errorCarga}</Alerta>
        </div>
      )}

      {!alRevés && !cargando && totales.ventas === 0 && totales.gastos === 0 && (
        <div className="mb-3">
          <Alerta tono="info">
            No hay ventas ni gastos cargados en {periodo}. Los números de abajo están en cero
            porque no pasó nada, no porque falle algo.
          </Alerta>
        </div>
      )}

      <div className="grid grid-cols-[1fr_360px] gap-3">
        {/* La cuenta */}
        <div className="card-surface overflow-hidden">
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <div>
              <div className="text-[14px] font-semibold">La cuenta del período</div>
              <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                Ventas − costo de lo vendido − gastos
              </div>
            </div>
            {cargando && (
              <Loader2 size={14} className="animate-spin" style={{ color: "var(--muted-foreground)" }} />
            )}
          </div>

          <table className="w-full text-[13px]">
            <tbody>
              {renglones.map((r) => (
                <tr
                  key={r.clave}
                  style={{
                    borderTop: "1px solid var(--border)",
                    background: r.fuerte ? "#f9fafc" : undefined,
                  }}
                >
                  <td
                    className="w-8 px-4 py-3 text-center tabular"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    {r.signo}
                  </td>
                  <td className="py-3 pr-4">
                    <div className={r.fuerte ? "font-semibold" : ""}>{r.etiqueta}</div>
                    <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                      {r.ayuda}
                    </div>
                  </td>
                  <td
                    className="px-4 py-3 text-right tabular"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    {r.clave === "ventas" ? "" : sobreVentas(r.monto, totales.ventas)}
                  </td>
                  <td
                    className={`px-4 py-3 text-right tabular ${r.fuerte ? "text-[15px] font-semibold" : ""}`}
                    style={{
                      color:
                        r.clave === "resultado"
                          ? totales.resultado < 0
                            ? "var(--danger)"
                            : "var(--success)"
                          : undefined,
                    }}
                  >
                    {formatARS(r.monto)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div
            className="flex items-center justify-between px-4 py-3 text-[12px]"
            style={{ borderTop: "1px solid var(--border)", color: "var(--muted-foreground)" }}
          >
            <span>Ticket promedio {formatARS(totales.ticket_promedio)}</span>
            <span>
              La mercadería comprada no resta acá: resta recién cuando se vende, como costo.
            </span>
          </div>
        </div>

        {/* En qué se fue la plata */}
        <div className="card-surface overflow-hidden">
          <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="text-[14px] font-semibold">En qué se fue la plata</div>
            <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              Gastos del período, de mayor a menor
            </div>
          </div>

          {cargando ? (
            <div
              className="flex items-center gap-2 px-4 py-6 text-[13px]"
              style={{ color: "var(--muted-foreground)" }}
            >
              <Loader2 size={14} className="animate-spin" /> Sumando los gastos…
            </div>
          ) : categorias.length === 0 ? (
            <div className="px-4 py-6 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
              No hay gastos cargados en {periodo}.
            </div>
          ) : (
            <div className="px-4 py-3">
              {categorias.map((c) => (
                <div key={c.categoria} className="mb-3 last:mb-0">
                  <div className="mb-1 flex items-baseline justify-between text-[13px]">
                    <span>{c.categoria}</span>
                    <span className="tabular">{formatARS(c.total)}</span>
                  </div>
                  {/* La barra es contra el gasto más grande, no contra el total:
                      así se ve la diferencia entre el primero y el segundo. */}
                  <div className="h-1.5 w-full rounded-full" style={{ background: "#eef1f6" }}>
                    <div
                      className="h-1.5 rounded-full"
                      style={{
                        width: `${mayorGasto ? (c.total / mayorGasto) * 100 : 0}%`,
                        background: "var(--primary)",
                      }}
                    />
                  </div>
                  <div className="mt-1 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                    {formatNum(c.cuantos)} {c.cuantos === 1 ? "gasto" : "gastos"} ·{" "}
                    {totalGastado ? sobreVentas(c.total, totalGastado) : "—"} de los gastos
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Cada sucursal por separado */}
      <div className="card-surface mt-3 overflow-hidden">
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="text-[14px] font-semibold">Cada sucursal por separado</div>
          <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Siempre las dos, sin importar dónde esté parado el equipo: para comparar hay que ver
            las dos juntas
          </div>
        </div>

        {cargando ? (
          <div
            className="flex items-center gap-2 px-4 py-6 text-[13px]"
            style={{ color: "var(--muted-foreground)" }}
          >
            <Loader2 size={14} className="animate-spin" /> Abriendo el resultado por sucursal…
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead style={{ background: "#f9fafc" }}>
              <tr style={{ color: "var(--muted-foreground)" }}>
                <th className="px-4 py-2 text-left font-medium">Sucursal</th>
                <th className="px-4 py-2 text-right font-medium">Ventas</th>
                <th className="px-4 py-2 text-right font-medium">Costo</th>
                <th className="px-4 py-2 text-right font-medium">Gastos</th>
                <th className="px-4 py-2 text-right font-medium">Tickets</th>
                <th className="px-4 py-2 text-right font-medium">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {sucursales.map((s) => (
                <tr key={s.sucursal_id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="px-4 py-2.5">{s.sucursal}</td>
                  <td className="px-4 py-2.5 text-right tabular">{formatARS(s.ventas)}</td>
                  <td className="px-4 py-2.5 text-right tabular">{formatARS(s.costo)}</td>
                  <td className="px-4 py-2.5 text-right tabular">{formatARS(s.gastos)}</td>
                  <td className="px-4 py-2.5 text-right tabular">{formatNum(s.tickets)}</td>
                  <td
                    className="px-4 py-2.5 text-right font-semibold tabular"
                    style={{ color: s.resultado < 0 ? "var(--danger)" : "var(--success)" }}
                  >
                    {formatARS(s.resultado)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Con qué pagaron */}
      <div className="card-surface mt-3 overflow-hidden">
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="text-[14px] font-semibold">Con qué pagaron</div>
          <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Lo cobrado por plan y en cuántas cuotas · {alcance}. La liquidación de la tarjeta
            llega separada así: esta tabla es contra la que se concilia.
          </div>
        </div>

        {cargando ? (
          <div
            className="flex items-center gap-2 px-4 py-6 text-[13px]"
            style={{ color: "var(--muted-foreground)" }}
          >
            <Loader2 size={14} className="animate-spin" /> Sumando los cobros…
          </div>
        ) : medios.length === 0 ? (
          <div className="px-4 py-6 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            No se cobró nada en {periodo}.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead style={{ background: "#f9fafc" }}>
              <tr style={{ color: "var(--muted-foreground)" }}>
                <th className="px-4 py-2 text-left font-medium">Medio</th>
                <th className="px-4 py-2 text-right font-medium">Cuotas</th>
                <th className="px-4 py-2 text-right font-medium">Cobros</th>
                <th className="px-4 py-2 text-right font-medium">Monto</th>
                <th className="px-4 py-2 text-right font-medium">Recargo</th>
              </tr>
            </thead>
            <tbody>
              {medios.map((m) => (
                <tr key={`${m.medio}-${m.cuotas}`} style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="px-4 py-2.5">{m.medio}</td>
                  <td className="px-4 py-2.5 text-right tabular">
                    {m.cuotas === 1 ? "Un pago" : m.cuotas}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular">{formatNum(m.cuantos)}</td>
                  <td className="px-4 py-2.5 text-right font-medium tabular">
                    {formatARS(m.monto)}
                  </td>
                  {/* El recargo va aparte porque no es plata del negocio: es lo
                      que se le sumó al cliente para cubrir el costo de financiar. */}
                  <td
                    className="px-4 py-2.5 text-right tabular"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    {m.recargo > 0 ? formatARS(m.recargo) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* La tendencia */}
      <div className="card-surface mt-3 px-4 py-4">
        <div className="mb-3">
          <div className="text-[14px] font-semibold">Resultado mes a mes</div>
          <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Últimos 12 meses · {alcance}. Un número solo no dice nada: lo que importa es si sube o
            baja.
          </div>
        </div>
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={meses} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" vertical={false} />
              <XAxis
                dataKey="mes"
                tickFormatter={mesCorto}
                tick={{ fontSize: 11, fill: "#667085" }}
                tickLine={false}
                axisLine={false}
                minTickGap={8}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#667085" }}
                tickLine={false}
                axisLine={false}
                width={70}
                tickFormatter={(v: number) => formatARS(v)}
              />
              <Tooltip
                formatter={(v: number) => formatARS(v)}
                labelFormatter={(l: string) => nombreDelMes(l.slice(0, 7))}
              />
              <Bar dataKey="resultado" radius={[4, 4, 0, 0]}>
                {/* Un mes en rojo es un mes que se perdió plata. Pintarlos todos
                    del mismo color obligaría a leer el signo del número. */}
                {meses.map((m) => (
                  <Cell
                    key={m.mes}
                    fill={m.resultado < 0 ? "var(--danger)" : "var(--primary)"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}
