const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../bms_zigbee/rootfs/opt/bms-ui');
const reference=path.resolve(__dirname,'../design-reference');
for(const name of ['desktop','iphone'])test(`${name}: original CSS, font links and motion are preserved verbatim`,()=>{
 const source=fs.readFileSync(path.join(reference,name+'.html'),'utf8'),copy=fs.readFileSync(path.join(root,name+'.html'),'utf8');
 const styles=s=>[...s.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]);
 assert.deepEqual(styles(copy),styles(source));
 const fonts=s=>[...s.matchAll(/<link[^>]*fonts\.googleapis[^>]*>/g)].map(m=>m[0]);
 assert.deepEqual(fonts(copy),fonts(source));
 for(const rule of ['.sw .knob','.seg-thumb','@keyframes ping','@keyframes'])assert.ok(copy.includes(rule));
 assert.ok(copy.includes('m.mount(Component'));
 const scripts=s=>[...s.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
 const a=scripts(source),b=scripts(copy);
 assert.deepEqual(b.slice(0,3),a.slice(0,3));
 assert.equal(b[3].split('\nimport("./reference-adapter.mjs")')[0],a[3].split('\nwindow.__mountDC(')[0]);
});
