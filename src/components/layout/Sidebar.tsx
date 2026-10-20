import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  ShoppingCart,
  Contact,
  Store,
  Truck,
  MessageSquare,
  Boxes,
  Receipt,
  PackageSearch,
  Wallet,
  Banknote,
  PieChart,
  FileText,
  Users,
  Settings,
  LogOut,
} from "lucide-react";
import { useSesion, RUTAS_POR_ROL } from "@/lib/sesion";

type Item = { to: string; label: string; icon: React.ComponentType<{ size?: number }> };

const groups: { label?: string; items: Item[] }[] = [
  { items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard }] },
  {
    label: "Operación",
    items: [
      { to: "/ventas", label: "Ventas / POS", icon: ShoppingCart },
      { to: "/clientes", label: "Clientes", icon: Contact },
      { to: "/tienda", label: "Tienda online", icon: Store },
      { to: "/pedidos", label: "Pedidos y envíos", icon: Truck },
      { to: "/atencion", label: "Atención al cliente", icon: MessageSquare },
    ],
  },
  {
    label: "Administración",
    items: [
      { to: "/stock", label: "Stock", icon: Boxes },
      { to: "/gastos", label: "Gastos", icon: Receipt },
      { to: "/compras", label: "Compras", icon: PackageSearch },
      { to: "/caja", label: "Caja", icon: Wallet },
      { to: "/cheques", label: "Cheques", icon: Banknote },
      { to: "/resultado", label: "Resultado", icon: PieChart },
      { to: "/facturacion", label: "Facturación", icon: FileText },
      { to: "/empleados", label: "Empleados", icon: Users },
    ],
  },
  {
    label: "Sistema",
    items: [{ to: "/configuracion", label: "Configuración", icon: Settings }],
  },
];

export function Sidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { usuario, sucursalEquipo, verTodas, cerrarSesion } = useSesion();
  const allowed = usuario ? RUTAS_POR_ROL[usuario.rol] : [];

  return (
    <aside
      className="fixed left-0 top-0 flex h-screen w-56 flex-col"
      style={{ background: "var(--sidebar)", color: "var(--sidebar-foreground)" }}
    >
      <div className="px-4 pt-5 pb-4" style={{ borderBottom: "1px solid var(--sidebar-border)" }}>
        <div className="text-[20px] font-bold tracking-tight">
          Pyme<span style={{ color: "var(--primary)" }}>OS</span>
        </div>
        <div className="mt-2 text-[12px]" style={{ color: "var(--sidebar-muted)" }}>
          {sucursalEquipo?.nombre ?? "Sin sucursal"}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--sidebar-muted)" }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: verTodas ? "#f5a623" : "#12d18e",
              display: "inline-block",
            }}
          />
          {verTodas ? "Viendo las dos · solo lectura" : "Equipo activo en esta sucursal"}
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {groups.map((g, gi) => {
          const items = g.items.filter((i) => allowed.includes(i.to));
          if (items.length === 0) return null;
          return (
            <div key={gi} className="mb-3">
              {g.label && (
                <div
                  className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: "var(--sidebar-muted)" }}
                >
                  {g.label}
                </div>
              )}
              {items.map((it) => {
                const active = pathname === it.to;
                const Icon = it.icon;
                return (
                  <Link
                    key={it.to}
                    to={it.to}
                    className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors"
                    style={{
                      background: active ? "var(--sidebar-active)" : "transparent",
                      color: active ? "#fff" : "var(--sidebar-foreground)",
                    }}
                  >
                    <Icon size={16} />
                    <span>{it.label}</span>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className="px-2 py-3" style={{ borderTop: "1px solid var(--sidebar-border)" }}>
        <button
          onClick={() => void cerrarSesion()}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px]"
          style={{ color: "var(--sidebar-muted)" }}
        >
          <LogOut size={16} />
          Cerrar sesión
        </button>
      </div>
    </aside>
  );
}
