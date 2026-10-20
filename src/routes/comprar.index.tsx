import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Instagram, Loader2, Minus, Plus, Search, ShoppingBag, Store, Trash2, X } from "lucide-react";
import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";
import { urlFoto, useCarrito, type ItemCarrito } from "@/lib/tienda";

/**
 * La tienda: la vidriera que se comparte por Instagram, Facebook o WhatsApp.
 *
 * No hay login ni cuenta. Nadie deja un dato hasta que decide comprar, y recién
 * ahí se crea el pedido: hasta entonces el carrito vive en su propio navegador.
 *
 * Todo lo que se ve acá sale de lo que el local configuró en PymeOS. No hay un
 * segundo catálogo ni un segundo stock: es la misma base, mirada desde afuera.
 */

export const Route = createFileRoute("/comprar/")({
  head: () => ({
    meta: [
      { title: "Tienda online" },
      { name: "description", content: "Comprá online y retiralo por el local o recibilo en tu casa." },
    ],
  }),
  component: Comprar,
});

export type ConfigTienda = {
  activa: boolean;
  nombre: string | null;
  slug: string | null;
  descripcion: string | null;
  whatsapp: string | null;
  instagram: string | null;
  email_contacto: string | null;
  retiro_habilitado: boolean;
  envio_habilitado: boolean;
  costo_envio: number | null;
  envio_gratis_desde: number | null;
  zona_envio: string | null;
  mp_habilitado: boolean;
  texto_retiro: string | null;
  direccion_local: string | null;
  lat: number | null;
  lng: number | null;
};

type ItemCatalogo = {
  producto_id: string;
  slug: string;
  nombre: string;
  marca: string | null;
  categoria: string | null;
  destacado: boolean;
  precio_min: number;
  precio_max: number;
  disponible: number;
  imagen: string | null;
};

export function useConfigTienda() {
  return useQuery({
    queryKey: ["tienda-config"],
    queryFn: async () => {
      const { data, error } = await supa.rpc("tienda_config");
      if (error) throw error;
      return ((data as ConfigTienda[]) ?? [])[0] ?? null;
    },
  });
}

