const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('../node_modules/typescript');
const root=path.join(__dirname,'..');
function compile(file,extra={}){
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Error,...extra});return exports;
}
const arca=compile('supabase/functions/_shared/arca.ts');
function fixture(options={}){
 let handler;let emits=0,queries=0;
 const c={id:'c1',sucursal_id:'s1',estado:'pendiente',tipo:'B',punto_venta:3,fecha:'2026-09-29',receptor_tipo_documento:'SIN_IDENTIFICAR',receptor_documento:null,receptor_condicion_iva:'consumidor_final',total:121,neto:100,iva:21,revision_huella:'hash',intento:0,job_id:null,idempotency_key:null,...options.c};
 const admin={from(table){let changes;const q={select(){return q;},eq(){return q;},update(v){changes=v;return q;},maybeSingle(){return q;},then(resolve){
  if(changes){if(options.saveError&&changes.job_id)return Promise.resolve({error:{message:'error guardar'}}).then(resolve);Object.assign(c,changes);return Promise.resolve({error:null}).then(resolve);}
  return Promise.resolve({data:table==='usuarios'?{rol:options.role??'dueno',activo:true}:table==='comprobantes'?{...c}:table==='sucursales'?{arca_slug:null}:table==='comprobante_lineas'?[{alicuota:21,neto:100,iva:21}]:null,error:null}).then(resolve);
 }};return q;},async rpc(name,args){
   if(name==='reservar_envio_fiscal'){
    if(options.reserveError||c.idempotency_key)return {data:null,error:{message:'reserva denegada'}};
    c.idempotency_key='estable';return{data:'estable',error:null};
   }
   throw new Error(`RPC inesperada ${name}`);
 }};
 const gateway={CUENTA_UNICA:'*',leerCuenta:()=>options.noAccount?null:{},emitir:async()=>{emits++;return options.response??{ok:true,datos:{job_id:'job1',status:'pending'}};},consultar:async()=>{queries++;return{ok:true,datos:{status:'pending'}};}};
 compile('supabase/functions/facturar/index.ts',{Request,Response,console,fetch:async()=>new Response(JSON.stringify({id:'u1'})),Deno:{env:{get:()=> 'test'},serve:f=>handler=f},require:name=>name.includes('supabase-js')?{createClient:()=>admin}:name.endsWith('arca.ts')?arca:name.endsWith('gateway.ts')?gateway:{aplicarResultado:async()=>{}}});
 return{call:async(extra={})=>handler(new Request('https://example.invalid',{method:'POST',headers:{Authorization:'Bearer ficticio','Content-Type':'application/json'},body:JSON.stringify({accion:'pedir_cae',comprobante_id:'c1',sucursal_id:'s1',...extra})})),stats:()=>({emits,queries,c})};
}
test('edge: rol vendedor no puede emitir',async()=>{const f=fixture({role:'vendedor'});assert.equal((await f.call()).status,403);assert.equal(f.stats().emits,0);});
test('edge: otra sucursal bloqueada antes de Gateway',async()=>{const f=fixture();assert.equal((await f.call({sucursal_id:'otra'})).status,409);assert.equal(f.stats().emits,0);});
test('edge: reserva fallida impide salida',async()=>{const f=fixture({reserveError:true});assert.equal((await f.call()).status,409);assert.equal(f.stats().emits,0);});
test('edge: sin cuenta configurada no reserva ni emite',async()=>{const f=fixture({noAccount:true});assert.equal((await f.call()).status,503);assert.equal(f.stats().c.idempotency_key,null);});
test('edge: respuesta perdida conserva reserva y no reemite',async()=>{const f=fixture({response:{ok:false,codigo:'network',mensaje:'timeout'}});assert.equal((await f.call()).status,502);assert.equal((await f.call()).status,409);assert.equal(f.stats().emits,1);assert.equal(f.stats().c.estado,'pendiente');});
test('edge: job inválido queda por conciliar',async()=>{const f=fixture({response:{ok:true,datos:{}}});assert.equal((await f.call()).status,502);assert.equal((await f.call()).status,409);assert.equal(f.stats().emits,1);});
test('edge: error al guardar job no se presenta como éxito',async()=>{const f=fixture({saveError:true});assert.equal((await f.call()).status,502);assert.equal((await f.call()).status,409);assert.equal(f.stats().emits,1);});
test('edge: aceptado sin CAE es pendiente, siguiente llamada solo consulta',async()=>{const f=fixture();const r=await f.call();assert.equal(r.status,202);assert.equal((await r.json()).estado,'pendiente');await f.call();assert.equal(f.stats().emits,1);assert.equal(f.stats().queries,1);});
test('edge: doble llamada simultánea solo reserva y emite una vez',async()=>{const f=fixture();await Promise.all([f.call(),f.call()]);assert.equal(f.stats().emits,1);});
test('edge: emitido no se vuelve a enviar',async()=>{const f=fixture({c:{estado:'emitido',cae:'12345678901234'}});assert.equal((await f.call()).status,200);assert.equal(f.stats().emits,0);});
test('lote: 75 de 100, respuestas mixtas, sin reintentos ni omitidos',async()=>{
 const {ejecutarLoteFiscal}=compile('src/lib/lote-fiscal.ts');const calls=[],results=[];
 const all=Array.from({length:100},(_,i)=>String(i));
 await ejecutarLoteFiscal([...all.slice(0,75),'0'],async id=>{calls.push(id);if(id==='2')throw Error('timeout');return id==='3'?{ok:false}:{ok:true};},(id,r)=>results.push({id,r}));
 assert.equal(calls.length,75);assert.equal(results.length,75);assert.ok(calls.every(id=>Number(id)<75));assert.equal(results[2].r.message,'timeout');assert.equal(results[3].r.ok,false);
});
