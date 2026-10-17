import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
const source=await readFile(new URL('../web/js/planes.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
test('Mejorar plan abre precios mientras los datos y la cuenta siguen pendientes',async()=>{
  const dom=new JSDOM(html,{url:'https://example.test',runScripts:'outside-only'}),w=dom.window;
  try {
    const app=await readFile(new URL('../web/js/app.js',import.meta.url),'utf8');
    const navigation=app.slice(app.indexOf('function activarTabs()'),app.indexOf('async function init()'));
    w.estado={charts:{}};
    w.Cuenta={sesion:null};
    w.escapar=s=>String(s);
    w.eval(navigation+'\nactivarTabs();');
    w.eval(source);
    w.document.querySelector('#btn-planes').click();
    assert.equal(w.document.querySelector('#panel-planes').classList.contains('activo'),true);
    assert.equal(w.document.querySelector('#tabs [data-panel="planes"]').classList.contains('activa'),true);
    assert.equal(w.document.querySelector('section.panel.activo').id,'panel-planes');
    assert.match(w.document.querySelector('#planes-tarjetas').textContent,/9\.900/);
    assert.match(w.document.querySelector('#planes-tarjetas').textContent,/24\.900/);
    assert.match(w.document.querySelector('#plan-actual').textContent,/Inicia sesión/);
  } finally {dom.window.close();}
});
async function page(admin=false) {
  const dom=new JSDOM(html,{url:'https://example.test',runScripts:'outside-only'}),w=dom.window;
  const calls=[];
  const scenarios=[1,2].map(i=>({id:`s${i}`,usuario_id:'u1',nombre:`Escenario ${i}`,evento_slug:'gp',parrilla:['a','b'],creado_en:'2026-10-17',resultado:[{driver_id:'a',nombre:'Piloto A',grid:i,posicion:i,victoria:.4},{driver_id:'b',nombre:'Piloto B',grid:2,posicion:2}]}));
  const plan={codigo:admin?'experto':'vip',nombre:admin?'Experto':'VIP',max_escenarios:admin?50:10,max_comparacion:admin?5:2,exportar:admin,es_admin:admin};
  w.escapar=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  w.pct=x=>x==null?'—':`${x*100}%`;
  w.estado={evento:{grid_referencia:[{driver_id:'a'},{driver_id:'b'}]},parrilla:['a','b']};
  w.infoPiloto=id=>({driver_id:id,nombre:`Piloto ${id}`});w.estimacion=(_id,grid)=>({pos:grid,victoria:.5});
  w.Cuenta={sesion:{user:{id:'u1'}},esAdmin:()=>admin,alCambiar:fn=>fn(),sb:{
    rpc:async(name,args)=>{calls.push({name,args});return {data:name==='mi_plan'?plan:name==='asignar_plan'?{plan:args.nuevo_plan}:scenarios};},
    from:table=>({
      select:()=>({order:async()=>({data:table==='escenarios'?scenarios:[]})}),
      insert:async data=>{calls.push({name:'insert',data});return{};},
      upsert:async data=>{calls.push({name:'request',data});return{};},
    }),
  }};
  w.document.querySelector('#sel-evento').innerHTML='<option value="gp">GP</option>';
  w.eval(source);await w.Planes.iniciar();
  return {w,dom,calls};
}
test('VIP ve laboratorio y puede enviar una solicitud y guardar la parrilla actual',async()=>{
  const p=await page();try{
    const d=p.w.document;
    assert.equal(d.querySelector('#escenario-guardar').disabled,false);
    assert.equal(d.querySelector('#escenario-exportar').disabled,true);
    assert.equal(d.querySelector('#planes-admin').hidden,true);
    d.querySelector('[data-solicitar="experto"]').click();await tick();
    assert.equal(p.calls.find(x=>x.name==='request').data.plan,'experto');
    assert.match(d.querySelector('#planes-estado').textContent,/No se ha realizado ningún cobro/);
    d.querySelector('#escenario-nombre').value='Mi variante';d.querySelector('#escenario-guardar').click();await tick();
    const inserted=p.calls.find(x=>x.name==='insert').data;
    assert.equal(inserted.nombre,'Mi variante');assert.deepEqual(Array.from(inserted.parrilla),['a','b']);assert.equal(inserted.resultado.length,2);
  }finally{p.dom.window.close();}
});
test('comparación usa la RPC protegida, conserva la selección y se limpia al salir',async()=>{
  const p=await page();try{
    const d=p.w.document;
    for(const c of d.querySelectorAll('[name="escenario-elegido"]'))c.checked=true;
    d.querySelector('#escenario-comparar').click();await tick();
    assert.equal(p.calls.find(x=>x.name==='comparar_escenarios').args.ids.length,2);
    assert.match(d.querySelector('#escenario-resultado').textContent,/Escenario 1/);
    assert.equal(d.querySelectorAll('[name="escenario-elegido"]:checked').length,2);
    p.w.Cuenta.sesion=null;await p.w.Planes.refrescar();
    assert.equal(d.querySelector('#escenario-resultado').textContent,'');assert.equal(d.querySelectorAll('[name="escenario-elegido"]').length,0);
  }finally{p.dom.window.close();}
});
test('administrador asigna el plan mediante la RPC y mantiene precios claros',async()=>{
  const p=await page(true);try{
    const d=p.w.document;
    assert.equal(d.querySelector('#planes-admin').hidden,false);
    assert.match(d.querySelector('#planes-tarjetas').textContent,/9\.900/);assert.match(d.querySelector('#planes-tarjetas').textContent,/24\.900/);
    d.querySelector('#planes-usuario').value='usuario_prueba';d.querySelector('#planes-codigo').value='vip';d.querySelector('#planes-asignar').click();await tick();
    const call=p.calls.find(x=>x.name==='asignar_plan');assert.equal(call.args.usuario,'usuario_prueba');assert.equal(call.args.nuevo_plan,'vip');
  }finally{p.dom.window.close();}
});