function Comprar() {
  const { data: config, isLoading } = useConfigTienda();
  const [buscar, setBuscar] = useState("");
  const [categoria, setCategoria] = useState<string | null>(null);
  const [verCarrito, setVerCarrito] = useState(false);

  // Se espera a que la persona deje de tipear: cada tecla no tiene por qué ser
  // una consulta a la base.
  const [busquedaFirme, setBusquedaFirme] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setBusquedaFirme(buscar), 300);
    return () => clearTimeout(t);
  }, [buscar]);

  const { data: catalogo, isLoading: cargandoCatalogo } = useQuery({
    queryKey: ["tienda-catalogo", busquedaFirme],
    enabled: config?.activa === true,
    queryFn: async () => {
      const { data, error } = await supa.rpc("tienda_catalogo", {
        p_buscar: busquedaFirme || null,
        p_categoria_id: null,
      });
      if (error) throw error;
      return (data as ItemCatalogo[]) ?? [];
    },
  });

  const categorias = useMemo(() => {
    const vistas = new Set<string>();
    for (const p of catalogo ?? []) if (p.categoria) vistas.add(p.categoria);
    return [...vistas].sort((a, b) => a.localeCompare(b, "es"));
  }, [catalogo]);

  const productos = useMemo(
    () => (catalogo ?? []).filter((p) => !categoria || p.categoria === categoria),
    [catalogo, categoria],
  );

  if (isLoading) return <Centro>Abriendo la tienda…</Centro>;

  if (!config || !config.activa) {
    return (
      <Centro>
        <div className="text-[15px] font-semibold">La tienda está cerrada</div>
        <p className="mt-1.5 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
          Volvé en un rato. Si necesitás algo ahora, escribinos y te atendemos.
        </p>
      </Centro>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--background)" }}>
      <Encabezado config={config} onCarrito={() => setVerCarrito(true)} />

      <main className="mx-auto max-w-5xl px-4 pb-16">
        {config.descripcion && (
          <p className="pt-4 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            {config.descripcion}
          </p>
        )}

        <div className="sticky top-[57px] z-20 -mx-4 px-4 py-3" style={{ background: "var(--background)" }}>
          <div className="relative">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: "var(--muted-foreground)" }}
            />
            <input
              value={buscar}
              onChange={(e) => setBuscar(e.target.value)}
              placeholder="Buscar por nombre o marca"
              className="h-11 w-full rounded-full border pl-9 pr-3 text-[14px] outline-none"
              style={{ borderColor: "var(--border)", background: "var(--surface)" }}
            />
          </div>

          {categorias.length > 0 && (
            <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-0.5">
              <Filtro activo={categoria === null} onClick={() => setCategoria(null)}>
                Todo
              </Filtro>
              {categorias.map((c) => (
                <Filtro key={c} activo={categoria === c} onClick={() => setCategoria(c)}>
                  {c}
                </Filtro>
              ))}
            </div>
          )}
        </div>

        {cargandoCatalogo ? (
          <Vacio>Buscando…</Vacio>
        ) : productos.length === 0 ? (
          <Vacio>
            {busquedaFirme
              ? `No encontramos nada con "${busquedaFirme}".`
              : "Todavía no hay productos publicados."}
          </Vacio>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {productos.map((p) => (
              <Link
                key={p.producto_id}
                to="/comprar/$slug"
                params={{ slug: p.slug }}
                className="card-surface overflow-hidden"
                style={{ background: "var(--surface)" }}
              >
                <div className="aspect-square w-full" style={{ background: "#f1f3f8" }}>
                  {p.imagen ? (
                    <img
                      src={urlFoto(p.imagen)}
                      alt={p.nombre}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="grid h-full place-items-center" style={{ color: "var(--muted-foreground)" }}>
                      <ShoppingBag size={22} />
                    </div>
                  )}
                </div>
                <div className="p-2.5">
                  {p.marca && (
                    <div className="text-[11px] uppercase" style={{ color: "var(--muted-foreground)" }}>
                      {p.marca}
                    </div>
                  )}
                  <div className="text-[13px] font-medium leading-tight">{p.nombre}</div>
                  <div className="mt-1 text-[14px] font-semibold tabular">
                    {p.precio_min === p.precio_max
                      ? formatARS(Number(p.precio_min))
                      : `desde ${formatARS(Number(p.precio_min))}`}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}

        <Pie config={config} />
      </main>

      {verCarrito && <Carrito config={config} onCerrar={() => setVerCarrito(false)} />}
    </div>
  );
}

export function Encabezado({ config, onCarrito }: { config: ConfigTienda; onCarrito?: () => void }) {
  const { unidades } = useCarrito();
  return (
    <header
      className="sticky top-0 z-30 border-b"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4">
        <Link to="/comprar" className="flex min-w-0 items-center gap-2">
          <span
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-white"
            style={{ background: "var(--primary)" }}
          >
            <Store size={15} />
          </span>
          <span className="truncate text-[15px] font-semibold">{config.nombre ?? "Tienda"}</span>
        </Link>
        <div className="ml-auto" />
        {onCarrito && (
          <button
            onClick={onCarrito}
            className="relative flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium text-white"
            style={{ background: "var(--primary)" }}
          >
            <ShoppingBag size={14} />
            Carrito
            {unidades > 0 && (
              <span
                className="grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-semibold"
                style={{ background: "rgba(255,255,255,0.25)" }}
              >
                {unidades}
              </span>
            )}
          </button>
        )}
      </div>
    </header>
  );
}

function Filtro({
  activo,
  onClick,
  children,
}: {
  activo: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-medium"
      style={
        activo
          ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
          : { background: "var(--surface)", borderColor: "var(--border)" }
      }
    >
      {children}
    </button>
  );
}

export function Pie({ config }: { config: ConfigTienda }) {
  const wpp = config.whatsapp?.replace(/\D/g, "");
  return (
    <footer className="mt-10 border-t pt-5 text-[12px]" style={{ borderColor: "var(--border)", color: "var(--muted-foreground)" }}>
      {config.direccion_local && <div>{config.direccion_local}</div>}
      <div className="mt-2 flex flex-wrap gap-3">
        {wpp && (
          <a href={`https://wa.me/${wpp}`} target="_blank" rel="noreferrer" style={{ color: "var(--primary)" }}>
            WhatsApp
          </a>
        )}
        {config.instagram && (
          <a
            href={`https://instagram.com/${config.instagram.replace(/^@/, "")}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1"
            style={{ color: "var(--primary)" }}
          >
            <Instagram size={12} /> {config.instagram}
          </a>
        )}
        {config.email_contacto && <span>{config.email_contacto}</span>}
      </div>
    </footer>
  );
}

/**
 * El carrito y la compra, en la misma hoja: en un celular, mandar a otra
 * pantalla para completar cuatro datos es la forma más común de perder la venta.
 */
function Carrito({ config, onCerrar }: { config: ConfigTienda; onCerrar: () => void }) {
  const { items, cambiarCantidad, quitar, subtotal, vaciar } = useCarrito();
  const navegar = useNavigate();

  const [entrega, setEntrega] = useState<"retiro" | "envio">(
    config.retiro_habilitado ? "retiro" : "envio",
  );
  const [pago, setPago] = useState<"al_entregar" | "mercadopago">("al_entregar");
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [email, setEmail] = useState("");
  const [direccion, setDireccion] = useState("");
  const [localidad, setLocalidad] = useState("");
  const [referencia, setReferencia] = useState("");
  const [nota, setNota] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const envioGratis =
    config.envio_gratis_desde != null && subtotal >= Number(config.envio_gratis_desde);
  const costoEnvio =
    entrega === "envio" && !envioGratis ? Number(config.costo_envio ?? 0) : 0;
  const total = subtotal + costoEnvio;

  const confirmar = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setEnviando(true);

    const { data, error: err } = await supa.rpc("crear_pedido_online", {
      p_lineas: items.map((i: ItemCarrito) => ({ variante_id: i.variante_id, cantidad: i.cantidad })),
      p_nombre: nombre,
      p_telefono: telefono,
      p_entrega: entrega,
      p_pago: pago,
      p_email: email || null,
      p_direccion: entrega === "envio" ? direccion : null,
      p_localidad: entrega === "envio" ? localidad || null : null,
      p_referencia: entrega === "envio" ? referencia || null : null,
      p_nota: nota || null,
    });

    setEnviando(false);

    if (err) {
      // El mensaje viene escrito para el comprador desde la base, así que se
      // muestra tal cual: es más honesto que "ocurrió un error".
      setError(err.message);
      return;
    }

    const creado = ((data as { token: string }[]) ?? [])[0];
    if (!creado) {
      setError("No pudimos registrar el pedido. Probá de nuevo.");
      return;
    }

    vaciar();
    void navegar({ to: "/pedido/$token", params: { token: creado.token } });
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ background: "rgba(16, 24, 40, 0.45)" }} onClick={onCerrar}>
      <div
        className="flex h-full w-full max-w-md flex-col"
        style={{ background: "var(--surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-4" style={{ borderColor: "var(--border)" }}>
          <h2 className="text-[15px] font-semibold">Tu compra</h2>
          <button onClick={onCerrar} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>

        {items.length === 0 ? (
          <div className="grid flex-1 place-items-center px-6 text-center">
            <div>
              <ShoppingBag size={26} className="mx-auto" style={{ color: "var(--muted-foreground)" }} />
              <p className="mt-2 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                Todavía no elegiste nada.
              </p>
            </div>
          </div>
        ) : (
          <form onSubmit={confirmar} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {items.map((i) => (
                <div key={i.variante_id} className="flex gap-3 border-b py-3" style={{ borderColor: "#eef1f6" }}>
                  <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md" style={{ background: "#f1f3f8" }}>
                    {i.imagen && <img src={urlFoto(i.imagen)} alt="" className="h-full w-full object-cover" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium leading-tight">{i.producto}</div>
                    <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                      {[i.talle && `Talle ${i.talle}`, i.color].filter(Boolean).join(" · ") || "Único"}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="flex items-center rounded-md border" style={{ borderColor: "var(--border)" }}>
                        <button
                          type="button"
                          className="grid h-7 w-7 place-items-center"
                          onClick={() => cambiarCantidad(i.variante_id, i.cantidad - 1)}
                          aria-label="Uno menos"
                        >
                          <Minus size={12} />
                        </button>
                        <span className="w-6 text-center text-[13px] tabular">{i.cantidad}</span>
                        <button
                          type="button"
                          className="grid h-7 w-7 place-items-center disabled:opacity-40"
                          disabled={i.cantidad >= i.disponible}
                          onClick={() => cambiarCantidad(i.variante_id, i.cantidad + 1)}
                          aria-label="Uno más"
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => quitar(i.variante_id)}
                        aria-label="Quitar"
                        style={{ color: "var(--muted-foreground)" }}
                      >
                        <Trash2 size={13} />
                      </button>
                      <span className="ml-auto text-[13px] font-semibold tabular">
                        {formatARS(i.precio * i.cantidad)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}

              <div className="mt-4">
                <Rotulo>¿Cómo lo recibís?</Rotulo>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  {config.retiro_habilitado && (
                    <Opcion activo={entrega === "retiro"} onClick={() => setEntrega("retiro")}>
                      Retiro por el local
                    </Opcion>
                  )}
                  {config.envio_habilitado && (
                    <Opcion activo={entrega === "envio"} onClick={() => setEntrega("envio")}>
                      Envío a domicilio
                    </Opcion>
                  )}
                </div>
                {entrega === "retiro" && config.texto_retiro && (
                  <p className="mt-1.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                    {config.texto_retiro}
                  </p>
                )}
                {entrega === "envio" && config.zona_envio && (
                  <p className="mt-1.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                    Llegamos a: {config.zona_envio}
                  </p>
                )}
              </div>

              <div className="mt-4 grid gap-2.5">
                <Campo etiqueta="Tu nombre" valor={nombre} onCambio={setNombre} requerido />
                <Campo
                  etiqueta="Teléfono"
                  valor={telefono}
                  onCambio={setTelefono}
                  requerido
                  tipo="tel"
                  ayuda="Te escribimos por acá para confirmarte el pedido."
                />
                <Campo etiqueta="Email (opcional)" valor={email} onCambio={setEmail} tipo="email" />
                {entrega === "envio" && (
                  <>
                    <Campo etiqueta="Dirección" valor={direccion} onCambio={setDireccion} requerido />
                    <Campo etiqueta="Localidad" valor={localidad} onCambio={setLocalidad} />
                    <Campo
                      etiqueta="Referencia (opcional)"
                      valor={referencia}
                      onCambio={setReferencia}
                      ayuda="Timbre, color de la puerta, entre qué calles."
                    />
                  </>
                )}
                <Campo etiqueta="Comentario (opcional)" valor={nota} onCambio={setNota} />
              </div>

              <div className="mt-4">
                <Rotulo>¿Cómo pagás?</Rotulo>
                <div className="mt-1.5 grid gap-2">
                  <Opcion activo={pago === "al_entregar"} onClick={() => setPago("al_entregar")}>
                    {entrega === "retiro" ? "Pago cuando lo retiro" : "Pago cuando lo recibo"}
                  </Opcion>
                  {config.mp_habilitado && (
                    <Opcion activo={pago === "mercadopago"} onClick={() => setPago("mercadopago")}>
                      Pago ahora con Mercado Pago
                    </Opcion>
                  )}
                </div>
                <p className="mt-1.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                  {pago === "al_entregar"
                    ? "Te guardamos el producto y el local te confirma."
                    : "Apenas se acredite el pago, el local prepara el pedido."}
                </p>
              </div>
            </div>

            <div className="shrink-0 border-t px-4 py-3" style={{ borderColor: "var(--border)" }}>
              {error && (
                <div
                  className="mb-2 rounded-md px-3 py-2 text-[12px]"
                  style={{ background: "var(--danger-bg)", color: "var(--danger)" }}
                >
                  {error}
                </div>
              )}
              <div className="flex justify-between text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                <span>Productos</span>
                <span className="tabular">{formatARS(subtotal)}</span>
              </div>
              {entrega === "envio" && (
                <div className="flex justify-between text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                  <span>Envío</span>
                  <span className="tabular">{envioGratis ? "Gratis" : formatARS(costoEnvio)}</span>
                </div>
              )}
              <div className="mt-1 flex justify-between text-[15px] font-semibold">
                <span>Total</span>
                <span className="tabular">{formatARS(total)}</span>
              </div>
              <button
                type="submit"
                disabled={enviando}
                className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-md text-[14px] font-medium text-white disabled:opacity-60"
                style={{ background: "var(--primary)" }}
              >
                {enviando && <Loader2 size={14} className="animate-spin" />}
                Confirmar pedido
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function Rotulo({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] font-medium">{children}</div>;
}

function Opcion({
  activo,
  onClick,
  children,
}: {
  activo: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border px-3 py-2 text-[13px]"
      style={
        activo
          ? { borderColor: "var(--primary)", background: "#fdf3ef", color: "var(--primary)" }
          : { borderColor: "var(--border)" }
      }
    >
      {children}
    </button>
  );
}

function Campo({
  etiqueta,
  valor,
  onCambio,
  requerido,
  tipo = "text",
  ayuda,
}: {
  etiqueta: string;
  valor: string;
  onCambio: (v: string) => void;
  requerido?: boolean;
  tipo?: string;
  ayuda?: string;
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium">{etiqueta}</span>
      <input
        type={tipo}
        value={valor}
        required={requerido}
        onChange={(e) => onCambio(e.target.value)}
        className="mt-1 h-10 w-full rounded-md border px-2.5 text-[14px] outline-none"
        style={{ borderColor: "var(--border)" }}
      />
      {ayuda && (
        <span className="mt-1 block text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          {ayuda}
        </span>
      )}
    </label>
  );
}

function Vacio({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-16 text-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
      {children}
    </div>
  );
}

export function Centro({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-4" style={{ background: "var(--background)" }}>
      <div className="card-surface max-w-sm p-6 text-center" style={{ background: "var(--surface)" }}>
        {children}
      </div>
    </div>
  );
}
