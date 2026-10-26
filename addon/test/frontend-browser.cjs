// BMS: изолированный браузерный стенд; WebSocket заменён, команд живому дому нет.
const {chromium, webkit, expect} = require('playwright/test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '../bms_zigbee/rootfs/opt/bms-ui');

(async () => {
    const sample = await import(pathToFileURL(path.join(root, 'demo.mjs')));
    const server = http.createServer((req, res) => {
        let pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/ingress\/test/, '');
        if (pathname.startsWith('/bms-ui/')) pathname = pathname.slice('/bms-ui'.length);
        const file = path.resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404);res.end();return;}
        res.setHeader('Content-Type', file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(fs.readFileSync(file));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/ingress/test/`;
    let browser;
    try {
        browser = await (process.env.BMS_UI_BROWSER === 'webkit' ? webkit : chromium).launch({headless: !!process.env.CI});
        const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
        const errors = [], sent = [];
        let wire, responseError = false;
        page.on('pageerror', e => errors.push(e.message));
        await page.routeWebSocket(/\/api(?:\?|$)/, ws => {
            wire = ws;
            ws.onMessage(message => {
                const msg = JSON.parse(message); sent.push(msg);
                if (msg.topic.startsWith('bridge/request/')) {
                    ws.send(JSON.stringify({topic: msg.topic.replace('/request/', '/response/'),payload: {transaction:msg.payload.transaction,status:responseError?'error':'ok',data:msg.topic.endsWith('/networkmap')?{value:sample.topology}:{}}}));
                }
            });
            for (const [topic,payload] of Object.entries({'bridge/state':{state:'online'},'bridge/info':sample.info,'bridge/devices':sample.devices,'bridge/groups':sample.groups,'bridge/bms/extensions':{status:'ready'},...sample.states})) ws.send(JSON.stringify({topic,payload}));
        });
        await page.goto(url);
        await expect(page.locator('#connection')).toHaveText('BMS на связи');
        await expect(page.getByRole('button',{name:'Торшер у дивана',exact:true})).toBeVisible();
        assert.equal(sent.length,0,'initial UI must only observe');
        await page.getByRole('button',{name:'Выключить Торшер у дивана',exact:true}).click();
        await expect.poll(()=>sent.length).toBe(1);
        assert.deepEqual(sent[0],{topic:'Торшер у дивана/set',payload:{state:'OFF'}});
        // Без нового state UI не должен объявлять исполнение.
        await expect(page.getByRole('button',{name:'Выключить Торшер у дивана',exact:true})).toBeVisible();
        await page.getByRole('button',{name:'Торшер у дивана',exact:true}).click();
        const slider=page.getByLabel('Яркость',{exact:true});
        const before=sent.length;
        await slider.evaluate(el=>{for(const v of [30,60,90]){el.value=String(v);el.dispatchEvent(new Event('input',{bubbles:true}));}});
        assert.equal(sent.length,before,'dragging should not flood commands');
        await slider.evaluate(el=>el.dispatchEvent(new Event('change',{bubbles:true})));
        await expect.poll(()=>sent.length).toBe(before+1);
        assert.deepEqual(sent.at(-1).payload,{brightness:90});
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).not.toBeVisible();
        await page.getByRole('link',{name:'Устройства'}).click();
        await page.getByLabel('Поиск устройств').fill('кофемашины');
        await expect(page.locator('.device-card')).toHaveCount(1);
        await page.getByRole('link',{name:'Группы',exact:true}).click();
        await page.getByRole('button',{name:'Создать группу',exact:true}).click();
        await page.getByLabel('Название',{exact:true}).fill('Вечер');
        await page.getByRole('button',{name:'Сохранить',exact:true}).click();
        await expect(page.getByRole('dialog')).not.toBeVisible();
        assert.equal(sent.at(-1).topic,'bridge/request/group/add');
        assert.equal(sent.at(-1).payload.friendly_name,'Вечер');
        // Ошибка API не закрывает форму и не показывает успех.
        responseError=true;
        await page.getByRole('button',{name:'Создать группу',exact:true}).click();
        await page.getByLabel('Название',{exact:true}).fill('Другая');
        await page.getByRole('button',{name:'Сохранить',exact:true}).click();
        await expect(page.locator('#toast')).toContainText('Не удалось');
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');responseError=false;
        await page.getByRole('button',{name:'Вечерний свет',exact:true}).click();
        await page.getByRole('button',{name:'Включить всё',exact:true}).click();
        await expect.poll(()=>sent.at(-1).topic).toBe('5/set');
        await page.getByRole('button',{name:'Добавить канал',exact:true}).click();
        await page.getByRole('button',{name:'Добавить',exact:true}).click();
        await expect(page.getByRole('dialog')).not.toBeVisible();
        assert.equal(sent.at(-1).topic,'bridge/request/group/members/add');
        assert.equal(typeof sent.at(-1).payload.endpoint,'number');
        await page.getByRole('button',{name:'Вечерний свет',exact:true}).click();
        await page.getByText('Настройка группы',{exact:true}).click();
        await page.getByRole('button',{name:'Удалить группу',exact:true}).click();
        assert.equal(sent.at(-1).topic,'bridge/request/group/members/add','delete requires its own confirmation');
        await page.getByRole('button',{name:'Удалить группу',exact:true}).click();
        await expect(page.getByRole('dialog')).not.toBeVisible();
        assert.equal(sent.at(-1).topic,'bridge/request/group/remove');
        assert.equal(sent.at(-1).payload.force,false);
        await page.getByRole('button',{name:'Добавить устройство',exact:true}).click();
        await page.getByRole('button',{name:'Открыть на 60 секунд',exact:true}).click();
        await expect(page.getByRole('dialog')).not.toBeVisible();
        assert.equal(sent.at(-1).topic,'bridge/request/permit_join');assert.equal(sent.at(-1).payload.time,60);
        await page.getByRole('link',{name:'Диагностика',exact:true}).click();
        await expect(page.getByRole('heading',{name:'Диагностика'})).toBeVisible();
        await expect(page.getByRole('link',{name:'Расширенные настройки',exact:true}).last()).toHaveAttribute('href',/advanced=1/);
        wire.send(JSON.stringify({topic:'bms/self_check',payload:{total:2,ok:1,version:'test',at:'2026-10-27T10:00:00Z',avgMs:120,maxMs:200,failed:['Не ответившее реле']}}));
        await expect(page.getByText('1 из 2',{exact:true})).toBeVisible();
        const beforeRestart=sent.length;
        await page.getByRole('button',{name:'Перезапустить',exact:true}).click();
        assert.equal(sent.length,beforeRestart,'restart requires confirmation');
        await page.getByRole('dialog').getByRole('button',{name:'Отмена',exact:true}).click();
        assert.equal(sent.length,beforeRestart);
        // Карта не сканирует сеть при входе; запрос только по явному действию.
        const beforeMap=sent.length;
        await page.getByRole('link',{name:'Карта сети',exact:true}).click();
        assert.equal(sent.length,beforeMap);
        responseError=true;
        await page.getByRole('button',{name:'Обновить карту',exact:true}).click();
        await expect(page.getByRole('alert')).toContainText('Не удалось');
        responseError=false;
        await page.getByRole('button',{name:'Обновить карту',exact:true}).click();
        await expect(page.locator('.map-node')).toHaveCount(sample.topology.nodes.length);
        assert.equal(sent.at(-1).topic,'bridge/request/networkmap');
        assert.equal(sent.at(-1).payload.routes,false);
        await page.getByRole('link',{name:'Брокер',exact:true}).click();
        await expect(page.getByRole('heading',{name:'Подключение',exact:true})).toBeVisible();
        // Offline конкретного устройства блокирует его кнопку, даже если сервер на связи.
        await page.getByRole('link',{name:'Устройства',exact:true}).click();
        await page.getByLabel('Поиск устройств').fill('');
        wire.send(JSON.stringify({topic:'Торшер у дивана/availability',payload:{state:'offline'}}));
        await expect(page.getByRole('button',{name:'Выключить Торшер у дивана',exact:true})).toBeDisabled();
        wire.send(JSON.stringify({topic:'Торшер у дивана/availability',payload:{state:'online'}}));
        await expect(page.getByRole('button',{name:'Выключить Торшер у дивана',exact:true})).toBeEnabled();
        // Имена из MQTT — текст, не HTML.
        wire.send(JSON.stringify({topic:'bridge/devices',payload:[{...sample.devices[0],friendly_name:'<img src=x onerror=alert(1)>'}]}));
        await page.getByRole('link',{name:'Хабы',exact:true}).click();
        await expect(page.getByRole('button',{name:'<img src=x onerror=alert(1)>',exact:true})).toBeVisible();
        assert.equal(await page.locator('img').count(),0);
        const atDisconnect=sent.length;
        wire.close({code:1001,reason:'test offline'});
        await expect(page.getByRole('button',{name:'Добавить устройство',exact:true})).toBeDisabled();
        assert.equal(sent.length,atDisconnect,'disconnect must not replay actions');
        // Авторизация, токен не сохраняется в storage.
        const authPage=await browser.newPage();let authedURL='';
        await authPage.routeWebSocket(/\/api(?:\?|$)/,ws=>{
            if(!ws.url().includes('token='))ws.close({code:4401,reason:'Unauthorized'});
            else{authedURL=ws.url();ws.send(JSON.stringify({topic:'bridge/state',payload:{state:'online'}}));}
        });
        await authPage.goto(url);
        await authPage.getByLabel('Токен доступа',{exact:true}).fill('test-only-token');
        await authPage.getByRole('dialog').getByRole('button',{name:'Подключиться',exact:true}).click();
        await expect.poll(()=>authedURL).toContain('token=test-only-token');
        assert.equal(await authPage.evaluate(()=>localStorage.length+sessionStorage.length),0);
        await authPage.close();
        // Демо — полностью автономно, никаких API и случайного управления.
        const demoPage=await browser.newPage();let demoSockets=0;
        demoPage.on('websocket',()=>demoSockets++);
        await demoPage.goto(url+'?demo=1');
        await expect(demoPage.getByRole('heading',{name:'Zigbee2MQTT',exact:true})).toBeVisible();
        const shots=process.env.PW_ARTIFACT_DIR;
        if(shots){fs.mkdirSync(shots,{recursive:true});await demoPage.screenshot({path:path.join(shots,'overview-desktop.png'),fullPage:true});}
        await demoPage.setViewportSize({width:390,height:844});
        await demoPage.emulateMedia({reducedMotion:'reduce'});
        await demoPage.getByRole('button',{name:/Хаб · BMS Zigbee/}).click();
        for(const name of ['Устройства','Комнаты','Группы','Карта сети','Диагностика','Журнал','Брокер']) {
            await demoPage.getByRole('link',{name:new RegExp(`^${name}`)}).click();
            assert.equal(await demoPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name}: mobile overflow`);
        }
        await demoPage.getByRole('link',{name:'Хабы',exact:true}).click();
        if(shots)await demoPage.screenshot({path:path.join(shots,'overview-mobile.png'),fullPage:true});
        await demoPage.getByLabel('Тема оформления').selectOption('dark');
        await expect(demoPage.locator('html')).toHaveClass('root dark');
        if(shots)await demoPage.screenshot({path:path.join(shots,'overview-mobile-dark.png'),fullPage:true});
        await demoPage.getByRole('button',{name:/Хаб · BMS Zigbee/}).click();
        await demoPage.getByRole('link',{name:'Карта сети',exact:true}).click();
        await demoPage.getByRole('button',{name:'Обновить карту',exact:true}).click();
        await expect(demoPage.locator('.map-node')).toHaveCount(sample.topology.nodes.length);
        for(const width of [320,768,1024,1920]) {
            await demoPage.setViewportSize({width,height:900});
            for(const screen of ['devices','rooms','groups','map','diagnostics','logs','broker']) {
                await demoPage.goto(url+`?demo=1#${screen}`);
                await expect(demoPage.locator('html')).toHaveAttribute('data-page',screen);
                assert.equal(await demoPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${screen}: overflow at ${width}px`);
            }
        }
        assert.equal(demoSockets,0);
        assert.deepEqual(errors,[]);
        console.log((process.env.BMS_UI_BROWSER||'chromium')+' BMS UI browser checks passed: controls, batching, groups, requests/errors, pairing, search, auth, offline, XSS, demo, mobile.');
    } finally {
        if(browser)await browser.close();
        await new Promise(r=>server.close(r));
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
