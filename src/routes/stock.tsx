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
import {
  Chips,
  DialogoListas,
  tallesDeCategoria,
  useListasCatalogo,
  type Listas,
} from "@/components/catalogo/ListasCatalogo";
import { DialogoEditarProducto } from "@/components/catalogo/DialogoEditarProducto";
import { useSesion, useSucursalOperativa, type Sucursal } from "@/lib/sesion";
import { supa } from "@/lib/supabase";
import { formatARS, formatNum } from "@/lib/format";
import { ListTree, Loader2, PackagePlus, PackageSearch, Plus, TriangleAlert } from "lucide-react";

export const Route = createFileRoute("/stock")({
  head: () => ({
    meta: [
      { title: "Stock — PymeOS" },
      { name: "description", content: "Inventario de productos por sucursal, con alertas de stock bajo." },
    ],
  }),
  // Lo que se escribió en el buscador del encabezado llega acá ya filtrado.
  validateSearch: (s: Record<string, unknown>): { q?: string } => ({
    q: typeof s.q === "string" ? s.q : undefined,
  }),
  component: Stock,
});

type FilaStock = { sucursal_id: string; cantidad: number };

type Variante = {
  id: string;
  talle: string | null;
  color: string | null;
  sku: string | null;
  codigo_barras: string | null;
  precio: number;
  costo: number | null;
  activa: boolean;
  stock: FilaStock[];
};

type Producto = {
  id: string;
  nombre: string;
  marca: string | null;
  categorias: { nombre: string } | null;
  activo: boolean;
  variantes: Variante[];
};

/** Una fila de la tabla: siempre una variante, nunca un modelo. */
type Fila = { producto: Producto; variante: Variante };

const SELECT_CATALOGO =
  "id, nombre, marca, activo, categorias ( nombre ), " +
  "variantes ( id, talle, color, sku, codigo_barras, precio, costo, activa, " +
  "stock ( sucursal_id, cantidad ) )";

function cantidadEn(v: Variante, sucursalId: string) {
  return v.stock.find((s) => s.sucursal_id === sucursalId)?.cantidad ?? 0;
}

function totalDe(v: Variante) {
  return v.stock.reduce((s, f) => s + f.cantidad, 0);
}

