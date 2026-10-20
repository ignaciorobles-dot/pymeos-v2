export type Product = {
  id: string;
  name: string;
  brand: string;
  size: number;
  color: string;
  cost: number;
  price: number;
  stockCentro: number;
  stockNorte: number;
  image: string;
};

const IMG = (seed: string) =>
  `https://images.unsplash.com/photo-${seed}?auto=format&fit=crop&w=200&q=60`;

export const products: Product[] = [
  { id: "SKU-001", name: "Nike Air Max 90", brand: "Nike", size: 42, color: "Blanco", cost: 89000, price: 189900, stockCentro: 4, stockNorte: 2, image: IMG("1542291026-7eec264c27ff") },
  { id: "SKU-002", name: "Nike Air Max 90", brand: "Nike", size: 43, color: "Blanco", cost: 89000, price: 189900, stockCentro: 1, stockNorte: 3, image: IMG("1542291026-7eec264c27ff") },
  { id: "SKU-003", name: "Adidas Superstar", brand: "Adidas", size: 40, color: "Blanco/Negro", cost: 74000, price: 159900, stockCentro: 6, stockNorte: 5, image: IMG("1600185365483-26d7a4cc7519") },
  { id: "SKU-004", name: "Adidas Superstar", brand: "Adidas", size: 41, color: "Blanco/Negro", cost: 74000, price: 159900, stockCentro: 0, stockNorte: 2, image: IMG("1600185365483-26d7a4cc7519") },
  { id: "SKU-005", name: "Nike Court Vision", brand: "Nike", size: 39, color: "Blanco", cost: 62000, price: 129900, stockCentro: 8, stockNorte: 4, image: IMG("1595950653106-6c9ebd614d3a") },
  { id: "SKU-006", name: "Puma RS-X", brand: "Puma", size: 42, color: "Gris/Rojo", cost: 78000, price: 174900, stockCentro: 2, stockNorte: 1, image: IMG("1608231387042-66d1773070a5") },
  { id: "SKU-007", name: "Topper Rod Star", brand: "Topper", size: 38, color: "Negro", cost: 24000, price: 54900, stockCentro: 12, stockNorte: 9, image: IMG("1520256862855-398228c41684") },
  { id: "SKU-008", name: "New Balance 574", brand: "New Balance", size: 44, color: "Gris", cost: 95000, price: 199900, stockCentro: 3, stockNorte: 0, image: IMG("1539185441755-769473a23570") },
  { id: "SKU-009", name: "Adidas Campus 00s", brand: "Adidas", size: 41, color: "Verde", cost: 92000, price: 194900, stockCentro: 5, stockNorte: 3, image: IMG("1595950653106-6c9ebd614d3a") },
  { id: "SKU-010", name: "Nike Dunk Low", brand: "Nike", size: 43, color: "Panda", cost: 110000, price: 229900, stockCentro: 1, stockNorte: 2, image: IMG("1600269452121-4f2416e55c28") },
  { id: "SKU-011", name: "Fila Disruptor", brand: "Fila", size: 37, color: "Blanco", cost: 55000, price: 119900, stockCentro: 7, stockNorte: 4, image: IMG("1600185365483-26d7a4cc7519") },
  { id: "SKU-012", name: "Reebok Classic", brand: "Reebok", size: 45, color: "Blanco", cost: 60000, price: 124900, stockCentro: 2, stockNorte: 6, image: IMG("1608231387042-66d1773070a5") },
];

export const salesLast30 = Array.from({ length: 30 }, (_, i) => ({
  day: `${i + 1}`,
  ventas: Math.round(180000 + Math.random() * 320000 + Math.sin(i / 3) * 80000),
}));

export const recentMovements = [
  { time: "12:48", type: "Venta", detail: "Nike Air Max 90 T.42", amount: 189900, branch: "Centro" },
  { time: "12:31", type: "Venta", detail: "Adidas Superstar T.40", amount: 159900, branch: "Centro" },
  { time: "12:10", type: "Gasto", detail: "Flete OCA", amount: -18500, branch: "Norte" },
  { time: "11:52", type: "Venta", detail: "Topper Rod Star T.38 x2", amount: 109800, branch: "Norte" },
  { time: "11:20", type: "Venta", detail: "New Balance 574 T.44", amount: 199900, branch: "Centro" },
  { time: "10:45", type: "Ingreso caja", detail: "Saldo inicial", amount: 50000, branch: "Centro" },
];

export const orders = [
  { id: "PED-1042", cliente: "Sofía Ramírez", productos: "Nike Air Max 90 T.42", total: 189900, estado: "en camino", direccion: "Bv. Oroño 1240, Rosario", repartidor: "Andes Envíos" },
  { id: "PED-1041", cliente: "Martín López", productos: "Adidas Superstar T.41", total: 159900, estado: "preparando", direccion: "Pellegrini 850, Rosario", repartidor: "—" },
  { id: "PED-1040", cliente: "Juliana Paz", productos: "New Balance 574 T.44", total: 199900, estado: "pendiente", direccion: "Mitre 1520, Rosario", repartidor: "—" },
  { id: "PED-1039", cliente: "Ezequiel Díaz", productos: "Puma RS-X T.42, Topper T.38", total: 229800, estado: "entregado", direccion: "San Luis 3020, Rosario", repartidor: "Andreani" },
  { id: "PED-1038", cliente: "Carla Vega", productos: "Nike Dunk Low T.43", total: 229900, estado: "en camino", direccion: "Alberdi 750, Rosario", repartidor: "Andes Envíos" },
];

