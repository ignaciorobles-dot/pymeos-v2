import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Vista, MotivoSimple } from "../src/routes/facturacion";
import "../src/styles.css";
function Prueba() {
  const [modal, setModal] = useState(false);
  const [estado, setEstado] = useState<"pendiente" | "anulado">("pendiente");
  const [dueno, setDueno] = useState(true);
  const [enviado, setEnviado] = useState(false);
  const [motivo, setMotivo] = useState("");
  const c = { id: "ficticio", sucursal_id: "s1", venta_id: "v1", comprobante_origen_id: null,
    tipo: "B", punto_venta: 3, numero: null, fecha: "2026-09-30", emisor_nombre: "DEMOSTRACIÓN AISLADA",
    emisor_cuit: "30700000001", emisor_condicion_iva: "responsable_inscripto", emisor_direccion: null,
    receptor_nombre: "Cliente ficticio", receptor_tipo_documento: "DNI", receptor_documento: null,
    receptor_condicion_iva: "consumidor_final", receptor_direccion: null, neto: 100, iva: 21, total: 121,
    estado, cae: null, cae_vencimiento: null, qr_url: null, observacion: null, motivo,
    created_at: "2026-09-30", sucursal: null, revision_estado: "pendiente", idempotency_key: enviado ? "simulada" : null,
    job_id: null, intento: enviado ? 1 : 0, emitido_at: null, envio_solicitado_at: null };
  return <main style={{padding:24}}>
    <h1>SIMULACIÓN DE DESCARTE — SIN RED NI DATOS REALES</h1>
    <button onClick={()=>setDueno(!dueno)}>Cambiar rol: {dueno ? "dueño" : "contador"}</button>
    <button onClick={()=>setEnviado(!enviado)}>Enviado: {String(enviado)}</button>
    <Vista comprobante={c} lineas={[]} cargando={false} esDueno={dueno} puedeAutorizar
      onRevisar={()=>{}} onCae={()=>{}} onPedirCae={()=>{}} pidiendoCae={false} avisoCae={null}
      onRechazar={()=>{}} onNotaCredito={()=>{}} onDescartar={()=>setModal(true)} />
    {modal && <MotivoSimple titulo="Descartar borrador sin enviar" ayuda="Se conserva el historial, la venta, los cobros y el stock. La venta sigue pendiente de facturación."
      etiqueta="Motivo" textoBoton="Confirmar descarte" onCerrar={()=>setModal(false)}
      onEnviar={async texto=>{if(texto.length<3)return {error:{message:"Indicá un motivo de al menos 3 caracteres"}};setMotivo(texto);setEstado("anulado");return {error:null};}}
      onListo={()=>setModal(false)} />}
    <p>Venta ficticia: conservada · Stock y cobros: sin cambios</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Prueba/>);
