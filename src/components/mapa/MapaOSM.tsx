import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Un mapa chico, hecho a mano, sin librería.
 *
 * Podría haberse instalado Leaflet, pero para lo que hace falta acá (ver un
 * punto moverse por Rosario) alcanza con pedirle las imágenes a OpenStreetMap
 * y acomodarlas. Son gratis y no piden clave de nada: el sistema no depende de
 * que alguien pague un abono para que un cliente vea dónde está su pedido.
 *
 * La cuenta es la misma que usa cualquier mapa web (proyección Mercator):
 * el mundo entero es un cuadrado de 256 × 2^zoom píxeles, y cada tile es un
 * recorte de 256×256 de ese cuadrado.
 */

export type PuntoMapa = {
  lat: number;
  lng: number;
  tipo: "local" | "destino" | "repartidor";
  etiqueta?: string;
};

const TAM_TILE = 256;
const ZOOM_MIN = 3;
const ZOOM_MAX = 18;

const COLORES: Record<PuntoMapa["tipo"], string> = {
  local: "#667085",
  destino: "#b84a24",
  repartidor: "#12915e",
};

function proyectar(lat: number, lng: number, zoom: number) {
  const mundo = TAM_TILE * Math.pow(2, zoom);
  const seno = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * mundo,
    y: (0.5 - Math.log((1 + seno) / (1 - seno)) / (4 * Math.PI)) * mundo,
  };
}

