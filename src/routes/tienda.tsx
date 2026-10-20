import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Ban,
  Check,
  ExternalLink,
  ImagePlus,
  Loader2,
  Package,
  Search,
  Settings,
  ShoppingBag,
  Star,
  Trash2,
  Truck,
} from "lucide-react";
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
import { useSesion } from "@/lib/sesion";
import { supa } from "@/lib/supabase";
import { formatARS } from "@/lib/format";
import { urlFoto } from "@/lib/tienda";

export const Route = createFileRoute("/tienda")({
  head: () => ({
    meta: [
      { title: "Tienda online — PymeOS" },
      {
        name: "description",
        content:
          "Gestión de la tienda online: qué se publica, con qué fotos y a qué precio, y los pedidos que entran.",
      },
    ],
  }),
  component: Tienda,
});

/* -------------------------------------------------------------------------
 * Tipos
 * ---------------------------------------------------------------------- */

type Config = {
  activa: boolean;
  nombre: string;
  slug: string;
  descripcion: string | null;
  sucursal_id: string | null;
  whatsapp: string | null;
  instagram: string | null;
  email_contacto: string | null;
  retiro_habilitado: boolean;
  envio_habilitado: boolean;
  costo_envio: number;
  envio_gratis_desde: number | null;
  zona_envio: string | null;
  mp_habilitado: boolean;
  texto_retiro: string | null;
};

type Imagen = { id: string; ruta: string; orden: number };

type Variante = {
  id: string;
  talle: string | null;
  color: string | null;
  sku: string | null;
  codigo_barras: string | null;
  precio: number;
  costo: number;
  activa: boolean;
};

type Producto = {
  id: string;
  nombre: string;
  marca: string | null;
  descripcion: string | null;
  descripcion_larga: string | null;
  publicado: boolean;
  destacado: boolean;
  orden_tienda: number;
  slug: string | null;
  categoria: { id: string; nombre: string } | null;
  variantes: Variante[];
  imagenes: Imagen[];
};

type LineaPedido = {
  id: string;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
  variante: {
    talle: string | null;
    color: string | null;
    producto: { nombre: string } | null;
  } | null;
};

type Pedido = {
  id: string;
  numero: number;
  nombre: string;
  telefono: string;
  email: string | null;
  entrega: "retiro" | "envio";
  direccion: string | null;
  localidad: string | null;
  referencia: string | null;
  pago: "mercadopago" | "al_entregar";
  estado: string;
  subtotal: number;
  costo_envio: number;
  total: number;
  venta_id: string | null;
  envio_id: string | null;
  token: string;
  nota: string | null;
  pagado_at: string | null;
  created_at: string;
  motivo_cancelacion: string | null;
  lineas: LineaPedido[];
};

type MedioPago = { id: string; nombre: string; es_cuenta_corriente: boolean };

type Solapa = "productos" | "pedidos" | "config";

/* -------------------------------------------------------------------------
 * Ayudas
 * ---------------------------------------------------------------------- */

