import { useState } from "react";
import { Alerta, BotonPrimario, BotonSecundario, Modal, inputCls, inputStyle } from "./Modal";
import { CONDICIONES_IVA } from "@/lib/fiscal";
import { supa } from "@/lib/supabase";

/**
 * Alta de proveedor. Los mismos campos fiscales que un cliente, y por lo mismo:
 * sin CUIT y sin condición ante ARCA no se le puede cargar una factura.
 *
 * Vivía dentro de `compras.tsx`. Se sacó acá cuando el pedido a proveedor
 * también necesitó cargar uno nuevo sin salir de la pantalla: el alta tiene que
 * ser una sola, no dos formularios que con el tiempo terminan pidiendo cosas
 * distintas.
 */
export function DialogoProveedor({
  onCerrar,
  onListo,
}: {
  onCerrar: () => void;
  /** Recibe el id del proveedor recién creado, para poder dejarlo elegido. */
  onListo: (proveedorId: string) => void | Promise<void>;
}) {
  const [nombre, setNombre] = useState("");
  const [cuit, setCuit] = useState("");
  const [condicion, setCondicion] = useState("responsable_inscripto");
  const [telefono, setTelefono] = useState("");
  const [email, setEmail] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    const limpio = cuit.replace(/\D/g, "");
    if (limpio && limpio.length !== 11) {
      setError("El CUIT tiene 11 números.");
      return;
    }
    setEnviando(true);
    setError(null);

    const { data, error: err } = await supa
      .from("proveedores")
      .insert({
        nombre: nombre.trim(),
        cuit: limpio || null,
        condicion_iva: condicion,
        telefono: telefono.trim() || null,
        email: email.trim() || null,
      })
      .select("id")
      .single();
    setEnviando(false);

    if (err) {
      setError(
        err.message.includes("proveedores_nombre_unico")
          ? "Ya hay un proveedor con ese nombre."
          : err.message,
      );
      return;
    }
    await onListo((data as { id: string }).id);
  }

  return (
    <Modal titulo="Nuevo proveedor" onCerrar={onCerrar}>
      <form onSubmit={(e) => void guardar(e)} className="space-y-3">
        <label className="block text-[12px] font-medium" style={{ color: "var(--muted-foreground)" }}>
          Nombre
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Dass S.A."
            required
            autoFocus
            className={inputCls}
            style={inputStyle}
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label
            className="block text-[12px] font-medium"
            style={{ color: "var(--muted-foreground)" }}
          >
            CUIT
            <input
              value={cuit}
              onChange={(e) => setCuit(e.target.value)}
              inputMode="numeric"
              placeholder="30712345678"
              className={`${inputCls} tabular`}
              style={inputStyle}
            />
          </label>
          <label
            className="block text-[12px] font-medium"
            style={{ color: "var(--muted-foreground)" }}
          >
            Condición de IVA
            <select
              value={condicion}
              onChange={(e) => setCondicion(e.target.value)}
              className={inputCls}
              style={inputStyle}
            >
              {CONDICIONES_IVA.map((c) => (
                <option key={c.valor} value={c.valor}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label
            className="block text-[12px] font-medium"
            style={{ color: "var(--muted-foreground)" }}
          >
            Teléfono
            <input
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              className={inputCls}
              style={inputStyle}
            />
          </label>
          <label
            className="block text-[12px] font-medium"
            style={{ color: "var(--muted-foreground)" }}
          >
            Mail
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
              style={inputStyle}
            />
          </label>
        </div>

        {error && <Alerta tono="danger">{error}</Alerta>}

        <div className="flex justify-end gap-2 pt-2">
          <BotonSecundario onClick={onCerrar}>Cancelar</BotonSecundario>
          <BotonPrimario enviando={enviando} disabled={!nombre.trim()}>
            Guardar
          </BotonPrimario>
        </div>
      </form>
    </Modal>
  );
}
