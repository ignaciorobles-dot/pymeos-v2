import { useCallback, useEffect, useMemo, useState } from "react";
import { Alerta, BotonSecundario, Modal, inputCls, inputStyle } from "@/components/ui-bits/Modal";
import { supa } from "@/lib/supabase";
import { Agregar, Fila, type Ejecutar } from "@/components/ui-bits/ListaEditable";

/**
 * Las listas del catálogo: categorías, talles y colores.
 *
 * Existen para que nadie escriba a mano lo que tiene que elegir. Con texto libre
 * conviven "Calzado" y "Calzados", y el stock queda partido en dos categorías
 * que son la misma cosa. Acá se cargan una vez y después se eligen.
 *
 * Nada se borra: se desactiva. Un color que se dejó de traer sigue existiendo en
 * las ventas viejas, y hacerlo desaparecer de la lista no lo borra de la
 * historia — solo deja de ofrecerse al cargar algo nuevo.
 */

export type EscalaTalle = { id: string; nombre: string; orden: number };
export type Talle = { id: string; escala_id: string; valor: string; orden: number; activo: boolean };
export type Categoria = {
  id: string;
  nombre: string;
  escala_talle_id: string | null;
  orden: number;
  activa: boolean;
};
export type Color = { id: string; nombre: string; orden: number; activo: boolean };

export type Listas = {
  categorias: Categoria[];
  escalas: EscalaTalle[];
  talles: Talle[];
  colores: Color[];
};

const VACIO: Listas = { categorias: [], escalas: [], talles: [], colores: [] };

/** Carga las tres listas de una. Se comparten entre el alta de producto y el ABM. */
export function useListasCatalogo() {
  const [listas, setListas] = useState<Listas>(VACIO);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const recargar = useCallback(async () => {
    const [cat, esc, tal, col] = await Promise.all([
      supa.from("categorias").select("id, nombre, escala_talle_id, orden, activa").order("orden"),
      supa.from("escalas_talle").select("id, nombre, orden").order("orden"),
      supa.from("talles").select("id, escala_id, valor, orden, activo").order("orden"),
      supa.from("colores").select("id, nombre, orden, activo").order("orden"),
    ]);

    const fallo = cat.error ?? esc.error ?? tal.error ?? col.error;
    if (fallo) setError(fallo.message);
    else {
      setError(null);
      setListas({
        categorias: (cat.data ?? []) as Categoria[],
        escalas: (esc.data ?? []) as EscalaTalle[],
        talles: (tal.data ?? []) as Talle[],
        colores: (col.data ?? []) as Color[],
      });
    }
    setCargando(false);
  }, []);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  return { listas, cargando, error, recargar };
}

/** Los talles que corresponden a una categoría, en orden y solo los que siguen vigentes. */
export function tallesDeCategoria(listas: Listas, categoriaId: string | null): Talle[] {
  const cat = listas.categorias.find((c) => c.id === categoriaId);
  if (!cat?.escala_talle_id) return [];
  return listas.talles
    .filter((t) => t.escala_id === cat.escala_talle_id && t.activo)
    .sort((a, b) => a.orden - b.orden);
}

// ---------------------------------------------------------------------------
// El ABM
// ---------------------------------------------------------------------------

type Pestana = "categorias" | "talles" | "colores";