function aNumero(texto: string): number {
  const n = Number(String(texto).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function vacioANull(texto: string): string | null {
  const t = texto.trim();
  return t === "" ? null : t;
}

function fechaHora(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ESTADO_TONO: Record<string, "success" | "warning" | "violet" | "danger" | "neutral"> = {
  iniciado: "warning",
  pendiente: "warning",
  confirmado: "violet",
  listo: "violet",
  entregado: "success",
  cancelado: "danger",
};

const ESTADO_TEXTO: Record<string, string> = {
  iniciado: "Esperando pago",
  pendiente: "Sin confirmar",
  confirmado: "Confirmado",
  listo: "Listo",
  entregado: "Entregado",
  cancelado: "Cancelado",
};

/* -------------------------------------------------------------------------
 * Pantalla
 * ---------------------------------------------------------------------- */

function Tienda() {
  const { usuario, sucursales } = useSesion();
  const esDueno = usuario?.rol === "dueno";

  const [solapa, setSolapa] = useState<Solapa>("productos");
  const [config, setConfig] = useState<Config | null>(null);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [disponible, setDisponible] = useState<Record<string, number>>({});
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [medios, setMedios] = useState<MedioPago[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setErrorCarga(null);

    const [rConfig, rProd, rPed, rMedios] = await Promise.all([
      supa.from("config_tienda").select("*").maybeSingle(),
      supa
        .from("productos")
        .select(
          "id, nombre, marca, descripcion, descripcion_larga, publicado, destacado, orden_tienda, slug, categoria:categorias(id, nombre), variantes(id, talle, color, sku, codigo_barras, precio, costo, activa), imagenes:producto_imagenes(id, ruta, orden)",
        )
        .eq("activo", true)
        .order("nombre"),
      supa
        .from("pedidos_online")
        .select(
          "id, numero, nombre, telefono, email, entrega, direccion, localidad, referencia, pago, estado, subtotal, costo_envio, total, venta_id, envio_id, token, nota, pagado_at, created_at, motivo_cancelacion, lineas:pedido_online_lineas(id, cantidad, precio_unitario, subtotal, variante:variantes(talle, color, producto:productos(nombre)))",
        )
        .order("created_at", { ascending: false })
        .limit(200),
      supa
        .from("medios_pago")
        .select("id, nombre, es_cuenta_corriente")
        .eq("activo", true)
        .order("orden"),
    ]);

    const error = rConfig.error ?? rProd.error ?? rPed.error ?? rMedios.error;
    if (error) {
      setErrorCarga(error.message);
      setCargando(false);
      return;
    }

    const cfg = (rConfig.data ?? null) as Config | null;
    setConfig(cfg);
    setProductos((rProd.data ?? []) as unknown as Producto[]);
    setPedidos((rPed.data ?? []) as unknown as Pedido[]);
    setMedios((rMedios.data ?? []) as MedioPago[]);

    // Lo que la tienda puede ofrecer es lo que hay en la sucursal que atiende,
    // menos lo que ya está reservado por otra entrega o por otro pedido.
    if (cfg?.sucursal_id) {
      const { data } = await supa
        .from("stock_disponible")
        .select("variante_id, disponible")
        .eq("sucursal_id", cfg.sucursal_id);
      const mapa: Record<string, number> = {};
      for (const f of (data ?? []) as { variante_id: string; disponible: number }[]) {
        mapa[f.variante_id] = Number(f.disponible);
      }
      setDisponible(mapa);
    } else {
      setDisponible({});
    }

    setCargando(false);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const publicados = useMemo(() => productos.filter((p) => p.publicado).length, [productos]);
  const sinConfirmar = useMemo(
    () => pedidos.filter((p) => p.estado === "pendiente").length,
    [pedidos],
  );

  const sucursalTienda = sucursales.find((s) => s.id === config?.sucursal_id) ?? null;

  return (
    <>
      <PageHeader
        title="Tienda online"
        subtitle={
          config
            ? `${config.activa ? "Abierta" : "Cerrada"} · ${publicados} producto${publicados === 1 ? "" : "s"} publicado${publicados === 1 ? "" : "s"}${sucursalTienda ? ` · sale de ${sucursalTienda.nombre}` : " · falta elegir la sucursal"}`
            : "Cargando…"
        }
        actions={
          <a
            href="/comprar"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px]"
            style={inputStyle}
          >
            <ExternalLink size={14} /> Ver la tienda
          </a>
        }
      />

      <div className="mb-3 flex gap-1">
        <Tab activa={solapa === "productos"} onClick={() => setSolapa("productos")} icono={<Package size={14} />}>
          Productos
        </Tab>
        <Tab activa={solapa === "pedidos"} onClick={() => setSolapa("pedidos")} icono={<ShoppingBag size={14} />}>
          Pedidos{sinConfirmar > 0 ? ` (${sinConfirmar})` : ""}
        </Tab>
        <Tab activa={solapa === "config"} onClick={() => setSolapa("config")} icono={<Settings size={14} />}>
          Configuración
        </Tab>
      </div>

      {errorCarga && (
        <div className="mb-3">
          <Alerta tono="danger">No se pudo cargar la tienda: {errorCarga}</Alerta>
        </div>
      )}

      {!errorCarga && !cargando && !config?.sucursal_id && (
        <div className="mb-3">
          <Alerta tono="warning">
            Todavía no está elegida la sucursal de la que sale la mercadería. Hasta que se
            elija, la tienda no puede abrir ni mostrar stock. Se configura en la solapa
            Configuración.
          </Alerta>
        </div>
      )}

      {cargando ? (
        <div className="card-surface grid h-64 place-items-center">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : solapa === "productos" ? (
        <Productos
          productos={productos}
          disponible={disponible}
          esDueno={esDueno}
          hayTienda={Boolean(config?.sucursal_id)}
          onCambio={cargar}
        />
      ) : solapa === "pedidos" ? (
        <Pedidos pedidos={pedidos} medios={medios} onCambio={cargar} />
      ) : (
        <Configuracion config={config} sucursales={sucursales} esDueno={esDueno} onCambio={cargar} />
      )}
    </>
  );
}

function Tab({
  activa,
  onClick,
  icono,
  children,
}: {
  activa: boolean;
  onClick: () => void;
  icono: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium"
      style={{
        borderColor: activa ? "var(--primary)" : "var(--border)",
        background: activa ? "var(--primary)" : "var(--surface)",
        color: activa ? "#fff" : "var(--foreground)",
      }}
    >
      {icono}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------
 * Solapa Productos: qué se publica y con qué datos
 * ---------------------------------------------------------------------- */

function Productos({
  productos,
  disponible,
  esDueno,
  hayTienda,
  onCambio,
}: {
  productos: Producto[];
  disponible: Record<string, number>;
  esDueno: boolean;
  hayTienda: boolean;
  onCambio: () => Promise<void>;
}) {
  const [busqueda, setBusqueda] = useState("");
  const [filtro, setFiltro] = useState<"todos" | "publicados" | "ocultos">("todos");
  const [abierto, setAbierto] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lista = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return productos.filter((p) => {
      if (filtro === "publicados" && !p.publicado) return false;
      if (filtro === "ocultos" && p.publicado) return false;
      if (q === "") return true;
      return (
        p.nombre.toLowerCase().includes(q) ||
        (p.marca ?? "").toLowerCase().includes(q) ||
        p.variantes.some((v) => (v.codigo_barras ?? "").includes(q) || (v.sku ?? "").toLowerCase().includes(q))
      );
    });
  }, [productos, busqueda, filtro]);

  const seleccionado = productos.find((p) => p.id === abierto) ?? null;

  const alternarPublicado = async (p: Producto) => {
    setError(null);
    setGuardando(p.id);
    const { error } = await supa.rpc("guardar_tienda_producto", {
      p_producto_id: p.id,
      p_publicado: !p.publicado,
      p_descripcion_larga: p.descripcion_larga,
      p_destacado: p.destacado,
      p_orden_tienda: p.orden_tienda,
    });
    if (error) setError(error.message);
    await onCambio();
    setGuardando(null);
  };

  return (
    <div className="grid grid-cols-[1fr_420px] gap-3">
      <div>
        <div className="card-surface mb-3 flex items-center gap-2 p-2.5">
          <div className="relative flex-1">
            <Search
              size={14}
              className="absolute top-1/2 left-2.5 -translate-y-1/2"
              style={{ color: "var(--muted-foreground)" }}
            />
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por nombre, marca, SKU o código de barras"
              className="h-9 w-full rounded-md border pr-2.5 pl-8 text-[13px] outline-none"
              style={inputStyle}
            />
          </div>
          <select
            value={filtro}
            onChange={(e) => setFiltro(e.target.value as typeof filtro)}
            className="h-9 rounded-md border px-2 text-[13px] outline-none"
            style={inputStyle}
          >
            <option value="todos">Todos</option>
            <option value="publicados">Publicados</option>
            <option value="ocultos">Ocultos</option>
          </select>
        </div>

        {error && (
          <div className="mb-3">
            <Alerta tono="danger">{error}</Alerta>
          </div>
        )}

        {!hayTienda && (
          <div className="mb-3">
            <Alerta tono="info">
              El stock que se muestra abajo va a aparecer recién cuando esté elegida la
              sucursal de la tienda.
            </Alerta>
          </div>
        )}

        {lista.length === 0 ? (
          <div
            className="card-surface grid h-48 place-items-center text-[13px]"
            style={{ color: "var(--muted-foreground)" }}
          >
            {productos.length === 0
              ? "Todavía no hay productos cargados. Se cargan en Stock."
              : "Ningún producto coincide con la búsqueda."}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {lista.map((p) => {
              const foto = [...p.imagenes].sort((a, b) => a.orden - b.orden)[0];
              const enTienda = p.variantes
                .filter((v) => v.activa)
                .reduce((s, v) => s + Math.max(disponible[v.id] ?? 0, 0), 0);
              const precios = p.variantes.filter((v) => v.activa).map((v) => Number(v.precio));
              const sel = abierto === p.id;
              return (
                <div
                  key={p.id}
                  onClick={() => setAbierto(p.id)}
                  className="card-surface cursor-pointer overflow-hidden"
                  style={{ borderColor: sel ? "var(--primary)" : "var(--border)" }}
                >
                  {foto ? (
                    <img src={urlFoto(foto.ruta)} alt="" className="h-32 w-full object-cover" />
                  ) : (
                    <div
                      className="grid h-32 w-full place-items-center text-[11px]"
                      style={{ background: "#f9fafc", color: "var(--muted-foreground)" }}
                    >
                      Sin foto
                    </div>
                  )}
                  <div className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium">{p.nombre}</div>
                        <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                          {p.marca ?? "Sin marca"} · {p.variantes.filter((v) => v.activa).length} variante
                          {p.variantes.filter((v) => v.activa).length === 1 ? "" : "s"}
                        </div>
                      </div>
                      {esDueno && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void alternarPublicado(p);
                          }}
                          disabled={guardando === p.id}
                          aria-label={p.publicado ? "Ocultar de la tienda" : "Publicar en la tienda"}
                          className="relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50"
                          style={{ background: p.publicado ? "var(--primary)" : "#d0d5dd" }}
                        >
                          <span
                            className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
                            style={{ left: p.publicado ? 18 : 2 }}
                          />
                        </button>
                      )}
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[13px] font-semibold tabular">
                        {precios.length === 0
                          ? "—"
                          : Math.min(...precios) === Math.max(...precios)
                            ? formatARS(precios[0])
                            : `${formatARS(Math.min(...precios))} a ${formatARS(Math.max(...precios))}`}
                      </span>
                      <Chip tone={p.publicado ? (enTienda > 0 ? "success" : "warning") : "neutral"}>
                        {p.publicado ? (enTienda > 0 ? `${enTienda} en tienda` : "Sin stock") : "Oculto"}
                      </Chip>
                    </div>
                    {p.publicado && p.imagenes.length === 0 && (
                      <div className="mt-2 text-[11px]" style={{ color: "var(--warning)" }}>
                        Publicado sin fotos: así no vende.
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <aside className="card-surface h-fit p-4">
        {seleccionado ? (
          <FichaProducto
            key={seleccionado.id}
            producto={seleccionado}
            disponible={disponible}
            esDueno={esDueno}
            onCambio={onCambio}
          />
        ) : (
          <div className="grid h-64 place-items-center text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            Elegí un producto para ver y editar su ficha completa.
          </div>
        )}
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Ficha completa del producto: todo lo que la tienda necesita de una cosa
 * ---------------------------------------------------------------------- */

function FichaProducto({
  producto,
  disponible,
  esDueno,
  onCambio,
}: {
  producto: Producto;
  disponible: Record<string, number>;
  esDueno: boolean;
  onCambio: () => Promise<void>;
}) {
  const [nombre, setNombre] = useState(producto.nombre);
  const [marca, setMarca] = useState(producto.marca ?? "");
  const [descripcion, setDescripcion] = useState(producto.descripcion ?? "");
  const [larga, setLarga] = useState(producto.descripcion_larga ?? "");
  const [destacado, setDestacado] = useState(producto.destacado);
  const [orden, setOrden] = useState(String(producto.orden_tienda ?? 0));

  const [guardando, setGuardando] = useState(false);
  const [subiendo, setSubiendo] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const archivo = useRef<HTMLInputElement>(null);

  const imagenes = [...producto.imagenes].sort((a, b) => a.orden - b.orden);

  const guardar = async () => {
    setError(null);
    setMensaje(null);
    setGuardando(true);

    // Los datos del producto viven en `productos`; lo que es de tienda pasa por
    // la función, que además calcula el slug una sola vez y no lo vuelve a tocar.
    const { error: e1 } = await supa
      .from("productos")
      .update({
        nombre: nombre.trim(),
        marca: vacioANull(marca),
        descripcion: vacioANull(descripcion),
      })
      .eq("id", producto.id);

    if (e1) {
      setError(e1.message);
      setGuardando(false);
      return;
    }

    const { error: e2 } = await supa.rpc("guardar_tienda_producto", {
      p_producto_id: producto.id,
      p_publicado: producto.publicado,
      p_descripcion_larga: vacioANull(larga),
      p_destacado: destacado,
      p_orden_tienda: Math.trunc(aNumero(orden)),
    });

    if (e2) {
      setError(e2.message);
      setGuardando(false);
      return;
    }

    await onCambio();
    setMensaje("Guardado.");
    setGuardando(false);
  };

  const subirFoto = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setSubiendo(true);

    let siguiente = imagenes.length;
    for (const file of Array.from(files)) {
      const ext = (file.name.split(".").pop() ?? "jpg").toLowerCase();
      const ruta = `${producto.id}/${crypto.randomUUID()}.${ext}`;
      const { error: eSubida } = await supa.storage
        .from("productos")
        .upload(ruta, file, { contentType: file.type, upsert: false });
      if (eSubida) {
        setError(`No se pudo subir ${file.name}: ${eSubida.message}`);
        break;
      }
      const { error: eFila } = await supa
        .from("producto_imagenes")
        .insert({ producto_id: producto.id, ruta, orden: siguiente });
      if (eFila) {
        // Si la fila no entra, la foto suelta en Storage no le sirve a nadie.
        await supa.storage.from("productos").remove([ruta]);
        setError(eFila.message);
        break;
      }
      siguiente += 1;
    }

    if (archivo.current) archivo.current.value = "";
    await onCambio();
    setSubiendo(false);
  };

  const borrarFoto = async (img: Imagen) => {
    setError(null);
    const { error: e } = await supa.from("producto_imagenes").delete().eq("id", img.id);
    if (e) {
      setError(e.message);
      return;
    }
    await supa.storage.from("productos").remove([img.ruta]);
    await onCambio();
  };

  const hacerPrincipal = async (img: Imagen) => {
    setError(null);
    const resto = imagenes.filter((i) => i.id !== img.id);
    await supa.from("producto_imagenes").update({ orden: 0 }).eq("id", img.id);
    for (let i = 0; i < resto.length; i += 1) {
      await supa.from("producto_imagenes").update({ orden: i + 1 }).eq("id", resto[i].id);
    }
    await onCambio();
  };

  return (
    <div className="space-y-4 text-[13px]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">Ficha del producto</div>
          <div className="truncate text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            {producto.slug ? `/comprar/${producto.slug}` : "La dirección se arma al publicarlo"}
          </div>
        </div>
        <Chip tone={producto.publicado ? "success" : "neutral"}>
          {producto.publicado ? "Publicado" : "Oculto"}
        </Chip>
      </div>

      {error && <Alerta tono="danger">{error}</Alerta>}
      {mensaje && <Alerta tono="info">{mensaje}</Alerta>}

      {!esDueno && (
        <Alerta tono="info">
          Solo un dueño puede editar lo que se publica. Podés mirar la ficha.
        </Alerta>
      )}

      {/* Fotos: lo primero que mira quien compra */}
      <div>
        <div className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
          Fotos ({imagenes.length})
        </div>
        <div className="mt-1.5 grid grid-cols-4 gap-2">
          {imagenes.map((img, i) => (
            <div key={img.id} className="group relative aspect-square">
              <img src={urlFoto(img.ruta)} alt="" className="h-full w-full rounded object-cover" />
              {i === 0 && (
                <span
                  className="absolute top-1 left-1 rounded px-1 text-[10px] font-medium text-white"
                  style={{ background: "rgba(16,24,40,.7)" }}
                >
                  Portada
                </span>
              )}
              {esDueno && (
                <div className="absolute inset-x-1 bottom-1 hidden justify-between group-hover:flex">
                  {i !== 0 && (
                    <button
                      onClick={() => void hacerPrincipal(img)}
                      title="Poner de portada"
                      className="rounded bg-white/90 p-1"
                    >
                      <Star size={12} />
                    </button>
                  )}
                  <button
                    onClick={() => void borrarFoto(img)}
                    title="Borrar foto"
                    className="ml-auto rounded bg-white/90 p-1"
                    style={{ color: "var(--danger)" }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
            </div>
          ))}
          {esDueno && (
            <button
              onClick={() => archivo.current?.click()}
              disabled={subiendo}
              className="grid aspect-square place-items-center rounded border-2 border-dashed text-[11px]"
              style={{ borderColor: "var(--border)", color: "var(--muted-foreground)" }}
            >
              {subiendo ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={16} />}
            </button>
          )}
        </div>
        <input
          ref={archivo}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => void subirFoto(e.target.files)}
        />
      </div>

      <div>
        <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
          Nombre
        </label>
        <input
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          disabled={!esDueno}
          className={inputCls}
          style={inputStyle}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Marca
          </label>
          <input
            value={marca}
            onChange={(e) => setMarca(e.target.value)}
            disabled={!esDueno}
            className={inputCls}
            style={inputStyle}
          />
        </div>
        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Categoría
          </label>
          <input
            value={producto.categoria?.nombre ?? "Sin categoría"}
            disabled
            className={inputCls}
            style={{ ...inputStyle, background: "#f9fafc" }}
          />
        </div>
      </div>

      <div>
        <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
          Descripción corta (la que se ve en la grilla)
        </label>
        <input
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          disabled={!esDueno}
          className={inputCls}
          style={inputStyle}
        />
      </div>

      <div>
        <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
          Descripción larga (la ficha del producto)
        </label>
        <textarea
          value={larga}
          onChange={(e) => setLarga(e.target.value)}
          disabled={!esDueno}
          rows={4}
          className="mt-1 w-full rounded-md border p-2 text-[13px] outline-none"
          style={inputStyle}
        />
      </div>

      <div className="grid grid-cols-2 items-end gap-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={destacado}
            disabled={!esDueno}
            onChange={(e) => setDestacado(e.target.checked)}
          />
          <span>Destacado (aparece primero)</span>
        </label>
        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Orden en la tienda
          </label>
          <input
            value={orden}
            onChange={(e) => setOrden(e.target.value)}
            disabled={!esDueno}
            className={`${inputCls} tabular`}
            style={inputStyle}
          />
        </div>
      </div>

      {esDueno && (
        <button
          onClick={() => void guardar()}
          disabled={guardando}
          className="flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-[13px] font-semibold text-white disabled:opacity-60"
          style={{ background: "var(--primary)" }}
        >
          {guardando && <Loader2 size={13} className="animate-spin" />}
          Guardar ficha
        </button>
      )}

      <div>
        <div className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
          Variantes, precio y código de barras
        </div>
        <div className="mt-1.5 space-y-2">
          {producto.variantes
            .filter((v) => v.activa)
            .map((v) => (
              <FilaVariante
                key={v.id}
                variante={v}
                disponible={disponible[v.id] ?? 0}
                esDueno={esDueno}
                onCambio={onCambio}
              />
            ))}
          {producto.variantes.filter((v) => v.activa).length === 0 && (
            <div className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              Este producto no tiene variantes activas. Se cargan en Stock.
            </div>
          )}
        </div>
        <div className="mt-2 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          El precio es uno solo: el mismo que cobra el mostrador. La cantidad no se
          edita acá, se cuenta en Stock.
        </div>
      </div>
    </div>
  );
}

function FilaVariante({
  variante,
  disponible,
  esDueno,
  onCambio,
}: {
  variante: Variante;
  disponible: number;
  esDueno: boolean;
  onCambio: () => Promise<void>;
}) {
  const [precio, setPrecio] = useState(String(variante.precio));
  const [codigo, setCodigo] = useState(variante.codigo_barras ?? "");
  const [sku, setSku] = useState(variante.sku ?? "");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cambiado =
    aNumero(precio) !== Number(variante.precio) ||
    vacioANull(codigo) !== variante.codigo_barras ||
    vacioANull(sku) !== variante.sku;

  const guardar = async () => {
    setError(null);
    setGuardando(true);
    const { error: e } = await supa
      .from("variantes")
      .update({
        precio: aNumero(precio),
        codigo_barras: vacioANull(codigo),
        sku: vacioANull(sku),
      })
      .eq("id", variante.id);
    if (e) setError(e.message);
    else await onCambio();
    setGuardando(false);
  };

  return (
    <div className="rounded-md border p-2" style={inputStyle}>
      <div className="flex items-center justify-between text-[12px]">
        <span className="font-medium">
          {variante.talle ? `T.${variante.talle}` : "Único"}
          {variante.color ? ` · ${variante.color}` : ""}
        </span>
        <Chip tone={disponible > 0 ? "success" : "neutral"}>{disponible} disponible</Chip>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <input
          value={precio}
          onChange={(e) => setPrecio(e.target.value)}
          disabled={!esDueno}
          placeholder="Precio"
          className="h-8 w-full rounded-md border px-2 text-[12px] tabular outline-none"
          style={inputStyle}
        />
        <input
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          disabled={!esDueno}
          placeholder="Código de barras"
          className="h-8 w-full rounded-md border px-2 text-[12px] tabular outline-none"
          style={inputStyle}
        />
        <input
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          disabled={!esDueno}
          placeholder="SKU"
          className="h-8 w-full rounded-md border px-2 text-[12px] outline-none"
          style={inputStyle}
        />
      </div>
      {error && <div className="mt-1 text-[11px]" style={{ color: "var(--danger)" }}>{error}</div>}
      {esDueno && cambiado && (
        <button
          onClick={() => void guardar()}
          disabled={guardando}
          className="mt-1.5 flex items-center gap-1 text-[12px] font-medium"
          style={{ color: "var(--primary)" }}
        >
          {guardando ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          Guardar esta variante
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Solapa Pedidos: el movimiento de la tienda
 * ---------------------------------------------------------------------- */

function Pedidos({
  pedidos,
  medios,
  onCambio,
}: {
  pedidos: Pedido[];
  medios: MedioPago[];
  onCambio: () => Promise<void>;
}) {
  const [filtro, setFiltro] = useState<string>("abiertos");
  const [trabajando, setTrabajando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cobrando, setCobrando] = useState<Pedido | null>(null);
  const [cancelando, setCancelando] = useState<Pedido | null>(null);

  const lista = useMemo(() => {
    if (filtro === "abiertos") {
      return pedidos.filter((p) => !["entregado", "cancelado"].includes(p.estado));
    }
    if (filtro === "todos") return pedidos;
    return pedidos.filter((p) => p.estado === filtro);
  }, [pedidos, filtro]);

  // PromiseLike y no Promise: lo que devuelve supa.rpc() se puede esperar con
  // await, pero no es una Promise completa hasta que se la ejecuta.
  const accion = async (id: string, fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setError(null);
    setTrabajando(id);
    const { error: e } = await fn();
    if (e) setError(e.message);
    await onCambio();
    setTrabajando(null);
  };

  return (
    <div>
      <div className="card-surface mb-3 flex items-center gap-2 p-2.5">
        <select
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          className="h-9 rounded-md border px-2 text-[13px] outline-none"
          style={inputStyle}
        >
          <option value="abiertos">Abiertos</option>
          <option value="pendiente">Sin confirmar</option>
          <option value="confirmado">Confirmados</option>
          <option value="listo">Listos</option>
          <option value="entregado">Entregados</option>
          <option value="cancelado">Cancelados</option>
          <option value="todos">Todos</option>
        </select>
        <span className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
          {lista.length} pedido{lista.length === 1 ? "" : "s"}
        </span>
      </div>

      {error && (
        <div className="mb-3">
          <Alerta tono="danger">{error}</Alerta>
        </div>
      )}

      {lista.length === 0 ? (
        <div
          className="card-surface grid h-48 place-items-center text-[13px]"
          style={{ color: "var(--muted-foreground)" }}
        >
          No hay pedidos para mostrar.
        </div>
      ) : (
        <div className="space-y-2">
          {lista.map((p) => (
            <div key={p.id} className="card-surface p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold">Pedido #{p.numero}</span>
                    <Chip tone={ESTADO_TONO[p.estado] ?? "neutral"}>
                      {ESTADO_TEXTO[p.estado] ?? p.estado}
                    </Chip>
                    <Chip tone={p.pago === "mercadopago" ? (p.pagado_at ? "success" : "warning") : "neutral"}>
                      {p.pago === "mercadopago"
                        ? p.pagado_at
                          ? "Pagado online"
                          : "Pago online sin acreditar"
                        : "Paga al recibir"}
                    </Chip>
                  </div>
                  <div className="mt-1 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                    {p.nombre} · {p.telefono}
                    {p.email ? ` · ${p.email}` : ""} · {fechaHora(p.created_at)}
                  </div>
                  <div className="mt-0.5 text-[12px]">
                    {p.entrega === "retiro"
                      ? "Retira por el local"
                      : `Envío a ${p.direccion}${p.localidad ? `, ${p.localidad}` : ""}`}
                    {p.referencia ? ` (${p.referencia})` : ""}
                  </div>
                  {p.nota && (
                    <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                      Nota: {p.nota}
                    </div>
                  )}
                  {p.motivo_cancelacion && (
                    <div className="mt-0.5 text-[12px]" style={{ color: "var(--danger)" }}>
                      Cancelado: {p.motivo_cancelacion}
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[15px] font-semibold tabular">{formatARS(Number(p.total))}</div>
                  {Number(p.costo_envio) > 0 && (
                    <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                      incluye {formatARS(Number(p.costo_envio))} de envío
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-2 border-t pt-2" style={{ borderColor: "#eef1f6" }}>
                {p.lineas.map((l) => (
                  <div key={l.id} className="flex justify-between text-[12px]">
                    <span>
                      {l.cantidad} × {l.variante?.producto?.nombre ?? "Producto"}
                      {l.variante?.talle ? ` T.${l.variante.talle}` : ""}
                      {l.variante?.color ? ` · ${l.variante.color}` : ""}
                    </span>
                    <span className="tabular">{formatARS(Number(l.subtotal))}</span>
                  </div>
                ))}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <a
                  href={`/pedido/${p.token}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-[12px]"
                  style={{ color: "var(--primary)" }}
                >
                  <ExternalLink size={12} /> Link del cliente
                </a>

                {!["entregado", "cancelado"].includes(p.estado) && (
                  <>
                    {["iniciado", "pendiente"].includes(p.estado) && (
                      <BotonChico
                        cargando={trabajando === p.id}
                        onClick={() =>
                          void accion(p.id, () =>
                            supa.rpc("cambiar_estado_pedido_online", {
                              p_pedido_id: p.id,
                              p_destino: "confirmado",
                            }),
                          )
                        }
                      >
                        <Check size={12} /> Confirmar
                      </BotonChico>
                    )}

                    {["pendiente", "confirmado"].includes(p.estado) && (
                      <BotonChico
                        cargando={trabajando === p.id}
                        onClick={() =>
                          void accion(p.id, () =>
                            supa.rpc("cambiar_estado_pedido_online", {
                              p_pedido_id: p.id,
                              p_destino: "listo",
                            }),
                          )
                        }
                      >
                        <Package size={12} /> Marcar listo
                      </BotonChico>
                    )}

                    {p.entrega === "envio" && !p.envio_id && (
                      <BotonChico
                        cargando={trabajando === p.id}
                        onClick={() =>
                          void accion(p.id, () =>
                            supa.rpc("generar_envio_pedido_online", { p_pedido_id: p.id }),
                          )
                        }
                      >
                        <Truck size={12} /> Generar entrega
                      </BotonChico>
                    )}

                    <BotonChico cargando={false} onClick={() => setCobrando(p)}>
                      <Check size={12} /> Entregar y cobrar
                    </BotonChico>

                    <button
                      onClick={() => setCancelando(p)}
                      className="flex items-center gap-1 rounded-md border px-2 py-1 text-[12px]"
                      style={{ borderColor: "var(--border)", color: "var(--danger)" }}
                    >
                      <Ban size={12} /> Cancelar
                    </button>
                  </>
                )}

                {p.envio_id && (
                  <span className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
                    Entrega generada · se sigue desde Pedidos y envíos
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {cobrando && (
        <ModalCobrar
          pedido={cobrando}
          medios={medios}
          onCerrar={() => setCobrando(null)}
          onListo={async () => {
            setCobrando(null);
            await onCambio();
          }}
        />
      )}

      {cancelando && (
        <ModalCancelar
          pedido={cancelando}
          onCerrar={() => setCancelando(null)}
          onListo={async () => {
            setCancelando(null);
            await onCambio();
          }}
        />
      )}
    </div>
  );
}

function BotonChico({
  cargando,
  onClick,
  children,
}: {
  cargando: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={cargando}
      className="flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] disabled:opacity-60"
      style={inputStyle}
    >
      {cargando ? <Loader2 size={12} className="animate-spin" /> : null}
      {children}
    </button>
  );
}

/**
 * Cerrar un pedido es registrar la venta: la misma función que usa el
 * mostrador. Por eso hay que decir con qué se cobró, salvo que ya haya pagado
 * online, donde el medio de pago sale solo.
 */
function ModalCobrar({
  pedido,
  medios,
  onCerrar,
  onListo,
}: {
  pedido: Pedido;
  medios: MedioPago[];
  onCerrar: () => void;
  onListo: () => Promise<void>;
}) {
  const yaPago = pedido.pago === "mercadopago" && pedido.pagado_at !== null;
  const [medio, setMedio] = useState(medios.find((m) => !m.es_cuenta_corriente)?.id ?? "");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    const { error: err } = await supa.rpc("cerrar_pedido_online", {
      p_pedido_id: pedido.id,
      p_pagos: yaPago
        ? null
        : [{ medio_pago_id: medio, monto: Number(pedido.subtotal) }],
    });
    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    await onListo();
  };

  return (
    <Modal titulo={`Entregar y cobrar el pedido #${pedido.numero}`} onCerrar={onCerrar}>
      <form onSubmit={enviar} className="space-y-3 text-[13px]">
        {error && <Alerta tono="danger">{error}</Alerta>}

        <div className="rounded-md p-3" style={{ background: "#f9fafc" }}>
          <div className="flex justify-between">
            <span>Mercadería</span>
            <span className="tabular font-semibold">{formatARS(Number(pedido.subtotal))}</span>
          </div>
          {Number(pedido.costo_envio) > 0 && (
            <div className="mt-1 flex justify-between text-[12px]" style={{ color: "var(--muted-foreground)" }}>
              <span>Envío (queda anotado en la entrega)</span>
              <span className="tabular">{formatARS(Number(pedido.costo_envio))}</span>
            </div>
          )}
        </div>

        {yaPago ? (
          <Alerta tono="info">
            Este pedido ya se pagó por Mercado Pago. Al confirmar se registra la venta
            con ese medio de pago.
          </Alerta>
        ) : (
          <div>
            <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
              ¿Con qué pagó?
            </label>
            <select
              value={medio}
              onChange={(e) => setMedio(e.target.value)}
              className={inputCls}
              style={inputStyle}
              required
            >
              <option value="">Elegir…</option>
              {medios.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nombre}
                </option>
              ))}
            </select>
            <div className="mt-1 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
              Se registra una venta igual que en el mostrador: descuenta stock, entra a
              la caja si es efectivo y queda en el resultado del mes.
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Volver</BotonSecundario>
          <BotonPrimario enviando={enviando} disabled={!yaPago && medio === ""}>
            Registrar la venta
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

function ModalCancelar({
  pedido,
  onCerrar,
  onListo,
}: {
  pedido: Pedido;
  onCerrar: () => void;
  onListo: () => Promise<void>;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    const { error: err } = await supa.rpc("cambiar_estado_pedido_online", {
      p_pedido_id: pedido.id,
      p_destino: "cancelado",
      p_motivo: motivo.trim(),
    });
    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    await onListo();
  };

  return (
    <Modal titulo={`Cancelar el pedido #${pedido.numero}`} onCerrar={onCerrar}>
      <form onSubmit={enviar} className="space-y-3 text-[13px]">
        {error && <Alerta tono="danger">{error}</Alerta>}
        <Alerta tono="warning">
          La mercadería reservada vuelve a estar disponible en la tienda. El pedido no se
          borra: queda con el motivo a la vista.
        </Alerta>
        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            ¿Por qué se cancela?
          </label>
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            className={inputCls}
            style={inputStyle}
            required
            placeholder="El cliente se arrepintió, no atendió el teléfono…"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <BotonSecundario onClick={onCerrar}>Volver</BotonSecundario>
          <BotonPrimario enviando={enviando} disabled={motivo.trim() === ""}>
            Cancelar el pedido
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------------------------
 * Solapa Configuración
 * ---------------------------------------------------------------------- */

function Configuracion({
  config,
  sucursales,
  esDueno,
  onCambio,
}: {
  config: Config | null;
  sucursales: { id: string; nombre: string; activa: boolean }[];
  esDueno: boolean;
  onCambio: () => Promise<void>;
}) {
  const [activa, setActiva] = useState(config?.activa ?? false);
  const [nombre, setNombre] = useState(config?.nombre ?? "");
  const [slug, setSlug] = useState(config?.slug ?? "");
  const [descripcion, setDescripcion] = useState(config?.descripcion ?? "");
  const [sucursalId, setSucursalId] = useState(config?.sucursal_id ?? "");
  const [whatsapp, setWhatsapp] = useState(config?.whatsapp ?? "");
  const [instagram, setInstagram] = useState(config?.instagram ?? "");
  const [email, setEmail] = useState(config?.email_contacto ?? "");
  const [retiro, setRetiro] = useState(config?.retiro_habilitado ?? true);
  const [envio, setEnvio] = useState(config?.envio_habilitado ?? false);
  const [costoEnvio, setCostoEnvio] = useState(String(config?.costo_envio ?? 0));
  const [gratisDesde, setGratisDesde] = useState(
    config?.envio_gratis_desde == null ? "" : String(config.envio_gratis_desde),
  );
  const [zona, setZona] = useState(config?.zona_envio ?? "");
  const [textoRetiro, setTextoRetiro] = useState(config?.texto_retiro ?? "");

  const [enviando, setEnviando] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMensaje(null);
    setEnviando(true);
    const { error: err } = await supa.rpc("guardar_config_tienda", {
      p_activa: activa,
      p_nombre: nombre,
      p_slug: slug,
      p_sucursal_id: sucursalId === "" ? null : sucursalId,
      p_descripcion: vacioANull(descripcion),
      p_whatsapp: vacioANull(whatsapp),
      p_instagram: vacioANull(instagram),
      p_email_contacto: vacioANull(email),
      p_retiro_habilitado: retiro,
      p_envio_habilitado: envio,
      p_costo_envio: aNumero(costoEnvio),
      p_envio_gratis_desde: gratisDesde.trim() === "" ? null : aNumero(gratisDesde),
      p_zona_envio: vacioANull(zona),
      p_texto_retiro: vacioANull(textoRetiro),
    });
    if (err) {
      setError(err.message);
      setEnviando(false);
      return;
    }
    await onCambio();
    setMensaje("Configuración guardada.");
    setEnviando(false);
  };

  return (
    <form onSubmit={guardar} className="grid grid-cols-2 gap-3 text-[13px]">
      <div className="card-surface space-y-3 p-4">
        <div className="text-[13px] font-semibold">La tienda</div>

        {error && <Alerta tono="danger">{error}</Alerta>}
        {mensaje && <Alerta tono="info">{mensaje}</Alerta>}
        {!esDueno && <Alerta tono="info">Solo un dueño puede cambiar esta configuración.</Alerta>}

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={activa}
            disabled={!esDueno}
            onChange={(e) => setActiva(e.target.checked)}
          />
          <span className="font-medium">La tienda está abierta</span>
        </label>
        <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          Mientras esté cerrada nadie de afuera ve nada. Sirve para cargar productos y
          fotos con calma antes de compartir el link en Instagram o WhatsApp.
        </div>

        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Nombre de la tienda
          </label>
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            disabled={!esDueno}
            className={inputCls}
            style={inputStyle}
            required
          />
        </div>

        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Dirección web
          </label>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={!esDueno}
            className={inputCls}
            style={inputStyle}
            required
          />
        </div>

        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            De qué sucursal sale la mercadería
          </label>
          <select
            value={sucursalId}
            onChange={(e) => setSucursalId(e.target.value)}
            disabled={!esDueno}
            className={inputCls}
            style={inputStyle}
          >
            <option value="">Elegir…</option>
            {sucursales
              .filter((s) => s.activa)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nombre}
                </option>
              ))}
          </select>
          <div className="mt-1 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
            La tienda muestra el stock de esa sucursal y ahí se descuenta lo que se vende
            online. Sin esto la tienda no puede abrir.
          </div>
        </div>

        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Descripción
          </label>
          <textarea
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            disabled={!esDueno}
            rows={3}
            className="mt-1 w-full rounded-md border p-2 text-[13px] outline-none"
            style={inputStyle}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
              WhatsApp
            </label>
            <input
              value={whatsapp}
              onChange={(e) => setWhatsapp(e.target.value)}
              disabled={!esDueno}
              className={inputCls}
              style={inputStyle}
              placeholder="5493411234567"
            />
          </div>
          <div>
            <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
              Instagram
            </label>
            <input
              value={instagram}
              onChange={(e) => setInstagram(e.target.value)}
              disabled={!esDueno}
              className={inputCls}
              style={inputStyle}
              placeholder="mitienda"
            />
          </div>
        </div>

        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Mail de contacto
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!esDueno}
            className={inputCls}
            style={inputStyle}
          />
        </div>
      </div>

      <div className="card-surface space-y-3 p-4">
        <div className="text-[13px] font-semibold">Cómo recibe el cliente</div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={retiro}
            disabled={!esDueno}
            onChange={(e) => setRetiro(e.target.checked)}
          />
          <span>Retira por el local</span>
        </label>

        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Qué decirle al que retira
          </label>
          <input
            value={textoRetiro}
            onChange={(e) => setTextoRetiro(e.target.value)}
            disabled={!esDueno || !retiro}
            className={inputCls}
            style={inputStyle}
            placeholder="Lunes a sábados de 9 a 13 y de 16 a 20"
          />
        </div>

        <label className="flex items-center gap-2 pt-1">
          <input
            type="checkbox"
            checked={envio}
            disabled={!esDueno}
            onChange={(e) => setEnvio(e.target.checked)}
          />
          <span>Envío propio</span>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
              Costo del envío
            </label>
            <input
              value={costoEnvio}
              onChange={(e) => setCostoEnvio(e.target.value)}
              disabled={!esDueno || !envio}
              className={`${inputCls} tabular`}
              style={inputStyle}
            />
          </div>
          <div>
            <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
              Gratis a partir de
            </label>
            <input
              value={gratisDesde}
              onChange={(e) => setGratisDesde(e.target.value)}
              disabled={!esDueno || !envio}
              className={`${inputCls} tabular`}
              style={inputStyle}
              placeholder="vacío = nunca"
            />
          </div>
        </div>

        <div>
          <label className="text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
            Hasta dónde se reparte
          </label>
          <input
            value={zona}
            onChange={(e) => setZona(e.target.value)}
            disabled={!esDueno || !envio}
            className={inputCls}
            style={inputStyle}
            placeholder="Rosario y Funes"
          />
        </div>

        <div className="border-t pt-3" style={{ borderColor: "#eef1f6" }}>
          <div className="text-[13px] font-semibold">Cómo paga</div>
          <div className="mt-2 flex items-center justify-between">
            <span>Reserva y paga al retirar o recibir</span>
            <Chip tone="success">Siempre disponible</Chip>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span>Mercado Pago</span>
            <Chip tone={config?.mp_habilitado ? "success" : "neutral"}>
              {config?.mp_habilitado ? "Activo" : "Falta configurar"}
            </Chip>
          </div>
          <div className="mt-1 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
            El cobro online se activa cuando esté cargada la clave de Mercado Pago del
            negocio. Hasta entonces la tienda vende igual: el cliente reserva y paga
            cuando retira o recibe.
          </div>
        </div>

        {esDueno && (
          <div className="flex justify-end pt-1">
            <BotonPrimario enviando={enviando}>Guardar configuración</BotonPrimario>
          </div>
        )}
      </div>
    </form>
  );
}