function Stock() {
  const { usuario, sucursales } = useSesion();
  const sucursalOperativa = useSucursalOperativa();

  const [productos, setProductos] = useState<Producto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState(Route.useSearch().q ?? "");
  const [marca, setMarca] = useState("todas");
  const [soloFaltantes, setSoloFaltantes] = useState(false);
  const [creando, setCreando] = useState(false);
  const [ajustando, setAjustando] = useState<Fila | null>(null);
  const [editando, setEditando] = useState<Producto | null>(null);
  const [editandoListas, setEditandoListas] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const { listas, recargar: recargarListas } = useListasCatalogo();

  const esDueno = usuario?.rol === "dueno";
  const columnas = useMemo(() => sucursales.filter((s) => s.activa), [sucursales]);

  const cargar = useCallback(async () => {
    const { data, error } = await supa.from("productos").select(SELECT_CATALOGO).order("nombre");

    if (error) setErrorCarga(error.message);
    else {
      setErrorCarga(null);
      setProductos((data ?? []) as unknown as Producto[]);
    }
    setCargando(false);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const filas: Fila[] = useMemo(() => {
    const todas = productos.flatMap((p) =>
      [...p.variantes]
        .sort((a, b) => (a.talle ?? "").localeCompare(b.talle ?? "", "es", { numeric: true }))
        .map((v) => ({ producto: p, variante: v })),
    );

    const texto = busqueda.trim().toLowerCase();

    return todas.filter(({ producto, variante }) => {
      if (marca !== "todas" && (producto.marca ?? "sin marca") !== marca) return false;
      if (soloFaltantes && totalDe(variante) >= 0) return false;
      if (!texto) return true;

      // El código de barras se compara exacto: la pistola escribe el código entero
      // y de golpe. Lo demás va por "contiene", que es como busca una persona.
      if (variante.codigo_barras?.toLowerCase() === texto) return true;

      return [
        producto.nombre,
        producto.marca,
        producto.categorias?.nombre,
        variante.talle,
        variante.color,
        variante.sku,
      ]
        .filter(Boolean)
        .some((campo) => (campo as string).toLowerCase().includes(texto));
    });
  }, [productos, busqueda, marca, soloFaltantes]);

  const marcas = useMemo(
    () => ["todas", ...Array.from(new Set(productos.map((p) => p.marca ?? "sin marca"))).sort()],
    [productos],
  );

  const totalVariantes = productos.reduce((s, p) => s + p.variantes.length, 0);
  const totalUnidades = productos.reduce(
    (s, p) => s + p.variantes.reduce((t, v) => t + totalDe(v), 0),
    0,
  );
  const enNegativo = productos.reduce(
    (s, p) => s + p.variantes.filter((v) => totalDe(v) < 0).length,
    0,
  );

  if (cargando) {
    return (
      <div
        className="flex h-40 items-center justify-center gap-2 text-[13px]"
        style={{ color: "var(--muted-foreground)" }}
      >
        <Loader2 size={16} className="animate-spin" /> Cargando el catálogo…
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Stock"
        subtitle={
          totalVariantes === 0
            ? "El catálogo todavía está vacío"
            : `${formatNum(totalVariantes)} variantes · ${formatNum(totalUnidades)} unidades` +
              (enNegativo > 0 ? ` · ${enNegativo} en negativo` : "")
        }
        actions={
          esDueno ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setEditandoListas(true)}
                className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px]"
                style={inputStyle}
              >
                <ListTree size={14} /> Categorías, talles y colores
              </button>
              <button
                onClick={() => setCreando(true)}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white"
                style={{ background: "var(--primary)" }}
              >
                <PackagePlus size={14} /> Nuevo producto
              </button>
            </div>
          ) : undefined
        }
      />

      {errorCarga && <div className="mb-3"><Alerta tono="danger">No se pudo leer el catálogo: {errorCarga}</Alerta></div>}
      {aviso && <div className="mb-3"><Alerta tono="info">{aviso}</Alerta></div>}

      {enNegativo > 0 && (
        <div className="mb-3">
          <Alerta tono="warning">
            Hay {enNegativo} {enNegativo === 1 ? "variante" : "variantes"} con stock negativo. No es
            un error del sistema: es mercadería que se vendió sin estar cargada. Contala y corregila
            con «Contar».
          </Alerta>
        </div>
      )}

      {totalVariantes === 0 ? (
        <CatalogoVacio esDueno={esDueno} onCrear={() => setCreando(true)} />
      ) : (
        <div className="card-surface overflow-hidden">
          <div
            className="flex items-center gap-2 px-4 py-3"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por nombre, marca, SKU, color o código de barras…"
              className="h-8 flex-1 rounded-md border px-3 text-[13px] outline-none"
              style={inputStyle}
            />
            <select
              value={marca}
              onChange={(e) => setMarca(e.target.value)}
              className="h-8 rounded-md border px-2 text-[13px]"
              style={inputStyle}
            >
              {marcas.map((m) => (
                <option key={m} value={m}>
                  Marca: {m}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-[13px]">
              <input
                type="checkbox"
                checked={soloFaltantes}
                onChange={(e) => setSoloFaltantes(e.target.checked)}
              />
              Solo negativos
            </label>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead style={{ background: "#f9fafc" }}>
                <tr style={{ color: "var(--muted-foreground)" }}>
                  <th className="px-3 py-2 text-left font-medium">Producto</th>
                  <th className="px-3 py-2 text-left font-medium">Marca</th>
                  <th className="px-3 py-2 text-left font-medium">Talle</th>
                  <th className="px-3 py-2 text-left font-medium">Color</th>
                  <th className="px-3 py-2 text-right font-medium">Costo</th>
                  <th className="px-3 py-2 text-right font-medium">Precio</th>
                  {columnas.map((s) => (
                    <th key={s.id} className="px-3 py-2 text-right font-medium">
                      {s.alias}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {filas.map(({ producto, variante }) => {
                  const total = totalDe(variante);
                  const negativo = total < 0;
                  const bajo = !negativo && total <= 3;

                  return (
                    <tr
                      key={variante.id}
                      style={{
                        borderTop: "1px solid var(--border)",
                        background: negativo
                          ? "var(--danger-bg)"
                          : bajo
                            ? "var(--warning-bg)"
                            : "transparent",
                      }}
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium">{producto.nombre}</div>
                        {(variante.sku || variante.codigo_barras) && (
                          <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                            {variante.sku ?? variante.codigo_barras}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">{producto.marca ?? "—"}</td>
                      <td className="px-3 py-2 tabular">{variante.talle ?? "—"}</td>
                      <td className="px-3 py-2">{variante.color ?? "—"}</td>
                      <td
                        className="px-3 py-2 text-right tabular"
                        style={{ color: "var(--muted-foreground)" }}
                      >
                        {variante.costo === null ? "—" : formatARS(variante.costo)}
                      </td>
                      <td className="px-3 py-2 text-right tabular font-medium">
                        {formatARS(variante.precio)}
                      </td>
                      {columnas.map((s) => (
                        <td key={s.id} className="px-3 py-2 text-right tabular">
                          {cantidadEn(variante, s.id)}
                        </td>
                      ))}
                      <td
                        className="px-3 py-2 text-right tabular font-semibold"
                        style={{
                          color: negativo
                            ? "var(--danger)"
                            : bajo
                              ? "var(--warning)"
                              : "var(--foreground)",
                        }}
                      >
                        {negativo && <TriangleAlert size={12} className="mr-1 inline" />}
                        {total}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => setAjustando({ producto, variante })}
                          disabled={!sucursalOperativa}
                          title={
                            sucursalOperativa
                              ? `Contar en ${sucursalOperativa.alias}`
                              : "Este equipo no tiene una sucursal activa"
                          }
                          className="rounded-md border px-2 py-1 text-[12px] disabled:opacity-40"
                          style={inputStyle}
                        >
                          Contar
                        </button>
                        {/* Solo el dueño: la política `productos_escribe_dueno`
                            lo rechaza igual, esto evita el intento. */}
                        {esDueno && (
                          <button
                            onClick={() => setEditando(producto)}
                            title={`Editar ${producto.nombre}`}
                            className="ml-1 rounded-md border px-2 py-1 text-[12px]"
                            style={inputStyle}
                          >
                            Editar
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {filas.length === 0 && (
                  <tr>
                    <td
                      colSpan={8 + columnas.length}
                      className="px-3 py-10 text-center text-[13px]"
                      style={{ color: "var(--muted-foreground)" }}
                    >
                      Ninguna variante coincide con la búsqueda.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!sucursalOperativa && totalVariantes > 0 && (
        <div className="mt-3">
          <Alerta tono="warning">
            Estás mirando las dos sucursales juntas, o este equipo no tiene ninguna activa. Podés
            ver los números, pero no tocar cantidades: un movimiento siempre se guarda en la
            sucursal de la computadora.
          </Alerta>
        </div>
      )}

      {creando && (
        <DialogoNuevoProducto
          listas={listas}
          onRecargarListas={recargarListas}
          onCerrar={() => setCreando(false)}
          onListo={(msg) => {
            setCreando(false);
            setAviso(msg);
            void cargar();
          }}
        />
      )}

      {editandoListas && (
        <DialogoListas
          listas={listas}
          onCambio={recargarListas}
          onCerrar={() => {
            setEditandoListas(false);
            void cargar();
          }}
        />
      )}

      {editando && (
        <DialogoEditarProducto
          producto={editando}
          onCerrar={() => setEditando(null)}
          onListo={(msg) => {
            setEditando(null);
            setAviso(msg);
            void cargar();
          }}
        />
      )}

      {ajustando && sucursalOperativa && usuario && (
        <DialogoContar
          fila={ajustando}
          sucursal={sucursalOperativa}
          usuarioId={usuario.user_id}
          onCerrar={() => setAjustando(null)}
          onListo={(msg) => {
            setAjustando(null);
            setAviso(msg);
            void cargar();
          }}
        />
      )}
    </>
  );
}

function CatalogoVacio({ esDueno, onCrear }: { esDueno: boolean; onCrear: () => void }) {
  return (
    <div className="card-surface flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div
        className="grid h-12 w-12 place-items-center rounded-full"
        style={{ background: "#fdf3ef", color: "var(--primary)" }}
      >
        <PackageSearch size={22} />
      </div>
      <div className="text-[15px] font-semibold">Todavía no hay nada cargado</div>
      <p className="max-w-md text-[13px]" style={{ color: "var(--muted-foreground)" }}>
        El catálogo es uno solo para las dos sucursales: lo que cambia es cuánto hay de cada cosa en
        cada local. Se carga primero el modelo con todos sus talles, y las cantidades después, con
        el conteo físico.
      </p>
      {esDueno && (
        <button
          onClick={onCrear}
          className="mt-1 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white"
          style={{ background: "var(--primary)" }}
        >
          <Plus size={14} /> Cargar el primer producto
        </button>
      )}
    </div>
  );
}

function DialogoNuevoProducto({
  listas,
  onRecargarListas,
  onCerrar,
  onListo,
}: {
  listas: Listas;
  onRecargarListas: () => Promise<void> | void;
  onCerrar: () => void;
  onListo: (mensaje: string) => void;
}) {
  const [nombre, setNombre] = useState("");
  const [marca, setMarca] = useState("");
  const [categoriaId, setCategoriaId] = useState("");
  const [talles, setTalles] = useState<string[]>([]);
  const [colores, setColores] = useState<string[]>([]);
  const [precio, setPrecio] = useState("");
  const [costo, setCosto] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [editandoListas, setEditandoListas] = useState(false);

  const categoriasActivas = listas.categorias.filter((c) => c.activa);
  const opcionesTalle = tallesDeCategoria(listas, categoriaId || null).map((t) => ({
    id: t.id,
    texto: t.valor,
  }));
  const opcionesColor = listas.colores
    .filter((c) => c.activo)
    .map((c) => ({ id: c.id, texto: c.nombre }));

  const listaTalles = talles;
  const listaColores = colores;
  // Sin talles ni colores igual hay UNA variante: es lo que se vende. Un producto
  // sin variantes no existiría para el sistema.
  const combinaciones = Math.max(1, listaTalles.length) * Math.max(1, listaColores.length);

  /** Tocar un talle o un color lo pone y lo saca. Se guardan en el orden de la lista. */
  function alternar(lista: string[], valor: string, orden: { texto: string }[]) {
    const puesto = lista.includes(valor);
    const nueva = puesto ? lista.filter((v) => v !== valor) : [...lista, valor];
    return orden.map((o) => o.texto).filter((t) => nueva.includes(t));
  }

  async function guardar(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);

    const precioNum = Number(precio);
    if (!Number.isFinite(precioNum) || precioNum < 0) {
      setError("El precio tiene que ser un número.");
      return;
    }
    const costoNum = costo.trim() === "" ? null : Number(costo);
    if (costoNum !== null && (!Number.isFinite(costoNum) || costoNum < 0)) {
      setError("El costo tiene que ser un número, o quedar vacío.");
      return;
    }

    setGuardando(true);

    const { data: prod, error: errProd } = await supa
      .from("productos")
      .insert({
        nombre: nombre.trim(),
        marca: marca.trim() || null,
        categoria_id: categoriaId || null,
      })
      .select("id")
      .single();

    if (errProd || !prod) {
      setGuardando(false);
      setError(errProd?.message ?? "No se pudo crear el producto.");
      return;
    }

    const filas = (listaTalles.length ? listaTalles : [null]).flatMap((t) =>
      (listaColores.length ? listaColores : [null]).map((c) => ({
        producto_id: prod.id,
        talle: t,
        color: c,
        precio: precioNum,
        costo: costoNum,
      })),
    );

    const { error: errVar } = await supa.from("variantes").insert(filas);
    setGuardando(false);

    if (errVar) {
      // El producto quedó creado y sin variantes. Se avisa en vez de esconderlo:
      // borrar por atrás sería peor, y el dueño puede volver a intentar los talles.
      setError(
        `Se creó el modelo pero fallaron los talles: ${errVar.message}. Revisá que no haya talles repetidos.`,
      );
      return;
    }

    onListo(
      `${nombre.trim()}: ${filas.length} ${filas.length === 1 ? "variante creada" : "variantes creadas"}, en 0 en las dos sucursales.`,
    );
  }

  return (
    <Modal titulo="Nuevo producto" ancho="max-w-lg" onCerrar={onCerrar}>
      <form onSubmit={guardar} className="space-y-3">
        <label className="block text-[12px] font-medium">
          Nombre del modelo
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
            className={inputCls}
            style={inputStyle}
            placeholder="Zapatilla Nike Revolution"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-[12px] font-medium">
            Marca
            <input
              value={marca}
              onChange={(e) => setMarca(e.target.value)}
              className={inputCls}
              style={inputStyle}
              placeholder="Nike"
            />
          </label>
          <label className="block text-[12px] font-medium">
            Categoría
            <select
              value={categoriaId}
              onChange={(e) => {
                setCategoriaId(e.target.value);
                // Los talles dependen de la categoría: si cambia, lo elegido antes
                // puede no existir en la escala nueva.
                setTalles([]);
              }}
              required
              className={inputCls}
              style={inputStyle}
            >
              <option value="">Elegí una…</option>
              {categoriasActivas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="text-[12px] font-medium">
          <div className="flex items-center justify-between">
            <span>Talles</span>
            {opcionesTalle.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  setTalles(
                    talles.length === opcionesTalle.length
                      ? []
                      : opcionesTalle.map((o) => o.texto),
                  )
                }
                className="font-normal underline"
                style={{ color: "var(--muted-foreground)" }}
              >
                {talles.length === opcionesTalle.length ? "Ninguno" : "Todos"}
              </button>
            )}
          </div>
          <Chips
            opciones={opcionesTalle}
            elegidas={new Set(talles)}
            onAlternar={(t) => setTalles(alternar(talles, t, opcionesTalle))}
            vacio={
              categoriaId
                ? "Esta categoría no lleva talles. El producto se carga como uno solo."
                : "Elegí primero la categoría: de ahí salen los talles que corresponden."
            }
          />
        </div>

        <div className="text-[12px] font-medium">
          Colores
          <Chips
            opciones={opcionesColor}
            elegidas={new Set(colores)}
            onAlternar={(c) => setColores(alternar(colores, c, opcionesColor))}
            vacio="Todavía no hay colores cargados."
          />
        </div>

        <button
          type="button"
          onClick={() => setEditandoListas(true)}
          className="text-[12px] underline"
          style={{ color: "var(--muted-foreground)" }}
        >
          ¿Falta una categoría, un talle o un color? Editá las listas
        </button>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-[12px] font-medium">
            Precio de venta
            <input
              value={precio}
              onChange={(e) => setPrecio(e.target.value)}
              required
              inputMode="decimal"
              className={inputCls}
              style={inputStyle}
              placeholder="85000"
            />
          </label>
          <label className="block text-[12px] font-medium">
            Costo (opcional)
            <input
              value={costo}
              onChange={(e) => setCosto(e.target.value)}
              inputMode="decimal"
              className={inputCls}
              style={inputStyle}
              placeholder="52000"
            />
          </label>
        </div>

        <Alerta tono="info">
          Se van a crear <strong>{combinaciones}</strong>{" "}
          {combinaciones === 1 ? "variante" : "variantes"}, todas con el mismo precio y en 0 en las
          dos sucursales. Después se ajusta lo que haga falta, una por una.
        </Alerta>

        {error && <Alerta tono="danger">{error}</Alerta>}

        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={guardando}>Crear producto</BotonPrimario>
        </div>
      </form>

      {/* Va afuera del form a propósito: un form adentro de otro no es HTML válido. */}
      {editandoListas && (
        <DialogoListas
          listas={listas}
          inicial="categorias"
          onCambio={onRecargarListas}
          onCerrar={() => setEditandoListas(false)}
        />
      )}
    </Modal>
  );
}

function DialogoContar({
  fila,
  sucursal,
  usuarioId,
  onCerrar,
  onListo,
}: {
  fila: Fila;
  sucursal: Sucursal;
  usuarioId: string;
  onCerrar: () => void;
  onListo: (mensaje: string) => void;
}) {
  const actual = cantidadEn(fila.variante, sucursal.id);
  const primeraCarga = actual === 0;

  const [contado, setContado] = useState("");
  const [nota, setNota] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const campo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    campo.current?.focus();
  }, []);

  const nuevo = Number(contado);
  const valido = contado.trim() !== "" && Number.isInteger(nuevo);
  const diferencia = valido ? nuevo - actual : 0;

  async function guardar(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);

    if (!valido) {
      setError("Escribí cuántas unidades contaste, en número entero.");
      return;
    }
    if (diferencia === 0) {
      setError("El sistema ya dice esa cantidad. No hay nada que corregir.");
      return;
    }

    setGuardando(true);
    // El stock no se edita: se inserta el movimiento y el trigger acomoda la
    // cantidad. Así el número siempre tiene una explicación atrás.
    const { error: err } = await supa.from("movimientos_stock").insert({
      variante_id: fila.variante.id,
      sucursal_id: sucursal.id,
      cantidad: diferencia,
      motivo: primeraCarga ? "inventario_inicial" : "ajuste",
      nota: nota.trim() || null,
      usuario_id: usuarioId,
    });
    setGuardando(false);

    if (err) setError(err.message);
    else
      onListo(
        `${fila.producto.nombre} ${fila.variante.talle ?? ""} ${fila.variante.color ?? ""}`.trim() +
          `: ${actual} → ${nuevo} en ${sucursal.alias}.`,
      );
  }

  return (
    <Modal titulo="Contar mercadería" onCerrar={onCerrar}>
      <form onSubmit={guardar} className="space-y-3">
        <div>
          <div className="text-[14px] font-semibold">{fila.producto.nombre}</div>
          <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            {[fila.variante.talle, fila.variante.color].filter(Boolean).join(" · ") ||
              "sin talle ni color"}{" "}
            · {sucursal.alias}
          </div>
        </div>

        <div
          className="flex items-center justify-between rounded-md px-3 py-2 text-[13px]"
          style={{ background: "#f9fafc" }}
        >
          <span style={{ color: "var(--muted-foreground)" }}>El sistema dice</span>
          <span className="tabular font-semibold">{actual}</span>
        </div>

        <label className="block text-[12px] font-medium">
          ¿Cuántas contaste?
          <input
            ref={campo}
            value={contado}
            onChange={(e) => setContado(e.target.value)}
            inputMode="numeric"
            className={inputCls}
            style={inputStyle}
            placeholder="12"
          />
        </label>

        <label className="block text-[12px] font-medium">
          Nota (opcional)
          <input
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            className={inputCls}
            style={inputStyle}
            placeholder="Conteo del sábado"
          />
        </label>

        {valido && diferencia !== 0 && (
          <Alerta tono="info">
            Se registra un movimiento de{" "}
            <strong>
              {diferencia > 0 ? "+" : ""}
              {diferencia}
            </strong>{" "}
            en {sucursal.alias}, como{" "}
            {primeraCarga ? "conteo inicial" : "ajuste"}. Queda con tu nombre y la fecha, y no se
            puede borrar: para corregirlo se cuenta de nuevo.
          </Alerta>
        )}

        {error && <Alerta tono="danger">{error}</Alerta>}

        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={guardando}>Guardar el conteo</BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}
