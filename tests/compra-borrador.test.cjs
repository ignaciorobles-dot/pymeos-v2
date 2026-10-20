const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.PYMEOS_TYPESCRIPT || 'typescript');
function cargar(rel, deps = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: n => {
    if (n in deps) return deps[n];
    throw Error(`Importación no autorizada: ${n}`);
  }, localStorage: storage, fetch: () => { throw Error('Red prohibida'); } });
  return exports;
}
const valores = new Map();
const storage = { getItem: k => valores.get(k) ?? null, setItem: (k, v) => valores.set(k, v) };
const compra = cargar('src/lib/asistente/compra-borrador.ts');
const catalogo = cargar('src/lib/asistente/analisis-catalogo.ts');
const herramientas = cargar('supabase/functions/asistente/herramientas.ts');
let uid = 'usuario-1';
let paginasCatalogo = null;
const ejecutor = cargar('src/lib/asistente/ejecutor.ts', {
  '@/lib/supabase': { supa: { auth: { getUser: async () => ({ data: { user: { id: uid } } }) },
    from: tabla => {
      if (tabla !== 'variantes' || paginasCatalogo === null) throw Error('Acceso a tablas prohibido');
      const query = { select: () => query, eq: () => query, order: () => query,
        range: async (desde, hasta) => ({ data: paginasCatalogo.slice(desde, hasta + 1), error: null }) };
      return query;
    }, rpc: () => { throw Error('RPC prohibida'); } } },
  '@/lib/format': { formatARS: v => String(v) },
  '../../../supabase/functions/asistente/herramientas': herramientas,
  './compra-borrador': compra,
  './analisis-catalogo': catalogo,
});
const factura = () => ({ documento: 'compra', proveedor: 'Global Brands S.A.', cuit: '30711925763',
  tipo_comprobante: 'factura_a', punto_venta: '0023', numero_comprobante: '00028806', fecha: '2026-08-24',
  total_unidades: 48, subtotal: 1089696, iva: 228836.16, percepciones: 16345.44, total: 1334877.60,
  lineas: [12, 12, 24].map((unidades, i) => ({ codigo: ['61102810010','61102810030','61102870020'][i],
    descripcion: i < 2 ? 'RIDER R LINE PLUS II PAPETE INF' : 'RIDER PUMP III SLIDE AD',
    unidades, costo_unitario: 22702, variantes: [] })) });