export function DialogoListas({
  listas,
  inicial = "categorias",
  onCambio,
  onCerrar,
}: {
  listas: Listas;
  inicial?: Pestana;
  onCambio: () => Promise<void> | void;
  onCerrar: () => void;
}) {
  const [pestana, setPestana] = useState<Pestana>(inicial);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  /**
   * Todas las escrituras pasan por acá para que el error se muestre en un solo
   * lugar y en castellano. Las dos que se repiten tienen mensaje propio: si no,
   * llegan como "duplicate key value violates unique constraint", que no le dice
   * nada a quien está cargando colores.
   */
  const ejecutar = useCallback(
    // PromiseLike y no Promise: lo que devuelve supabase-js es un builder que se
    // puede esperar, pero no es una Promise de verdad hasta que se hace await.
    async (accion: () => PromiseLike<{ error: { message: string } | null }>) => {
      setOcupado(true);
      setError(null);
      const { error: err } = await accion();
      setOcupado(false);

      if (!err) {
        await onCambio();
        return true;
      }
      if (err.message.includes("duplicate key") || err.message.includes("unico")) {
        setError("Ese nombre ya está en la lista.");
      } else if (err.message.includes("violates foreign key")) {
        setError("No se puede sacar: hay productos que la están usando. Desactivala en vez de borrarla.");
      } else {
        setError(err.message);
      }
      return false;
    },
    [onCambio],
  );

  const pestanas: { id: Pestana; texto: string }[] = [
    { id: "categorias", texto: "Categorías" },
    { id: "talles", texto: "Talles" },
    { id: "colores", texto: "Colores" },
  ];

  return (
    <Modal titulo="Listas del catálogo" ancho="max-w-xl" onCerrar={onCerrar}>
      <div className="mb-3 flex gap-1">
        {pestanas.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              setPestana(p.id);
              setError(null);
            }}
            className="rounded-md px-3 py-1.5 text-[13px] font-medium"
            style={
              pestana === p.id
                ? { background: "var(--primary)", color: "#fff" }
                : { color: "var(--muted-foreground)" }
            }
          >
            {p.texto}
          </button>
        ))}
      </div>

      {error && <div className="mb-3"><Alerta tono="danger">{error}</Alerta></div>}

      {pestana === "categorias" && (
        <PanelCategorias listas={listas} ejecutar={ejecutar} ocupado={ocupado} />
      )}
      {pestana === "talles" && <PanelTalles listas={listas} ejecutar={ejecutar} ocupado={ocupado} />}
      {pestana === "colores" && (
        <PanelColores listas={listas} ejecutar={ejecutar} ocupado={ocupado} />
      )}

      <div className="flex justify-end pt-4">
        <BotonSecundario onClick={onCerrar}>Listo</BotonSecundario>
      </div>
    </Modal>
  );
}

function PanelCategorias({
  listas,
  ejecutar,
  ocupado,
}: {
  listas: Listas;
  ejecutar: Ejecutar;
  ocupado: boolean;
}) {
  const [escalaNueva, setEscalaNueva] = useState("");

  const nombreEscala = (id: string | null) =>
    id ? (listas.escalas.find((e) => e.id === id)?.nombre ?? "—") : "sin talles";

  return (
    <div className="space-y-3">
      <p className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
        Cada categoría dice qué talles se van a ofrecer cuando cargues un producto de ese tipo. Si
        elegís «sin talles», el producto se carga sin talle (una mochila, unos cordones).
      </p>

      <Agregar
        placeholder="Nombre de la categoría"
        ocupado={ocupado}
        onAgregar={(nombre) =>
          ejecutar(() =>
            supa
              .from("categorias")
              .insert({ nombre, escala_talle_id: escalaNueva || null, orden: listas.categorias.length * 10 + 10 }),
          )
        }
      >
        <select
          value={escalaNueva}
          onChange={(e) => setEscalaNueva(e.target.value)}
          className="h-9 rounded-md border px-2 text-[13px]"
          style={inputStyle}
        >
          <option value="">Sin talles</option>
          {listas.escalas.map((e) => (
            <option key={e.id} value={e.id}>
              Talles: {e.nombre}
            </option>
          ))}
        </select>
      </Agregar>

      <div>
        {listas.categorias.map((c) => (
          <Fila
            key={c.id}
            nombre={c.nombre}
            activo={c.activa}
            detalle={nombreEscala(c.escala_talle_id)}
            ocupado={ocupado}
            onRenombrar={(nuevo) =>
              ejecutar(() => supa.from("categorias").update({ nombre: nuevo }).eq("id", c.id))
            }
            onAlternar={() =>
              void ejecutar(() =>
                supa.from("categorias").update({ activa: !c.activa }).eq("id", c.id),
              )
            }
          />
        ))}
        {listas.categorias.length === 0 && (
          <p className="py-4 text-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            Todavía no hay ninguna categoría.
          </p>
        )}
      </div>
    </div>
  );
}

