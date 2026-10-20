import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Eraser,
  FileText,
  ImageIcon,
  Loader2,
  Paperclip,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useAsistente, type Adjunto } from "@/lib/asistente/conversacion";

/**
 * El asistente, con la tarjeta de confirmación adentro.
 *
 * Está montado en el shell y no en una pantalla: alguien puede querer preguntar
 * cuánto vendió mientras está cargando una compra, y mandarlo a otra ruta para
 * eso le haría perder lo que estaba escribiendo.
 *
 * Lo único que este archivo decide de verdad es que **el botón de Confirmar no
 * puede parecerse al de Cancelar**. Todo lo demás (qué se ejecuta, con qué
 * permisos, con qué sucursal) ya está resuelto abajo. Acá arriba la única forma
 * de romper algo es que una persona apurada apriete el botón equivocado.
 */

/** Base64 pesa un tercio más que el archivo. El servidor corta en 4 MB. */
const MAX_ARCHIVO = 2.5 * 1024 * 1024;

const TIPOS_IMAGEN = ["image/jpeg", "image/png", "image/webp", "image/gif"];

function leerComoBase64(archivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onerror = () => reject(new Error("No se pudo leer el archivo."));
    lector.onload = () => {
      const url = String(lector.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    lector.readAsDataURL(archivo);
  });
}

