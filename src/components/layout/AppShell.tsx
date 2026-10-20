import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { useSesion, RUTAS_POR_ROL, ROL_LABEL } from "@/lib/sesion";
import { useRouterState, Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { PanelAsistente } from "@/components/asistente/PanelAsistente";

export function AppShell({ children }: { children: ReactNode }) {
  const { usuario } = useSesion();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // La Guardia ya garantiza que hay usuario; esto es solo para el tipo.
  if (!usuario) return null;

  const rutas = RUTAS_POR_ROL[usuario.rol];
  const allowed = rutas.includes(pathname);
  const inicio = rutas[0] ?? "/";

  return (
    <div className="min-h-screen" style={{ background: "var(--background)" }}>
      <Sidebar />
      <div style={{ marginLeft: 224 }}>
        <Topbar />
        <main className="px-6 py-5">
          {allowed ? (
            children
          ) : (
            <div className="card-surface mx-auto mt-24 max-w-md p-8 text-center">
              <div
                className="mx-auto grid h-12 w-12 place-items-center rounded-full"
                style={{ background: "var(--warning-bg)", color: "var(--warning)" }}
              >
                <Lock size={20} />
              </div>
              <h2 className="mt-4 text-[16px] font-semibold">Sección no disponible</h2>
              <p className="mt-1 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
                Tu rol ({ROL_LABEL[usuario.rol]}) no tiene acceso a esta pantalla.
              </p>
              <Link
                to={inicio}
                className="mt-4 inline-block rounded-md px-4 py-2 text-[13px] font-medium text-white"
                style={{ background: "var(--primary)" }}
              >
                Volver a mi inicio
              </Link>
            </div>
          )}
        </main>
      </div>
      {/* Va en el shell y no en cada pantalla: la conversación no se pierde al
          cambiar de sección. */}
      <PanelAsistente />
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 text-[13px]" style={{ color: "var(--muted-foreground)" }}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