function PanelTalles({
  listas,
  ejecutar,
  ocupado,
}: {
  listas: Listas;
  ejecutar: Ejecutar;
  ocupado: boolean;
}) {
  const [escalaId, setEscalaId] = useState(listas.escalas[0]?.id ?? "");
  const [creandoEscala, setCreandoEscala] = useState(false);

  const delGrupo = useMemo(
    () => listas.talles.filter((t) => t.escala_id === escalaId).sort((a, b) => a.orden - b.orden),
    [listas.talles, escalaId],
  );

  /**
   * El orden se calcula del propio valor cuando es un número: así "35" entra
   * entre "34" y "36" aunque se cargue último. Para escalas no numéricas (S, M,
   * L) se agrega al final, que es lo que se espera al ir escribiéndolas en orden.
   */
  function ordenPara(valor: string) {
    const n = Number(valor.replace(",", "."));
    if (Number.isFinite(n)) return Math.round(n);
    return (delGrupo.at(-1)?.orden ?? 0) + 10;
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
        Los talles van agrupados por escala. El calzado usa 34 a 46; si algún día entra ropa, se
        crea otra escala con S, M y L y no se mezclan en el mismo desplegable.
      </p>

      <div className="flex items-center gap-2">
        <select
          value={escalaId}
          onChange={(e) => setEscalaId(e.target.value)}
          className="h-9 flex-1 rounded-md border px-2 text-[13px]"
          style={inputStyle}
        >
          {listas.escalas.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nombre}
            </option>
          ))}
        </select>
        <BotonSecundario onClick={() => setCreandoEscala((v) => !v)}>
          {creandoEscala ? "Cancelar" : "Nueva escala"}
        </BotonSecundario>
      </div>

      {creandoEscala && (
        <Agregar
          placeholder="Nombre de la escala (Indumentaria)"
          ocupado={ocupado}
          onAgregar={async (nombre) => {
            const ok = await ejecutar(() =>
              supa.from("escalas_talle").insert({ nombre, orden: listas.escalas.length * 10 + 10 }),
            );
            if (ok) setCreandoEscala(false);
            return ok;
          }}
        />
      )}

      {escalaId && (
        <>
          <Agregar
            placeholder="Talle (47)"
            ocupado={ocupado}
            onAgregar={(valor) =>
              ejecutar(() =>
                supa.from("talles").insert({ escala_id: escalaId, valor, orden: ordenPara(valor) }),
              )
            }
          />

          <div>
            {delGrupo.map((t) => (
              <Fila
                key={t.id}
                nombre={t.valor}
                activo={t.activo}
                ocupado={ocupado}
                onRenombrar={(nuevo) =>
                  ejecutar(() =>
                    supa
                      .from("talles")
                      .update({ valor: nuevo, orden: ordenPara(nuevo) })
                      .eq("id", t.id),
                  )
                }
                onAlternar={() =>
                  void ejecutar(() => supa.from("talles").update({ activo: !t.activo }).eq("id", t.id))
                }
              />
            ))}
            {delGrupo.length === 0 && (
              <p className="py-4 text-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                Esta escala todavía no tiene talles.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PanelColores({
  listas,
  ejecutar,
  ocupado,
}: {
  listas: Listas;
  ejecutar: Ejecutar;
  ocupado: boolean;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
        Los colores se cargan una vez y después se eligen al dar de alta un producto. Es lo que
        evita que convivan «Bordó», «bordo» y «Vino» como si fueran tres cosas distintas.
      </p>

      <Agregar
        placeholder="Nombre del color"
        ocupado={ocupado}
        onAgregar={(nombre) =>
          ejecutar(() =>
            supa.from("colores").insert({ nombre, orden: (listas.colores.at(-1)?.orden ?? 0) + 10 }),
          )
        }
      />

      <div className="max-h-72 overflow-y-auto">
        {listas.colores.map((c) => (
          <Fila
            key={c.id}
            nombre={c.nombre}
            activo={c.activo}
            ocupado={ocupado}
            onRenombrar={(nuevo) =>
              ejecutar(() => supa.from("colores").update({ nombre: nuevo }).eq("id", c.id))
            }
            onAlternar={() =>
              void ejecutar(() => supa.from("colores").update({ activo: !c.activo }).eq("id", c.id))
            }
          />
        ))}
        {listas.colores.length === 0 && (
          <p className="py-4 text-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            Todavía no hay ningún color.
          </p>
        )}
      </div>
    </div>
  );
}

/** Botones para elegir de a varios. Un talle o un color: tocás y queda marcado. */
export function Chips({
  opciones,
  elegidas,
  onAlternar,
  vacio,
}: {
  opciones: { id: string; texto: string }[];
  elegidas: Set<string>;
  onAlternar: (texto: string) => void;
  vacio: string;
}) {
  if (opciones.length === 0) {
    return (
      <p className="mt-1 text-[12px] font-normal" style={{ color: "var(--muted-foreground)" }}>
        {vacio}
      </p>
    );
  }

  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {opciones.map((o) => {
        const puesta = elegidas.has(o.texto);
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onAlternar(o.texto)}
            className="rounded-md border px-2.5 py-1 text-[12px] font-normal"
            style={
              puesta
                ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                : inputStyle
            }
          >
            {o.texto}
          </button>
        );
      })}
    </div>
  );
}

export { inputCls };