export function PanelAsistente() {
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState("");
  const [adjuntos, setAdjuntos] = useState<Adjunto[]>([]);
  const [avisoArchivo, setAvisoArchivo] = useState<string | null>(null);

  const {
    burbujas,
    pensando,
    error,
    restantes,
    pendiente,
    enviar,
    confirmar,
    cancelar,
    limpiar,
    haySucursal,
  } = useAsistente();

  const fin = useRef<HTMLDivElement | null>(null);
  const archivos = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fin.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [burbujas.length, pensando, pendiente]);

  async function agregarArchivos(lista: FileList | null) {
    if (!lista || lista.length === 0) return;
    setAvisoArchivo(null);
    const nuevos: Adjunto[] = [];

    for (const archivo of Array.from(lista)) {
      const esImagen = TIPOS_IMAGEN.includes(archivo.type);
      const esPdf = archivo.type === "application/pdf";
      if (!esImagen && !esPdf) {
        setAvisoArchivo(`${archivo.name}: tiene que ser una foto o un PDF.`);
        continue;
      }
      if (archivo.size > MAX_ARCHIVO) {
        setAvisoArchivo(`${archivo.name}: pesa demasiado. Sacá la foto más chica.`);
        continue;
      }
      nuevos.push({
        tipo: esPdf ? "pdf" : "imagen",
        media_type: archivo.type,
        datos: await leerComoBase64(archivo),
        nombre: archivo.name,
      });
    }

    if (nuevos.length > 0) setAdjuntos((a) => [...a, ...nuevos]);
    if (archivos.current) archivos.current.value = "";
  }

  async function mandar() {
    if (pensando || pendiente) return;
    if (!texto.trim() && adjuntos.length === 0) return;
    const t = texto;
    const a = adjuntos;
    setTexto("");
    setAdjuntos([]);
    setAvisoArchivo(null);
    await enviar(t, a);
  }

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={() => setAbierto(true)}
        title="Asistente"
        className="fixed bottom-5 right-5 z-40 grid h-12 w-12 place-items-center rounded-full text-white shadow-lg transition-transform hover:scale-105"
        style={{ background: "var(--primary)" }}
      >
        <Sparkles size={20} />
      </button>
    );
  }

  return (
    <div className="card-surface fixed bottom-5 right-5 z-40 flex w-[400px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden shadow-xl" style={{ height: "min(620px, calc(100vh - 3rem))" }}>
      {/* Encabezado */}
      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-2">
          <div
            className="grid h-7 w-7 place-items-center rounded-full"
            style={{ background: "var(--violet-bg)", color: "var(--violet)" }}
          >
            <Sparkles size={14} />
          </div>
          <div>
            <div className="text-[13px] font-semibold leading-4">Asistente</div>
            {typeof restantes === "number" && (
              <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                Te quedan {restantes} mensajes hoy
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={limpiar}
            disabled={pensando || burbujas.length === 0}
            title="Empezar de nuevo"
            className="grid h-7 w-7 place-items-center rounded-md disabled:opacity-40"
            style={{ color: "var(--muted-foreground)" }}
          >
            <Eraser size={15} />
          </button>
          <button
            type="button"
            onClick={() => setAbierto(false)}
            title="Cerrar"
            className="grid h-7 w-7 place-items-center rounded-md"
            style={{ color: "var(--muted-foreground)" }}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Conversación */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {burbujas.length === 0 && !pensando && (
          <div className="mt-6 text-center text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            <p>Pedile lo que necesites en castellano.</p>
            <p className="mt-2">
              "¿Cuánto vendimos hoy?" · "Cargá un gasto de $12.000 de luz" ·
              "Sacale una foto a la factura y cargala"
            </p>
            <p className="mt-3">
              Todo lo que mueva plata o stock te lo va a mostrar antes de hacerlo.
            </p>
          </div>
        )}

        {burbujas.map((b) => (
          <div key={b.id} className={b.quien === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className="max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-[13px] leading-5"
              style={
                b.quien === "user"
                  ? { background: "var(--primary)", color: "var(--primary-foreground)" }
                  : { background: "var(--background)", border: "1px solid var(--border)" }
              }
            >
              {b.texto}
            </div>
          </div>
        ))}

        {pendiente && <TarjetaConfirmacion pendiente={pendiente} onConfirmar={confirmar} onCancelar={cancelar} />}

        {pensando && (
          <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            <Loader2 size={13} className="animate-spin" />
            Pensando…
          </div>
        )}

        {error && (
          <div
            className="rounded-lg px-3 py-2 text-[12px]"
            style={{ background: "var(--danger-bg)", color: "var(--danger)" }}
          >
            {error}
          </div>
        )}

        <div ref={fin} />
      </div>

      {/* Escribir */}
      <div className="border-t px-3 py-2" style={{ borderColor: "var(--border)" }}>
        {!haySucursal && (
          <p className="mb-2 text-[12px]" style={{ color: "var(--warning)" }}>
            Esta computadora no tiene una sucursal activa: el asistente puede leer, pero no
            registrar movimientos.
          </p>
        )}

        {avisoArchivo && (
          <p className="mb-2 text-[12px]" style={{ color: "var(--danger)" }}>
            {avisoArchivo}
          </p>
        )}

        {adjuntos.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {adjuntos.map((a, i) => (
              <span
                key={`${a.nombre}-${i}`}
                className="chip"
                style={{ background: "var(--violet-bg)", color: "var(--violet)" }}
              >
                {a.tipo === "pdf" ? <FileText size={12} /> : <ImageIcon size={12} />}
                <span className="max-w-[140px] truncate">{a.nombre}</span>
                <button
                  type="button"
                  onClick={() => setAdjuntos((prev) => prev.filter((_, j) => j !== i))}
                  title="Sacar"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={archivos}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => void agregarArchivos(e.target.files)}
          />
          <button
            type="button"
            onClick={() => archivos.current?.click()}
            disabled={pensando || pendiente !== null}
            title="Adjuntar una factura (foto o PDF)"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md border disabled:opacity-40"
            style={{ borderColor: "var(--border)", color: "var(--muted-foreground)" }}
          >
            <Paperclip size={15} />
          </button>

          <textarea
            rows={1}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              // Enter manda, Shift+Enter hace un renglón. Es lo que la gente ya
              // tiene en los dedos de cualquier chat.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void mandar();
              }
            }}
            placeholder={pendiente ? "Confirmá o cancelá para seguir" : "Escribí lo que necesitás…"}
            disabled={pendiente !== null}
            className="max-h-28 min-h-9 flex-1 resize-none rounded-md border px-3 py-2 text-[13px] outline-none disabled:opacity-60"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
          />

          <button
            type="button"
            onClick={() => void mandar()}
            disabled={pensando || pendiente !== null || (!texto.trim() && adjuntos.length === 0)}
            title="Enviar"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-white disabled:opacity-40"
            style={{ background: "var(--primary)" }}
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Lo que se va a hacer, en castellano y con los montos, antes de hacerlo.
 *
 * Las irreversibles (`peligro`) se dibujan en rojo y con el botón rojo. No es
 * decoración: son las que después no se arreglan con otro movimiento, y quien
 * las aprieta tiene que haberse dado cuenta de eso antes y no después.
 */
function TarjetaConfirmacion({
  pendiente,
  onConfirmar,
  onCancelar,
}: {
  pendiente: NonNullable<ReturnType<typeof useAsistente>["pendiente"]>;
  onConfirmar: () => void;
  onCancelar: () => void;
}) {
  const { titulo, lineas, peligro } = pendiente.descripcion;

  return (
    <div
      className="rounded-lg border p-3"
      style={{
        borderColor: peligro ? "var(--danger)" : "var(--border)",
        background: peligro ? "var(--danger-bg)" : "var(--surface)",
      }}
    >
      <div className="flex items-center gap-2">
        {peligro && <AlertTriangle size={14} style={{ color: "var(--danger)" }} />}
        <div
          className="text-[13px] font-semibold"
          style={peligro ? { color: "var(--danger)" } : undefined}
        >
          {titulo}
        </div>
      </div>

      <ul className="mt-2 space-y-0.5 text-[12px] leading-5">
        {lineas.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>

      {peligro && (
        <p className="mt-2 text-[12px] font-medium" style={{ color: "var(--danger)" }}>
          Esto no se puede deshacer.
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onConfirmar}
          className="rounded-md px-3 py-1.5 text-[13px] font-medium text-white"
          style={{ background: peligro ? "var(--danger)" : "var(--primary)" }}
        >
          Confirmar
        </button>
        <button
          type="button"
          onClick={onCancelar}
          className="rounded-md border px-3 py-1.5 text-[13px] font-medium"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
