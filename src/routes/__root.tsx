import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { AppShell } from "@/components/layout/AppShell";
import { SesionProvider } from "@/lib/sesion";
import { Guardia } from "@/components/acceso/Acceso";

function ErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Ocurrió un error</h1>
        <p className="mt-2 text-sm" style={{ color: "var(--muted-foreground)" }}>
          Algo salió mal. Podés reintentar.
        </p>
        <button
          onClick={() => { router.invalidate(); reset(); }}
          className="mt-4 rounded-md px-4 py-2 text-sm font-medium text-white"
          style={{ background: "var(--primary)" }}
        >
          Reintentar
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "PymeOS — Gestión para pymes" },
      { name: "description", content: "PymeOS: sistema de gestión para negocios de calzado y deportes en Rosario. Ventas, stock, facturación y más." },
      { property: "og:title", content: "PymeOS — Gestión para pymes" },
      { property: "og:description", content: "Sistema de gestión multisucursal para pymes: ventas, stock, facturación y caja." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&display=swap" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="es-AR">
      <head><HeadContent /></head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Pantallas que se abren con un link y sin cuenta: el cliente siguiendo su
 * entrega y el celular del repartidor. No pueden pasar por la Guardia, que
 * manda a la pantalla de login a cualquiera sin sesión. Tampoco por el
 * AppShell: nadie de afuera tiene que ver el menú del sistema.
 *
 * Lo que protege a estas páginas no es el login: es el token del link, y que
 * del otro lado hay funciones que devuelven solo lo que corresponde mostrar.
 */
const RUTAS_PUBLICAS = ["/seguimiento/", "/reparto/", "/comprar", "/pedido/"];

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const publica = RUTAS_PUBLICAS.some((p) => pathname.startsWith(p));

  if (publica) {
    return (
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <SesionProvider>
        <Guardia>
          <AppShell>
            <Outlet />
          </AppShell>
        </Guardia>
      </SesionProvider>
    </QueryClientProvider>
  );
}
