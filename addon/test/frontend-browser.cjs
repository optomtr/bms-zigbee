// Сравниваем исходный макет с рабочим UI и проверяем команды через изолированный WebSocket.
const {chromium,webkit,expect}=require('playwright/test');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {PNG}=require('pngjs');
const root=path.resolve(__dirname,'../bms_zigbee/rootfs/opt/bms-ui');
const references=path.resolve(__dirname,'../design-reference');
(async()=>{
 const pixelmatch=(await import(pathToFileURL(require.resolve('pixelmatch')))).default;
 const sample=await import(pathToFileURL(path.join(root,'demo.mjs')));
 const server=http.createServer((req,res)=>{
  let pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/ingress\/test/,'');
  const reference=pathname.startsWith('/_reference/');
  pathname=pathname.replace(/^\/(?:bms-ui|_reference)\//,'/');
  const dir=reference?references:root;
  const file=path.resolve(dir,pathname==='/'?'index.html':pathname.slice(1));
  if(!file.startsWith(dir+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.mjs')||file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(fs.readFileSync(file));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/ingress/test/`;
 let browser;
 try{
  browser=await (process.env.BMS_UI_BROWSER==='webkit'?webkit:chromium).launch({headless:!!process.env.CI});
  const errors=[],sent=[];let wire,responseError=false;
  const page=await browser.newPage({viewport:{width:1440,height:1040}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.routeWebSocket(/\/api(?:\?|$)/,ws=>{
   wire=ws;
   ws.onMessage(raw=>{const msg=JSON.parse(raw);sent.push(msg);if(msg.topic.startsWith('bridge/request/'))ws.send(JSON.stringify({topic:msg.topic.replace('/request/','/response/'),payload:{transaction:msg.payload.transaction,status:responseError?'error':'ok',data:msg.topic.endsWith('/networkmap')?{value:sample.topology}:{healthy:true}}}));});
   for(const [topic,payload]of Object.entries({'bridge/state':{state:'online'},'bridge/info':sample.info,'bridge/devices':sample.devices,'bridge/groups':sample.groups,'bridge/bms/extensions':{status:'ready'},...sample.states}))ws.send(JSON.stringify({topic,payload}));
  });
  await page.goto(url);
  await expect(page.getByText('BMS на связи',{exact:true})).toBeVisible();
  const tile=page.locator(`[data-bms-device="${sample.devices[0].ieee_address}"]`);
  await expect(tile).toBeVisible();assert.equal(sent.length,0,'startup must be passive');
  await tile.locator('.tile-hit').click();await expect.poll(()=>sent.length).toBe(1);
  assert.deepEqual(sent[0],{topic:'Торшер у дивана/set',payload:{state:'OFF'}});
  await expect(tile).toHaveClass(/\bon\b/);
  await tile.click({button:'right'});const slider=page.getByLabel('Яркость',{exact:true});
  const before=sent.length;
  await slider.evaluate(el=>{for(const value of [30,60,90]){el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));}});
  assert.equal(sent.length,before);await slider.evaluate(el=>el.dispatchEvent(new Event('change',{bubbles:true})));
  await expect.poll(()=>sent.length).toBe(before+1);assert.deepEqual(sent.at(-1).payload,{brightness:90});
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).not.toBeVisible();
  // В фокусе остаётся ползунок, но offline обязан заблокировать управление сразу.
  await tile.click({button:'right'});await slider.focus();
  wire.send(JSON.stringify({topic:'Торшер у дивана/availability',payload:{state:'offline'}}));
  await expect(page.getByLabel('Яркость',{exact:true})).toBeDisabled();
  wire.send(JSON.stringify({topic:'Торшер у дивана/availability',payload:{state:'online'}}));
  await expect(page.getByLabel('Яркость',{exact:true})).toBeEnabled();await page.keyboard.press('Escape');
  await page.getByRole('tab',{name:'MQTT',exact:true}).click();
  await page.getByRole('button',{name:'Группы',exact:true}).click();
  await page.getByRole('button',{name:'Создать группу',exact:true}).click();
  await page.getByLabel('Название',{exact:true}).fill('Вечер');await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();assert.equal(sent.at(-1).topic,'bridge/request/group/add');
  assert.equal(sent.at(-1).payload.friendly_name,'Вечер');
  responseError=true;
  await page.getByRole('button',{name:'Группы',exact:true}).click();await page.getByRole('button',{name:'Создать группу',exact:true}).click();
  await page.getByLabel('Название',{exact:true}).fill('Ошибка');await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await expect(page.locator('#dialog-error')).toContainText('Не удалось');await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');responseError=false;
  await page.getByRole('button',{name:'Группы',exact:true}).click();await page.getByRole('button',{name:'Вечерний свет',exact:true}).click();
  await page.getByRole('button',{name:'Включить всё',exact:true}).click();assert.equal(sent.at(-1).topic,'5/set');
  await page.getByRole('button',{name:'Добавить канал',exact:true}).click();await page.getByRole('button',{name:'Добавить',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();assert.equal(sent.at(-1).topic,'bridge/request/group/members/add');assert.equal(typeof sent.at(-1).payload.endpoint,'number');
  await page.getByRole('button',{name:'Группы',exact:true}).click();await page.getByRole('button',{name:'Вечерний свет',exact:true}).click();
  await page.getByText('Настройка группы',{exact:true}).click();await page.getByRole('button',{name:'Удалить группу',exact:true}).click();
  assert.equal(sent.at(-1).topic,'bridge/request/group/members/add');await page.getByRole('button',{name:'Удалить группу',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();assert.equal(sent.at(-1).payload.force,false);
  await page.getByRole('button',{name:'Диагностика',exact:true}).click();
  wire.send(JSON.stringify({topic:'bms/self_check',payload:{total:2,ok:1,version:'test',at:'2026-10-27T10:00:00Z',avgMs:120,maxMs:200,failed:[]}}));
  await expect(page.getByText('1 из 2',{exact:true})).toBeVisible();await page.keyboard.press('Escape');
  const atMap=sent.length;await page.getByRole('tab',{name:'Карта сети',exact:true}).click();assert.equal(sent.length,atMap);
  await page.getByRole('button',{name:'Обновить карту',exact:true}).click();
  await expect(page.locator('.map .link')).toHaveCount(sample.topology.links.length);assert.equal(sent.at(-1).payload.routes,false);
  await page.getByRole('button',{name:'Разрешить подключение',exact:true}).click();
  await expect.poll(()=>sent.at(-1).topic).toBe('bridge/request/permit_join');assert.equal(sent.at(-1).payload.time,254);
  await page.getByRole('tab',{name:/Устройства/}).click();
  wire.send(JSON.stringify({topic:'bridge/devices',payload:[{...sample.devices[0],friendly_name:'<img src=x onerror=alert(1)>'}]}));
  await expect(page.getByText('<img src=x onerror=alert(1)>',{exact:true})).toBeVisible();assert.equal(await page.locator('img').count(),0);
  const atClose=sent.length;wire.close({code:1001,reason:'offline test'});
  await expect(page.getByRole('button',{name:'Разрешить подключение',exact:true})).toBeDisabled();assert.equal(sent.length,atClose);
  const authPage=await browser.newPage();let authedURL='';
  await authPage.routeWebSocket(/\/api(?:\?|$)/,ws=>{if(!ws.url().includes('token='))ws.close({code:4401,reason:'Unauthorized'});else{authedURL=ws.url();ws.send(JSON.stringify({topic:'bridge/state',payload:{state:'online'}}));}});
  await authPage.goto(url);await authPage.getByLabel('Токен доступа',{exact:true}).fill('test-only-token');await authPage.getByRole('dialog').getByRole('button',{name:'Подключиться',exact:true}).click();
  await expect.poll(()=>authedURL).toContain('/ingress/test/api?token=test-only-token');assert.equal(await authPage.evaluate(()=>localStorage.length+sessionStorage.length),0);await authPage.close();
  // Идентичные данные, CSS и состояние: сравнение с исходным HTML в том же браузере.
  for(const [layout,width,height]of [['desktop',1440,1040],['iphone',390,844]]){
   const context=await browser.newContext({viewport:{width,height}});let sockets=0;
   const source=await context.newPage(),copy=await context.newPage();copy.on('websocket',()=>sockets++);copy.on('pageerror',e=>errors.push(e.message));
   await source.goto(url+`_reference/${layout}.html`);await copy.goto(url+'?demo=1');
   for(const p of [source,copy]){await expect(p.getByRole('heading',{name:'Zigbee2MQTT',exact:true})).toBeVisible();await p.evaluate(()=>document.fonts.ready);await p.locator('.dc-panel button').last().evaluate(el=>{if(el.textContent.includes('Спокойные'))el.click();});}
   // Движение не заменяем static CSS: тумблер, индикатор сегментов и pulse присутствуют.
   const motion=await copy.evaluate(()=>({knob:getComputedStyle(document.querySelector('.sw .knob')).transitionDuration,pulse:getComputedStyle(document.querySelector('.dot-on'),'::after').animationName,font:getComputedStyle(document.querySelector('.root')).fontFamily}));
   assert.notEqual(motion.knob,'0s');assert.equal(motion.pulse,'ping');assert.ok(motion.font.includes('-apple-system'));
   for(const theme of ['light','dark']){
    if(theme==='dark')for(const p of [source,copy])await p.locator('.dc-panel button').first().evaluate(el=>el.click());
    const captures=[];
    for(const p of [source,copy]){
     const freeze=await p.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important}'});
     await p.mouse.move(0,0);captures.push(PNG.sync.read(await p.screenshot({fullPage:false})));
     await freeze.evaluate(el=>el.remove());
    }
    const [a,b]=captures;assert.equal(a.width,b.width);assert.equal(a.height,b.height);
    // Порог 1% отсекает разницу округления одного уровня RGB в GPU-тенях; CSS сверяется побайтно отдельным тестом.
    const different=pixelmatch(a.data,b.data,null,a.width,a.height,{threshold:0.01});
    if(different){fs.writeFileSync(`/tmp/bms-source-${layout}-${theme}.png`,PNG.sync.write(a));fs.writeFileSync(`/tmp/bms-copy-${layout}-${theme}.png`,PNG.sync.write(b));}
    assert.equal(different,0,`${layout} ${theme}: ${different} pixels differ from original`);
    console.log(`${layout} ${theme}: 0 pixel differences from supplied HTML`);
   }
   await expect(copy.getByRole('switch').first()).toHaveAttribute('aria-checked','true');
   if(layout==='iphone')await copy.getByRole('button',{name:'Открыть Хаб · Этаж 1',exact:true}).click();
   const first=copy.locator('[data-bms-device]').first();
   if(layout==='iphone'){
    await first.click({delay:550});
    await expect(copy.getByRole('dialog')).toBeVisible();
    await expect(first.locator('.tile-hit')).toHaveAttribute('aria-pressed','true');
    await copy.getByLabel('Яркость',{exact:true}).evaluate(el=>{el.value='35';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
    await expect(first.locator('.rd')).toContainText('35 %');await copy.keyboard.press('Escape');
   }
   await first.click({button:'right'});
   await expect(copy.getByLabel('Яркость',{exact:true})).toBeVisible();await copy.keyboard.press('Escape');
   // Ползунок имеет собственный thumb, исходные тумблеры переключаются с движением.
   if(layout==='desktop')await copy.getByRole('switch').last().click();
   assert.equal(sockets,0,'demo must not create WebSocket');await context.close();
  }
  assert.deepEqual(errors,[]);
  console.log(`${process.env.BMS_UI_BROWSER||'chromium'}: exact design, animations, sliders, commands, groups, auth, offline, XSS and map passed`);
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
