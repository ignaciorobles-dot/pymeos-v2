import { createRoot } from "react-dom/client";
import { MesaFiscal } from "../src/components/facturas/MesaFiscal";
import "../src/styles.css";
createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 24 }}>
    <h1>SIMULACIÓN AISLADA — SIN EFECTO FISCAL</h1>
    <MesaFiscal
      mes="2026-09"
      sucursalId="s1"
      puedeAutorizar
      onCambio={() => {}}
      onAbrir={() => {}}
    />
  </main>,
);