function desproyectar(x: number, y: number, zoom: number) {
  const mundo = TAM_TILE * Math.pow(2, zoom);
  const lng = (x / mundo) * 360 - 180;
  const n = Math.PI - 2 * Math.PI * (y / mundo);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

/** El zoom más cercano que deja entrar todos los puntos con aire alrededor. */
function encuadrar(puntos: PuntoMapa[], ancho: number, alto: number) {
  const centro = {
    lat: (Math.min(...puntos.map((p) => p.lat)) + Math.max(...puntos.map((p) => p.lat))) / 2,
    lng: (Math.min(...puntos.map((p) => p.lng)) + Math.max(...puntos.map((p) => p.lng))) / 2,
  };
  if (puntos.length === 1) return { centro, zoom: 15 };

  for (let z = ZOOM_MAX; z >= ZOOM_MIN; z--) {
    const xs = puntos.map((p) => proyectar(p.lat, p.lng, z).x);
    const ys = puntos.map((p) => proyectar(p.lat, p.lng, z).y);
    const anchoNecesario = Math.max(...xs) - Math.min(...xs) + 80;
    const altoNecesario = Math.max(...ys) - Math.min(...ys) + 80;
    if (anchoNecesario <= ancho && altoNecesario <= alto) return { centro, zoom: z };
  }
  return { centro, zoom: ZOOM_MIN };
}

export function MapaOSM({
  puntos,
  recorrido,
  alto = 260,
}: {
  puntos: PuntoMapa[];
  recorrido?: { lat: number; lng: number }[];
  alto?: number;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const [medida, setMedida] = useState({ ancho: 0, alto });
  const [vista, setVista] = useState<{ centro: { lat: number; lng: number }; zoom: number } | null>(null);
  // Una vez que alguien movió el mapa con el dedo, dejamos de reencuadrarlo
  // solo: sería molesto que se vuelva a acomodar cada vez que llega una
  // posición nueva mientras la persona está mirando otra parte.
  const movidoAMano = useRef(false);
  const arrastre = useRef<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = caja.current;
    if (!el) return;
    const medir = () => setMedida({ ancho: el.clientWidth, alto: el.clientHeight });
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(el);
    return () => observador.disconnect();
  }, []);

  useEffect(() => {
    if (medida.ancho === 0 || puntos.length === 0) return;
    if (movidoAMano.current) return;
    setVista(encuadrar(puntos, medida.ancho, medida.alto));
  }, [puntos, medida.ancho, medida.alto]);

  const mover = useCallback(
    (dx: number, dy: number) => {
      setVista((v) => {
        if (!v) return v;
        const p = proyectar(v.centro.lat, v.centro.lng, v.zoom);
        return { ...v, centro: desproyectar(p.x - dx, p.y - dy, v.zoom) };
      });
    },
    [],
  );

  if (puntos.length === 0) {
    return (
      <div
        className="grid place-items-center rounded-md text-[12px]"
        style={{ height: alto, background: "#eef1f6", color: "var(--muted-foreground)" }}
      >
        Todavía no hay nada que mostrar en el mapa.
      </div>
    );
  }

  const listo = vista !== null && medida.ancho > 0;
  const zoom = vista?.zoom ?? 14;
  const centroPx = vista ? proyectar(vista.centro.lat, vista.centro.lng, zoom) : { x: 0, y: 0 };
  const esquina = { x: centroPx.x - medida.ancho / 2, y: centroPx.y - medida.alto / 2 };

  const tiles: { x: number; y: number; izq: number; arr: number }[] = [];
  if (listo) {
    const maxTile = Math.pow(2, zoom);
    for (let tx = Math.floor(esquina.x / TAM_TILE); tx <= Math.floor((esquina.x + medida.ancho) / TAM_TILE); tx++) {
      for (let ty = Math.floor(esquina.y / TAM_TILE); ty <= Math.floor((esquina.y + medida.alto) / TAM_TILE); ty++) {
        if (ty < 0 || ty >= maxTile) continue;
        tiles.push({
          x: ((tx % maxTile) + maxTile) % maxTile,
          y: ty,
          izq: tx * TAM_TILE - esquina.x,
          arr: ty * TAM_TILE - esquina.y,
        });
      }
    }
  }

  const enPantalla = (lat: number, lng: number) => {
    const p = proyectar(lat, lng, zoom);
    return { izq: p.x - esquina.x, arr: p.y - esquina.y };
  };

  const linea = (recorrido ?? [])
    .map((p) => {
      const { izq, arr } = enPantalla(p.lat, p.lng);
      return `${izq.toFixed(1)},${arr.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div
      ref={caja}
      className="relative overflow-hidden rounded-md select-none"
      style={{ height: alto, background: "#e8eaed", cursor: arrastre.current ? "grabbing" : "grab" }}
      onPointerDown={(e) => {
        movidoAMano.current = true;
        arrastre.current = { x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!arrastre.current) return;
        mover(e.clientX - arrastre.current.x, e.clientY - arrastre.current.y);
        arrastre.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={() => { arrastre.current = null; }}
      onPointerCancel={() => { arrastre.current = null; }}
    >
      {tiles.map((t) => (
        <img
          key={`${zoom}-${t.x}-${t.y}`}
          src={`https://tile.openstreetmap.org/${zoom}/${t.x}/${t.y}.png`}
          alt=""
          draggable={false}
          className="absolute"
          style={{ left: t.izq, top: t.arr, width: TAM_TILE, height: TAM_TILE }}
        />
      ))}

      {linea && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <polyline points={linea} fill="none" stroke="#12915e" strokeWidth={3} strokeOpacity={0.7} strokeLinejoin="round" />
        </svg>
      )}

      {puntos.map((p, i) => {
        const { izq, arr } = enPantalla(p.lat, p.lng);
        const color = COLORES[p.tipo];
        return (
          <div key={i} className="pointer-events-none absolute" style={{ left: izq, top: arr }}>
            <div
              style={{
                width: p.tipo === "repartidor" ? 16 : 13,
                height: p.tipo === "repartidor" ? 16 : 13,
                marginLeft: p.tipo === "repartidor" ? -8 : -6.5,
                marginTop: p.tipo === "repartidor" ? -8 : -6.5,
                borderRadius: 999,
                background: color,
                border: "2.5px solid #fff",
                boxShadow: "0 1px 4px rgba(16,24,40,.4)",
              }}
            />
            {p.etiqueta && (
              <div
                className="absolute whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium"
                style={{ left: 10, top: -8, background: "rgba(255,255,255,.92)", color: "var(--foreground)" }}
              >
                {p.etiqueta}
              </div>
            )}
          </div>
        );
      })}

      <div className="absolute right-2 top-2 flex flex-col gap-1">
        {[1, -1].map((paso) => (
          <button
            key={paso}
            type="button"
            onClick={() => {
              movidoAMano.current = true;
              setVista((v) => (v ? { ...v, zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.zoom + paso)) } : v));
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-[15px] font-semibold"
            style={{ background: "rgba(255,255,255,.94)", color: "var(--foreground)", boxShadow: "0 1px 3px rgba(16,24,40,.25)" }}
            aria-label={paso > 0 ? "Acercar" : "Alejar"}
          >
            {paso > 0 ? "+" : "−"}
          </button>
        ))}
      </div>

      {/* OpenStreetMap pide que se lo nombre. Es lo único que cobra. */}
      <div
        className="absolute bottom-0 right-0 px-1 text-[9px]"
        style={{ background: "rgba(255,255,255,.8)", color: "#475467" }}
      >
        © OpenStreetMap
      </div>
    </div>
  );
}