test('48 unidades no inventan variantes y conserva impuestos', () => {
  const r = compra.prepararCompra(factura());
  assert.equal(r.unidades_leidas, 48);
  assert.equal(r.estado, 'pendiente');
  assert.equal(r.borrador.total, 1334877.60);
  assert.equal(r.borrador.lineas[0].variantes.length, 0);
  assert(r.pendientes.some(p => p.includes('distribución')));
  assert(r.tareas_sistema.some(p => p.includes('IVA')));
  assert.equal(r.stock_modificado, false);
});
test('ticket de cambio no representa recepción de stock', async () => {
  const r = await ejecutor.ejecutarHerramienta('guardar_borrador_compra', { ...factura(), documento: 'ticket_cambio' }, 'matienzo');
  assert.equal(r.ok, false);
  assert.equal(valores.size, 0);
});
test('guarda y retoma sin consultas de tablas ni RPC', async () => {
  assert(herramientas.ACCIONES.has('guardar_borrador_compra'));
  assert(herramientas.TOOLS.some(t => t.name === 'guardar_borrador_compra'));
  assert.equal((await ejecutor.ejecutarHerramienta('guardar_borrador_compra', factura(), 'matienzo')).ok, true);
  const r = await ejecutor.ejecutarHerramienta('consultar_borradores_compra', {}, 'matienzo');
  assert.equal(r.datos.borradores.length, 1);
  assert.equal(r.datos.borradores[0].borrador.total_unidades, 48);
});
test('mismo comprobante con ceros diferentes reemplaza borrador, no duplica', async () => {
  await ejecutor.ejecutarHerramienta('guardar_borrador_compra', { ...factura(), punto_venta: '23', numero_comprobante: '28806' }, 'matienzo');
  const r = await ejecutor.ejecutarHerramienta('consultar_borradores_compra', {}, 'matienzo');
  assert.equal(r.datos.borradores.length, 1);
});
test('aislamiento por sucursal y por usuario', async () => {
  assert.equal((await ejecutor.ejecutarHerramienta('consultar_borradores_compra', {}, 'otra')).datos.borradores.length, 0);
  uid = 'usuario-2';
  assert.equal((await ejecutor.ejecutarHerramienta('consultar_borradores_compra', {}, 'matienzo')).datos.borradores.length, 0);
  uid = 'usuario-1';
});
test('cantidades fraccionarias, números negativos y desconocidos quedan pendientes', () => {
  const f = factura(); f.lineas[0].unidades = 1.5; f.iva = undefined; f.total = -1;
  const r = compra.prepararCompra(f);
  assert.equal(r.borrador.iva, null); assert.equal(r.borrador.total, null);
  assert.equal(r.borrador.lineas[0].unidades, null);
  assert(r.pendientes.some(p => p.includes('unidades')));
});
test('rechaza como listo un desglose de talles que no suma', () => {
  const f = factura();
  f.lineas[0].variantes = [{ variante_id: 'ejemplo', talle: '30', color: 'azul', cantidad: 2 }];
  assert(compra.prepararCompra(f).pendientes.some(p => p.includes('suman 2')));
});
test('descuadre monetario y fecha imposible quedan pendientes', () => {
  const f = factura(); f.total = 1; f.fecha = '2026-02-30';
  const r = compra.prepararCompra(f);
  assert(r.pendientes.some(p => p.includes('total no coincide')));
  assert(r.pendientes.some(p => p.includes('fecha válida')));
});
test('tarjeta no promete alta contable ni de stock', async () => {
  const d = await ejecutor.describirHerramienta('guardar_borrador_compra', factura());
  assert(d.titulo.includes('sin ingresar stock'));
  assert(d.lineas.some(l => l.includes('1334877.6')));
});
test('almacenamiento roto falla cerrado sin sobrescribir', async () => {
  const k = compra.claveBorradores('usuario-1','rota'); valores.set(k, '{');
  const r = await ejecutor.ejecutarHerramienta('guardar_borrador_compra', factura(), 'rota');
  assert.equal(r.ok, false); assert.equal(valores.get(k), '{');
});
test('registro directo no puede omitir impuestos o cargar una deuda parcial', async () => {
  for (const entrada of [{}, { documento: 'compra', total_documento: 1334877.60, iva: 228836.16, percepciones: 16345.44 }]) {
    const r = await ejecutor.ejecutarHerramienta('registrar_compra', entrada, 'matienzo');
    assert.equal(r.ok, false); // El mock rechazaría cualquier RPC: no debe llegar.
  }
});
test('registro directo rechaza fracciones y descuadres', () => {
  const b = { documento: 'compra', proveedor_id:'proveedor',punto_venta:'1',numero_comprobante:'1',fecha:'2026-08-24',pagos:[],total_documento: 100, iva: 0, percepciones: 0,
    lineas: [{ variante_id: 'ejemplo', cantidad: 1.5, costo_unitario: 100 }] };
  assert(compra.validarRegistroCompra(b));
  b.lineas[0].cantidad = 2; assert(compra.validarRegistroCompra(b));
  b.lineas[0].cantidad = 1; assert.equal(compra.validarRegistroCompra(b), null);
});
const fila = (id, nombre = 'RIDER R LINE PLUS II PAPETE INF', talle = '30', color = 'Azul') => ({
  id, producto_id: 'modelo-1', talle, color, sku: 'SKU-30', codigo_barras: null, activa: true,
  productos: { nombre, marca: 'Rider', activo: true },
});
test('nombre parecido sugiere, nunca asigna una variante automáticamente', () => {
  const r = catalogo.analizarCatalogo({ descripcion: '12557 RIDER R LINE PLUS II PAPETE INF' }, [fila('v1')]);
  assert.equal(r.estado, 'revisar_candidatos'); assert.equal(r.encontrados, 1);
  assert.equal(r.escritura_realizada, false);
});
test('código exacto con talle contradictorio exige revisión', () => {
  const r = catalogo.analizarCatalogo({ codigo: 'SKU-30', talle: '35' }, [fila('v1')]);
  assert.equal(r.estado, 'revisar_candidatos'); assert(r.candidatos[0].contradicciones.length);
});
test('código exacto sin contradicciones sigue pidiendo confirmar', () => {
  assert.equal(catalogo.analizarCatalogo({ codigo: 'SKU-30', talle: '30', color: 'azul' }, [fila('v1')]).estado, 'coincidencia_para_confirmar');
});
test('marca aislada, consulta vacía e inactivos no se usan para altas automáticas', () => {
  for (const q of [{}, { descripcion: 'Rider' }]) assert.equal(catalogo.analizarCatalogo(q, [fila('v1')]).encontrados, 0);
  assert.equal(catalogo.analizarCatalogo({ codigo: 'SKU-30' }, [{ ...fila('v1'), activa: false }]).encontrados, 0);
});
test('normaliza acentos y espacios, preserva códigos distintos', () => {
  const v = fila('v1', 'Sandália   Niño'); v.sku = '123';
  assert.equal(catalogo.analizarCatalogo({ descripcion: 'sandalia nino' }, [v]).encontrados, 1);
  assert.equal(catalogo.analizarCatalogo({ codigo: '0123' }, [v]).encontrados, 0);
});
test('dos variantes con mismo código no se resuelven a ciegas', () => {
  assert.equal(catalogo.analizarCatalogo({ codigo: 'SKU-30' }, [fila('v1'), fila('v2')]).estado, 'revisar_candidatos');
});
test('candidatos truncados se anuncian', () => {
  const r = catalogo.analizarCatalogo({ descripcion: 'RIDER R LINE PLUS II PAPETE INF' }, Array.from({ length: 15 }, (_, i) => fila(String(i))));
  assert.equal(r.encontrados, 15); assert.equal(r.candidatos.length, 12); assert.equal(r.hay_mas, true);
});
test('paginación continúa aunque el servidor limite a menos filas', async () => {
  const filas = [fila('1'), fila('2'), fila('3')]; const llamadas = [];
  const r = await catalogo.leerCatalogoPaginado(async desde => {
    llamadas.push(desde); return { data: filas.slice(desde, desde + 2), error: null };
  });
  assert.equal(r.length, 3); assert.deepEqual(llamadas, [0, 2, 3]);
});
test('error de lectura o datos nulos no se convierten en catálogo vacío', async () => {
  await assert.rejects(catalogo.leerCatalogoPaginado(async () => ({ data: null, error: { message: 'Sin permisos' } })), /Sin permisos/);
  await assert.rejects(catalogo.leerCatalogoPaginado(async () => ({ data: null, error: null })), /no devolvió datos/);
});
test('página repetida se detiene sin bucle infinito', async () => {
  await assert.rejects(catalogo.leerCatalogoPaginado(async () => ({ data: [fila('1')], error: null })), /cambió/);
});
test('preguntas por talle separadas de tareas técnicas', () => {
  const r = compra.prepararCompra(factura());
  assert.equal(r.preguntas_usuario.length, 3);
  assert(r.preguntas_usuario[0].preguntas[0].includes('12 unidades'));
  assert(r.tareas_sistema.some(t => t.includes('IVA')));
  assert(!JSON.stringify(r.preguntas_usuario).includes('IVA'));
});
test('herramienta integrada analiza renglones juntos sin escribir', async () => {
  paginasCatalogo = [fila('v1')];
  try {
    const r = await ejecutor.ejecutarHerramienta('analizar_catalogo_compra', {
      renglones: [{ descripcion: 'RIDER R LINE PLUS II PAPETE INF', codigo: 'SKU-30', talle: '35' },
        { descripcion: 'Otro modelo inexistente' }],
    }, 'matienzo');
    assert.equal(r.ok, true);
    assert.equal(r.datos.resultados[0].estado, 'revisar_candidatos');
    assert.equal(r.datos.resultados[1].estado, 'sin_coincidencias');
    assert(!herramientas.ACCIONES.has('analizar_catalogo_compra'));
    assert(herramientas.TOOLS.some(t => t.name === 'analizar_catalogo_compra'));
  } finally { paginasCatalogo = null; }
});
test('herramienta limita consultas y no disfraza error de red como producto ausente', async () => {
  assert.equal((await ejecutor.ejecutarHerramienta('analizar_catalogo_compra', { renglones: [] }, 'matienzo')).ok, false);
  assert.equal((await ejecutor.ejecutarHerramienta('analizar_catalogo_compra', { renglones: Array(31).fill({}) }, 'matienzo')).ok, false);
  const r = await ejecutor.ejecutarHerramienta('analizar_catalogo_compra', { renglones: [{ descripcion: 'Rider' }] }, 'matienzo');
  assert.equal(r.ok, false); assert.match(r.error, /No des por ausente|Acceso a tablas prohibido/);
});