export const tickets = [
  { id: "T-221", cliente: "Sofía Ramírez", asunto: "Consulta talle Air Max", estado: "abierto", ultimo: "hace 5 min" },
  { id: "T-220", cliente: "Martín López", asunto: "Cambio de zapatilla", estado: "respondido", ultimo: "hace 22 min" },
  { id: "T-219", cliente: "Juliana Paz", asunto: "¿Hacen envío a Funes?", estado: "abierto", ultimo: "hace 1 h" },
  { id: "T-218", cliente: "Ezequiel Díaz", asunto: "Factura A", estado: "cerrado", ultimo: "ayer" },
  { id: "T-217", cliente: "Carla Vega", asunto: "Demora en envío", estado: "respondido", ultimo: "ayer" },
];

export const expenses = [
  { id: 1, categoria: "Alquiler", detalle: "Alquiler local Calle Demo 123", monto: 780000, fecha: "01/07/2026", sucursal: "Centro" },
  { id: 2, categoria: "Luz", detalle: "EPE julio", monto: 92400, fecha: "05/07/2026", sucursal: "Centro" },
  { id: 3, categoria: "Sueldos", detalle: "Sueldo vendedor", monto: 620000, fecha: "05/07/2026", sucursal: "Norte" },
  { id: 4, categoria: "Fletes", detalle: "Reparto Andreani", monto: 45200, fecha: "12/07/2026", sucursal: "Norte" },
  { id: 5, categoria: "Insumos", detalle: "Bolsas y etiquetas", monto: 28900, fecha: "14/07/2026", sucursal: "Centro" },
  { id: 6, categoria: "Marketing", detalle: "Meta Ads", monto: 65000, fecha: "18/07/2026", sucursal: "Centro" },
];

export const purchases = [
  { id: "C-0342", proveedor: "Dass S.A. (Nike)", fecha: "10/07/2026", total: 2480000, estado: "pagada", items: 24 },
  { id: "C-0341", proveedor: "Dist. Adidas Litoral", fecha: "08/07/2026", total: 1590000, estado: "parcial", items: 18 },
  { id: "C-0340", proveedor: "Topper Mayorista", fecha: "02/07/2026", total: 720000, estado: "pendiente", items: 30 },
];

export const invoices = [
  { tipo: "B", numero: "0001-00012845", pv: "0001", cliente: "Consumidor Final", monto: 189900, cae: "74128593012845", estado: "Emitida", fecha: "22/07/2026" },
  { tipo: "A", numero: "0001-00012844", pv: "0001", cliente: "Deportes Ríos SRL", monto: 894500, cae: "74128593012844", estado: "Emitida", fecha: "22/07/2026" },
  { tipo: "B", numero: "0002-00008120", pv: "0002", cliente: "Consumidor Final", monto: 159900, cae: "—", estado: "Pendiente de CAE", fecha: "22/07/2026" },
  { tipo: "C", numero: "0002-00008119", pv: "0002", cliente: "Consumidor Final", monto: 54900, cae: "—", estado: "Rechazada", fecha: "22/07/2026" },
  { tipo: "B", numero: "0001-00012843", pv: "0001", cliente: "Consumidor Final", monto: 229900, cae: "74128593012843", estado: "Emitida", fecha: "21/07/2026" },
];

export const employees = [
  { nombre: "Ana Demo", rol: "Dueño", sucursal: "Ambas", estado: "activo", email: "ana@ejemplo.com" },
  { nombre: "Bruno Ejemplo", rol: "Vendedor", sucursal: "Centro", estado: "activo", email: "bruno@ejemplo.com" },
  { nombre: "Carla Prueba", rol: "Vendedor", sucursal: "Norte", estado: "activo", email: "carla@ejemplo.com" },
  { nombre: "Estudio Contable Demo", rol: "Contador", sucursal: "Ambas", estado: "activo", email: "contador@ejemplo.com" },
  { nombre: "Dana Muestra", rol: "Vendedor", sucursal: "Centro", estado: "inactivo", email: "dana@ejemplo.com" },
];

export const cashMovements = [
  { time: "09:00", tipo: "Apertura", detalle: "Saldo inicial", monto: 80000 },
  { time: "10:12", tipo: "Venta", detalle: "Ticket B 12841 — Efectivo", monto: 54900 },
  { time: "10:45", tipo: "Venta", detalle: "Ticket B 12842 — Efectivo", monto: 129900 },
  { time: "11:20", tipo: "Retiro", detalle: "Depósito bancario", monto: -100000 },
  { time: "11:52", tipo: "Venta", detalle: "Ticket B 12843 — Efectivo", monto: 109800 },
  { time: "12:48", tipo: "Venta", detalle: "Ticket B 12845 — Efectivo", monto: 189900 },
];
