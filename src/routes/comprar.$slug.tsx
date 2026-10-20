import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, ShoppingBag } from "lucide-react";
import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";
import { urlFoto, useCarrito } from "@/lib/tienda";
import { Centro, Encabezado, Pie, useConfigTienda } from "./comprar.index";

/**
 * La ficha del producto: la página que se abre cuando alguien toca el link que
 * el local pegó en una historia de Instagram.
 *
 * El talle y el color no son una lista de texto: cada combinación es una
 * variante distinta con su propio stock. Se muestra lo que hay, y lo que no hay
 * se ve gastado en vez de desaparecer, para que el comprador entienda que el
 * producto existe pero ese talle se acabó.
 */

export const Route = createFileRoute("/comprar/$slug")({
  component: Producto,
});

type FilaProducto = {
  producto_id: string;
  slug: string;
  nombre: string;
  marca: string | null;
  categoria: string | null;
  descripcion: string | null;
  descripcion_larga: string | null;
  variante_id: string;
  talle: string | null;
  color: string | null;
  codigo_barras: string | null;
  precio: number;
  disponible: number;
  imagenes: string[] | null;
};

function Producto() {
  const { slug } = Route.useParams();
  const { data: config } = useConfigTienda();
  const { agregar } = useCarrito();
  const navegar = useNavigate();

  const [elegida, setElegida] = useState<string | null>(null);
  const [foto, setFoto] = useState(0);
  const [agregado, setAgregado] = useState(false);

  const { data: filas, isLoading } = useQuery({
    queryKey: ["tienda-producto", slug],
    queryFn: async () => {
      const { data, error } = await supa.rpc("tienda_producto", { p_slug: slug });
      if (error) throw error;
      return (data as FilaProducto[]) ?? [];
    },
  });

  const cabeza = filas?.[0] ?? null;
  const imagenes = useMemo(() => cabeza?.imagenes ?? [], [cabeza]);

  // Si hay una sola variante no tiene sentido hacerla elegir: ya está elegida.
  const variante = useMemo(() => {
    if (!filas || filas.length === 0) return null;
    if (elegida) return filas.find((f) => f.variante_id === elegida) ?? null;
    if (filas.length === 1) return filas[0];
    return null;
  }, [filas, elegida]);

  if (isLoading) return <Centro>Buscando el producto…</Centro>;

  if (!cabeza || !config) {
    return (
      <Centro>
        <div className="text-[15px] font-semibold">No encontramos este producto</div>
        <p className="mt-1.5 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
          Puede que ya no esté publicado. Mirá el resto de la tienda, capaz encontrás algo parecido.
        </p>
        <Link
          to="/comprar"
          className="mt-4 inline-flex h-10 items-center rounded-md px-4 text-[13px] font-medium text-white"
          style={{ background: "var(--primary)" }}
        >
          Ver la tienda
        </Link>
      </Centro>
    );
  }

  const hayStock = filas!.some((f) => f.disponible > 0);

  const alAgregar = () => {
    if (!variante || variante.disponible <= 0) return;
    agregar({
      variante_id: variante.variante_id,
      slug: cabeza.slug,
      producto: cabeza.nombre,
      talle: variante.talle,
      color: variante.color,
      precio: Number(variante.precio),
      cantidad: 1,
      imagen: imagenes[0] ?? null,
      disponible: variante.disponible,
    });
    setAgregado(true);
    // Se avisa que quedó guardado y recién después se vuelve al catálogo: si
    // salta de golpe, nadie está seguro de que lo haya agregado.
    setTimeout(() => void navegar({ to: "/comprar" }), 900);
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--background)" }}>
      <Encabezado config={config} />

      <main className="mx-auto max-w-5xl px-4 pb-16">
        <Link
          to="/comprar"
          className="mt-4 inline-flex items-center gap-1.5 text-[13px]"
          style={{ color: "var(--muted-foreground)" }}
        >
          <ArrowLeft size={14} /> Volver
        </Link>

        <div className="mt-3 grid gap-6 md:grid-cols-2">
          <div>
            <div className="overflow-hidden rounded-lg" style={{ background: "#f1f3f8" }}>
              {imagenes.length > 0 ? (
                <img src={urlFoto(imagenes[foto])} alt={cabeza.nombre} className="aspect-square w-full object-cover" />
              ) : (
                <div className="grid aspect-square place-items-center" style={{ color: "var(--muted-foreground)" }}>
                  <ShoppingBag size={30} />
                </div>
              )}
            </div>
            {imagenes.length > 1 && (
              <div className="mt-2 flex gap-2 overflow-x-auto">
                {imagenes.map((ruta, i) => (
                  <button
                    key={ruta}
                    onClick={() => setFoto(i)}
                    className="h-16 w-16 shrink-0 overflow-hidden rounded-md border"
                    style={{ borderColor: i === foto ? "var(--primary)" : "var(--border)" }}
                  >
                    <img src={urlFoto(ruta)} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            {cabeza.marca && (
              <div className="text-[12px] uppercase tracking-wide" style={{ color: "var(--muted-foreground)" }}>
                {cabeza.marca}
              </div>
            )}
            <h1 className="text-[22px] font-semibold leading-tight">{cabeza.nombre}</h1>
            {cabeza.descripcion && (
              <p className="mt-1.5 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                {cabeza.descripcion}
              </p>
            )}

            <div className="mt-3 text-[24px] font-semibold tabular">
              {formatARS(Number((variante ?? filas![0]).precio))}
            </div>

            {filas!.length > 1 && (
              <div className="mt-5">
                <div className="text-[12px] font-medium">Elegí una opción</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {filas!.map((f) => {
                    const sinStock = f.disponible <= 0;
                    const activo = variante?.variante_id === f.variante_id;
                    return (
                      <button
                        key={f.variante_id}
                        disabled={sinStock}
                        onClick={() => {
                          setElegida(f.variante_id);
                          setAgregado(false);
                        }}
                        className="rounded-md border px-3 py-2 text-[13px] disabled:cursor-not-allowed disabled:opacity-45 disabled:line-through"
                        style={
                          activo
                            ? { borderColor: "var(--primary)", background: "#fdf3ef", color: "var(--primary)" }
                            : { borderColor: "var(--border)", background: "var(--surface)" }
                        }
                      >
                        {[f.talle, f.color].filter(Boolean).join(" · ") || "Único"}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {variante && variante.disponible > 0 && variante.disponible <= 3 && (
              <p className="mt-3 text-[12px]" style={{ color: "var(--warning)" }}>
                Quedan {variante.disponible}.
              </p>
            )}

            <button
              disabled={!hayStock || !variante || variante.disponible <= 0}
              onClick={alAgregar}
              className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-md text-[14px] font-medium text-white disabled:opacity-45 md:w-auto md:px-8"
              style={{ background: agregado ? "var(--success)" : "var(--primary)" }}
            >
              {agregado ? (
                <>
                  <Check size={15} /> Agregado
                </>
              ) : !hayStock ? (
                "Sin stock por ahora"
              ) : !variante ? (
                "Elegí una opción"
              ) : (
                "Agregar al carrito"
              )}
            </button>

            {cabeza.descripcion_larga && (
              <div className="mt-6 whitespace-pre-line text-[13px] leading-relaxed">
                {cabeza.descripcion_larga}
              </div>
            )}

            <div className="mt-6 grid gap-1.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              {config.retiro_habilitado && <div>Podés retirarlo por el local.</div>}
              {config.envio_habilitado && (
                <div>
                  Hacemos envíos
                  {config.zona_envio ? ` en ${config.zona_envio}` : ""}
                  {config.envio_gratis_desde != null
                    ? `, gratis desde ${formatARS(Number(config.envio_gratis_desde))}`
                    : ""}
                  .
                </div>
              )}
            </div>
          </div>
        </div>

        <Pie config={config} />
      </main>
    </div>
  );
}
