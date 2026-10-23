// Проверки расширения bms-area-groups на подставных Home Assistant (реестры по WebSocket API) и Z2M
// (запросы bridge через шину событий, ответы — в bridge/response/… как у lib/extension/bridge.ts и groups.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fakeLogger, importLayer, makeDataDir} from "./stand.mjs";

const dir = makeDataDir();
const {default: AreaGroups, desiredAreas, MAP_FILE} = await importLayer(dir, "external_extensions", "bms-area-groups.mjs");

const TIMING = {startDelay: 0, debounce: 40, pause: 15, reply: 400, retry: 80, retryMax: 80, reconnect: 20, reconnectMax: 20};
const BASE = "zigbee2mqtt";
const later = (fn) => setTimeout(fn, 1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(cond, what, ms = 3000) {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) assert.fail(`не дождались: ${what}`);
        await sleep(5);
    }
}

// ---------- подставной Home Assistant: WebSocket API с реестрами и подпиской на события ----------
function fakeHA({areas = [], devices = [], entities = [], token = "tok", acceptToken = true} = {}) {
    const ha = {areas, devices, entities, sockets: [], lists: 0, subscriptions: []};
    class WS {
        constructor(url) {
            this.url = url;
            this.l = {};
            ha.sockets.push(this);
            later(() => this.emit("message", {data: JSON.stringify({type: "auth_required"})}));
        }
        addEventListener(type, fn) {
            (this.l[type] ??= []).push(fn);
        }
        emit(type, ev) {
            for (const fn of this.l[type] ?? []) fn(ev);
        }
        send(raw) {
            later(() => handle(this, JSON.parse(raw)));
        }
        close() {
            if (this.closed) return;
            this.closed = true;
            later(() => this.emit("close", {code: 1000}));
        }
    }
    const reply = (ws, id, result) => ws.emit("message", {data: JSON.stringify({id, type: "result", success: true, result})});
    function handle(ws, m) {
        if (ws.closed) return;
        if (m.type === "auth") {
            const ok = acceptToken && m.access_token === token;
            ws.authed = ok;
            ws.emit("message", {data: JSON.stringify({type: ok ? "auth_ok" : "auth_invalid", message: "Invalid access token or password"})});
            return;
        }
        assert.ok(ws.authed, "команда до входа");
        if (m.type === "subscribe_events") {
            ha.subscriptions.push({ws, id: m.id, event_type: m.event_type});
            reply(ws, m.id, null);
        } else if (m.type === "config/area_registry/list") {
            ha.lists++;
            reply(ws, m.id, ha.areas);
        } else if (m.type === "config/device_registry/list") {
            reply(ws, m.id, ha.devices);
        } else if (m.type === "config/entity_registry/list") {
            reply(ws, m.id, ha.entities);
        } else {
            ws.emit("message", {data: JSON.stringify({id: m.id, type: "result", success: false, error: {code: "unknown_command"}})});
        }
    }
    ha.fire = (event_type) => {
        for (const s of ha.subscriptions.filter((x) => x.event_type === event_type && !x.ws.closed)) {
            s.ws.emit("message", {data: JSON.stringify({id: s.id, type: "event", event: {event_type, data: {action: "update"}}})});
        }
    };
    ha.WebSocket = WS;
    return ha;
}
const area = (area_id, name) => ({area_id, name, aliases: [], floor_id: null, labels: []});
const haDevice = (ieee, area_id = null, extra = {}) => ({id: `dev-${ieee}`, identifiers: [["mqtt", `zigbee2mqtt_${ieee}`]], area_id, disabled_by: null, ...extra});
const haEntity = (ieee, {domain = "light", ep, area_id = null, ...extra} = {}) => {
    const objectId = ep ? `${domain}_${ep}` : domain;
    return {entity_id: `${domain}.${ieee}_${objectId}`, device_id: `dev-${ieee}`, platform: "mqtt", unique_id: `${ieee}_${objectId}_${BASE}`, area_id, disabled_by: null, entity_category: null, ...extra};
};

// ---------- подставной Z2M: устройства, группы, запросы bridge через шину ----------
// Класс назван Group: расширение отличает группу от устройства по constructor.name, как bridge.getEntity.
class Group {
    constructor(zh, z) {
        this.zh = zh;
        this.z = z;
    }
    get ID() {
        return this.zh.groupID;
    }
    get name() {
        return this.z.settingsGroups[this.ID]?.friendly_name ?? String(this.ID);
    }
}
function fakeZ2M({devices = [], groups = [], failAdd = new Set()} = {}) {
    const z = {settingsGroups: {}, zhGroups: new Map(), commands: [], requests: [], failAdd};
    const byIeee = new Map();
    for (const d of devices) {
        const zhDev = {type: "Router", ieeeAddr: d.ieee};
        zhDev.endpoints = (d.endpoints ?? [{ID: 1}]).map(({ID, groups: hasGroups = true}) => ({
            ID,
            deviceIeeeAddress: d.ieee,
            supportsInputCluster: (name) => name === "genGroups" && hasGroups,
            hardwareGroups: new Set(),
            async command(cluster, command) {
                assert.equal(cluster, "genGroups");
                assert.equal(command, "getMembership");
                return {groupcount: this.hardwareGroups.size, grouplist: [...this.hardwareGroups]};
            },
        }));
        const names = d.endpointNames ?? {};
        byIeee.set(d.ieee, {
            ieeeAddr: d.ieee,
            name: d.name ?? d.ieee,
            zh: zhDev,
            options: {},
            // Как lib/model/device.ts: endpoint(key)
            endpoint(key) {
                if (!key) return zhDev.endpoints[0];
                if (!Number.isNaN(Number(key))) return zhDev.endpoints.find((e) => e.ID === Number(key));
                return zhDev.endpoints.find((e) => e.ID === names[key]);
            },
        });
    }
    const ep = (ieee, id) => byIeee.get(ieee).zh.endpoints.find((e) => e.ID === id);
    for (const g of groups) {
        z.settingsGroups[g.id] = {friendly_name: g.name};
        z.zhGroups.set(g.id, {groupID: g.id, members: g.members.map(([ieee, id]) => ep(ieee, id))});
        for (const [ieee, id] of g.members) ep(ieee, id).hardwareGroups.add(g.id);
    }
    const groupByKey = (key) => {
        const id = z.settingsGroups[key] ? Number(key) : Number(Object.entries(z.settingsGroups).find(([, v]) => v.friendly_name === key)?.[0]);
        return z.zhGroups.has(id) ? new Group(z.zhGroups.get(id), z) : undefined;
    };
    z.zigbee = {
        *devicesIterator() {
            yield* byIeee.values();
        },
        *groupsIterator(predicate = () => true) {
            for (const g of z.zhGroups.values()) if (predicate(g)) yield new Group(g, z);
        },
        resolveEntity: (key) => byIeee.get(key) ?? [...byIeee.values()].find((d) => d.name === key) ?? groupByKey(key),
    };
    z.settings = {get: () => ({mqtt: {base_topic: BASE}, groups: z.settingsGroups})};
    const published = [];
    z.bus = {
        onMQTTMessagePublished: (key, cb) => published.push(cb),
        removeListeners: () => {
            published.length = 0;
        },
        emitMQTTMessage({topic, message}) {
            const name = topic.slice(`${BASE}/bridge/request/`.length);
            const req = JSON.parse(message);
            z.requests.push({name, ...req});
            later(() => {
                let res;
                try {
                    res = {status: "ok", data: handle(name, req)};
                } catch (error) {
                    res = {status: "error", data: {}, error: error.message};
                }
                if (req.transaction !== undefined) res.transaction = req.transaction;
                for (const cb of published) cb({topic: `${BASE}/bridge/response/${name}`, payload: JSON.stringify(res)});
            });
        },
    };
    function handle(name, req) {
        if (name === "group/add") {
            if (groupByKey(req.friendly_name) || z.settingsGroups[req.id]) throw new Error("already in use");
            z.settingsGroups[req.id] = {friendly_name: req.friendly_name};
            z.zhGroups.set(Number(req.id), {groupID: Number(req.id), members: []});
            return {};
        }
        if (name === "group/rename") {
            const g = groupByKey(req.from);
            z.settingsGroups[g.ID].friendly_name = req.to;
            return {};
        }
        if (name === "group/remove") {
            const g = groupByKey(req.id);
            if (!g) throw new Error(`Group '${req.id}' does not exist`);
            // zh Group.removeFromNetwork снял бы оставшихся участников подряд, без пауз — помечаем, чтобы это ловить.
            for (const e of g.zh.members) z.commands.push({action: "remove", via: "group/remove", group: g.ID, ieee: e.deviceIeeeAddress, ep: e.ID, at: Date.now()});
            z.zhGroups.delete(g.ID);
            delete z.settingsGroups[g.ID];
            return {};
        }
        const g = groupByKey(req.group);
        const e = byIeee.get(req.device).endpoint(req.endpoint);
        if (name === "group/members/add") {
            if (z.failAdd.has(req.device)) throw new Error(`Failed to add to group (Timeout - ${req.device})`);
            z.commands.push({action: "add", group: g.ID, ieee: req.device, ep: e.ID, at: Date.now()});
            if (!g.zh.members.includes(e)) g.zh.members.push(e);
            e.hardwareGroups.add(g.ID);
        } else if (name === "group/members/remove") {
            z.commands.push({action: "remove", group: g.ID, ieee: req.device, ep: e.ID, at: Date.now()});
            g.zh.members.splice(g.zh.members.indexOf(e), 1);
            e.hardwareGroups.delete(g.ID);
        }
        return {};
    }
    z.members = (id) => (z.zhGroups.get(id)?.members ?? []).map((e) => `${e.deviceIeeeAddress}/${e.ID}`).sort();
    return z;
}

const running = [];
test.afterEach(async () => {
    for (const ext of running.splice(0)) await ext.stop();
});
async function start(z, ha, {token = "tok", dataDir = fs.mkdtempSync(path.join(dir, "data-"))} = {}) {
    const log = fakeLogger();
    const ext = new AreaGroups(z.zigbee, {}, {}, async () => {}, z.bus, null, null, null, z.settings, log, {token, WebSocket: ha?.WebSocket, url: "ws://ha.test/ws", timing: TIMING, dataDir});
    running.push(ext);
    await ext.start();
    return {ext, log, dataDir, lines: () => log.lines.filter((l) => l.msg.startsWith("BMS: ")).map((l) => `${l.level} ${l.msg}`)};
}
const settled = (z, ext) => until(() => !ext.running && !ext.timer && z.requests.length > 0, "проход закончен");

// Дом: кухня — 2 лампы; зал — 2 лампы и канал l2 реле (сущность в зале, само реле на кухне); спальня — 1 лампа.
const L = (n) => `0x00000000000000${n.toString(16).padStart(2, "0")}`;
function house(extra = {}) {
    const devices = [1, 2, 3, 4, 5].map((n) => ({ieee: L(n), name: `lamp${n}`}));
    devices.push({ieee: L(6), name: "relay", endpoints: [{ID: 1}, {ID: 2}], endpointNames: {l1: 1, l2: 2}});
    devices.push({ieee: L(7), name: "sensor", endpoints: [{ID: 1, groups: false}]});
    const ha = {
        areas: [area("kitchen", "Кухня"), area("hall", "Зал"), area("bedroom", "Спальня")],
        devices: [haDevice(L(1), "kitchen"), haDevice(L(2), "kitchen"), haDevice(L(3), "hall"), haDevice(L(4), "hall"), haDevice(L(5), "bedroom"), haDevice(L(6), "kitchen"), haDevice(L(7), "bedroom")],
        entities: [
            ...[1, 2, 3, 4, 5].map((n) => haEntity(L(n))),
            haEntity(L(6), {domain: "switch", ep: "l1"}),
            haEntity(L(6), {domain: "switch", ep: "l2", area_id: "hall"}),
            // Настройка устройства (entity_category) и свойство-выключатель — не каналы, в группу не идут.
            haEntity(L(1), {domain: "switch", ep: "do_not_disturb"}),
            haEntity(L(6), {domain: "switch", ep: "child_lock", entity_category: "config", area_id: "bedroom"}),
            haEntity(L(7), {domain: "switch"}),
        ],
        ...extra,
    };
    return {devices, ha};
}

test("desiredAreas: область сущности важнее области устройства, каналы реле, без genGroups и одиночки — мимо", () => {
    const {devices, ha} = house();
    const z = fakeZ2M({devices});
    const want = desiredAreas(ha, [...z.zigbee.devicesIterator()], BASE);
    const view = Object.fromEntries([...want].map(([id, a]) => [id, {name: a.name, members: [...a.members.keys()].sort()}]));
    assert.deepEqual(view, {
        kitchen: {name: "Комната · Кухня", members: [`${L(1)}/1`, `${L(2)}/1`, `${L(6)}/1`]},
        hall: {name: "Комната · Зал", members: [`${L(3)}/1`, `${L(4)}/1`, `${L(6)}/2`]},
    });
    // Другая база MQTT (второй Z2M рядом) — его сущности не наши.
    assert.equal(desiredAreas(ha, [...z.zigbee.devicesIterator()], "other").size, 0);
});

test("создаёт группы по областям: id из своего диапазона, состав, файл соответствия, паузы между командами", async () => {
    const {devices, ha: reg} = house();
    const z = fakeZ2M({devices});
    const ha = fakeHA(reg);
    const {ext, lines, dataDir} = await start(z, ha);
    await settled(z, ext);
    assert.deepEqual(z.settingsGroups, {1000: {friendly_name: "Комната · Кухня"}, 1001: {friendly_name: "Комната · Зал"}});
    assert.deepEqual(z.members(1000), [`${L(1)}/1`, `${L(2)}/1`, `${L(6)}/1`]);
    assert.deepEqual(z.members(1001), [`${L(3)}/1`, `${L(4)}/1`, `${L(6)}/2`]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, MAP_FILE), "utf8")), {areas: {kitchen: 1000, hall: 1001}});
    // По одной команде с паузой: ни одна пара соседних команд не ближе pause.
    const gaps = z.commands.slice(1).map((c, i) => c.at - z.commands[i].at);
    assert.equal(z.commands.length, 6);
    assert.ok(gaps.every((g) => g >= TIMING.pause - 2), `паузы ${gaps}`);
    assert.deepEqual(lines(), [
        "info BMS: группы по комнатам — Home Assistant на связи, слежу за областями",
        "info BMS: создана группа 'Комната · Кухня' (id 1000)",
        "info BMS: в группу 'Комната · Кухня' добавлены: lamp1/1, lamp2/1, relay/1",
        "info BMS: создана группа 'Комната · Зал' (id 1001)",
        "info BMS: в группу 'Комната · Зал' добавлены: lamp3/1, lamp4/1, relay/2",
    ]);
    // Повторный проход без изменений — ни одной команды.
    const before = z.requests.length;
    ha.fire("entity_registry_updated");
    await until(() => ha.lists === 2 && !ext.running, "второй проход");
    assert.equal(z.requests.length, before);
});

test("чужие группы не трогаем: «Все лампы» id 1, своя группа владельца в нашем диапазоне без приставки, занятое имя", async () => {
    const {devices, ha: reg} = house();
    const foreign = [
        {id: 1, name: "Все лампы", members: [[L(1), 1], [L(2), 1], [L(3), 1], [L(4), 1], [L(5), 1]]},
        {id: 1000, name: "Моя группа", members: [[L(5), 1]]},
        {id: 7, name: "Комната · Зал", members: [[L(5), 1]]},
    ];
    const z = fakeZ2M({devices, groups: foreign});
    // Кухне раньше достался id 1000 (файл соответствия), а потом владелец сам занял 1000 своей группой.
    const dataDir = fs.mkdtempSync(path.join(dir, "data-"));
    fs.writeFileSync(path.join(dataDir, MAP_FILE), JSON.stringify({areas: {kitchen: 1000}}));
    const {ext, lines} = await start(z, fakeHA(reg), {dataDir});
    await settled(z, ext);
    assert.deepEqual(z.members(1), [1, 2, 3, 4, 5].map((n) => `${L(n)}/1`));
    assert.deepEqual(z.members(1000), [`${L(5)}/1`]);
    assert.deepEqual(z.members(7), [`${L(5)}/1`]);
    assert.equal(z.settingsGroups[1].friendly_name, "Все лампы");
    assert.equal(z.settingsGroups[1000].friendly_name, "Моя группа");
    // Кухня получила свободный id мимо занятого владельцем 1000; зал не создан — имя занято чужой группой 7.
    assert.equal(z.settingsGroups[1001].friendly_name, "Комната · Кухня");
    assert.ok(z.requests.every((r) => ![1, 7, 1000].includes(Number(r.group ?? r.id))), JSON.stringify(z.requests));
    assert.ok(lines().includes("warning BMS: группа 'Комната · Зал' не создана — имя уже занято в Z2M"), lines().join("\n"));
});

test("изменения в HA: пачка событий склеивается в один проход, лишних убирает, недостающих добавляет", async () => {
    const {devices, ha: reg} = house();
    const z = fakeZ2M({devices});
    const ha = fakeHA(reg);
    const {ext, lines} = await start(z, ha);
    await settled(z, ext);
    const lists = ha.lists;
    // lamp2 переехала в зал, спальня получила вторую лампу (lamp4) — пять событий подряд.
    ha.devices.find((d) => d.id === `dev-${L(2)}`).area_id = "hall";
    ha.devices.find((d) => d.id === `dev-${L(4)}`).area_id = "bedroom";
    // Пять событий с промежутком меньше debounce, но все вместе дольше него: проход один и только после последнего.
    for (const t of ["device_registry_updated", "entity_registry_updated", "device_registry_updated", "area_registry_updated", "entity_registry_updated"]) {
        ha.fire(t);
        await sleep(TIMING.debounce / 2);
    }
    assert.equal(ha.lists, lists, "проход начался до конца пачки событий");
    await until(() => ha.lists > lists && !ext.running && !ext.timer, "проход после событий");
    await sleep(TIMING.debounce * 2);
    assert.equal(ha.lists, lists + 1, "пять событий — один проход");
    assert.deepEqual(z.members(1000), [`${L(1)}/1`, `${L(6)}/1`]);
    assert.deepEqual(z.members(1001), [`${L(2)}/1`, `${L(3)}/1`, `${L(6)}/2`]);
    assert.deepEqual(z.members(1002), [`${L(4)}/1`, `${L(5)}/1`]);
    assert.equal(z.settingsGroups[1002].friendly_name, "Комната · Спальня");
    assert.ok(lines().includes("info BMS: из группы 'Комната · Кухня' убраны: lamp2/1"), lines().join("\n"));
    assert.ok(lines().includes("info BMS: в группу 'Комната · Зал' добавлены: lamp2/1"), lines().join("\n"));
});

test("область удалили — своя группа удаляется; в комнате осталось одно устройство — тоже, id за комнатой сохраняется", async () => {
    const {devices, ha: reg} = house();
    const z = fakeZ2M({devices, groups: [{id: 1, name: "Все лампы", members: [[L(1), 1]]}]});
    const ha = fakeHA(reg);
    const {ext, lines, dataDir} = await start(z, ha);
    await settled(z, ext);
    // Зал удалён (HA снимает area_id у устройств и сущностей); с кухни убрали lamp2 и реле — там одна lamp1.
    ha.areas = ha.areas.filter((a) => a.area_id !== "hall");
    for (const d of ha.devices) if (d.area_id === "hall") d.area_id = null;
    for (const e of ha.entities) if (e.area_id === "hall") e.area_id = null;
    ha.devices.find((d) => d.id === `dev-${L(2)}`).area_id = null;
    ha.devices.find((d) => d.id === `dev-${L(6)}`).area_id = null;
    ha.fire("area_registry_updated");
    await until(() => !z.zhGroups.has(1000) && !z.zhGroups.has(1001) && !ext.running, "обе группы удалены");
    assert.deepEqual(Object.keys(z.settingsGroups), ["1"]);
    assert.deepEqual(z.members(1), [`${L(1)}/1`]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, MAP_FILE), "utf8")), {areas: {kitchen: 1000}});
    assert.ok(lines().includes("info BMS: удалена группа 'Комната · Зал' (id 1001) — области больше нет"), lines().join("\n"));
    assert.ok(lines().includes("info BMS: удалена группа 'Комната · Кухня' (id 1000) — в комнате меньше двух устройств"), lines().join("\n"));
    // Участников снимали по одному запросом members/remove, group/remove — уже пустой группе.
    assert.deepEqual(z.commands.filter((c) => c.via), []);
    assert.equal(z.commands.filter((c) => c.action === "remove").length, 6);
    // Кухне вернули вторую лампу — та же группа 1000.
    ha.devices.find((d) => d.id === `dev-${L(2)}`).area_id = "kitchen";
    ha.fire("device_registry_updated");
    await until(() => z.members(1000).length === 2 && !ext.running, "кухня снова с группой");
    assert.equal(z.settingsGroups[1000].friendly_name, "Комната · Кухня");
});

test("переименование области — та же группа (тот же id) под новым именем", async () => {
    const {devices, ha: reg} = house();
    const z = fakeZ2M({devices});
    const ha = fakeHA(reg);
    const {ext, lines} = await start(z, ha);
    await settled(z, ext);
    const commands = z.commands.length;
    ha.areas.find((a) => a.area_id === "kitchen").name = "Кухня-столовая";
    ha.fire("area_registry_updated");
    await until(() => z.settingsGroups[1000]?.friendly_name === "Комната · Кухня-столовая" && !ext.running, "переименована");
    assert.equal(z.commands.length, commands, "в эфир ничего");
    assert.ok(lines().includes("info BMS: группа 'Комната · Кухня' (id 1000) переименована в 'Комната · Кухня-столовая'"));
});

test("таймаут добавления — строка в журнале, остальные добавлены, позже повтор доводит дело", async () => {
    const {devices, ha: reg} = house();
    const z = fakeZ2M({devices, failAdd: new Set([L(2)])});
    const {ext, lines} = await start(z, fakeHA(reg));
    await until(() => z.members(1001).length === 3, "зал собран");
    assert.deepEqual(z.members(1000), [`${L(1)}/1`, `${L(6)}/1`]);
    assert.ok(lines().some((l) => l.startsWith(`warning BMS: 'lamp2' (endpoint 1) не добавлено в 'Комната · Кухня': Failed to add to group (Timeout`)), lines().join("\n"));
    z.failAdd.clear(); // устройство снова отвечает
    await until(() => z.members(1000).length === 3 && !ext.running, "повтор добавил lamp2");
    assert.ok(lines().includes("info BMS: в группу 'Комната · Кухня' добавлены: lamp2/1"));
});

test("нет токена (не дополнение) — одна строка в журнале, к HA не ходим, ничего не делаем", async () => {
    const z = fakeZ2M(house());
    const ha = fakeHA(house().ha);
    const saved = process.env.SUPERVISOR_TOKEN;
    delete process.env.SUPERVISOR_TOKEN;
    try {
        const log = fakeLogger();
        const ext = new AreaGroups(z.zigbee, {}, {}, async () => {}, z.bus, null, null, null, z.settings, log, {WebSocket: ha.WebSocket, timing: TIMING});
        running.push(ext);
        await ext.start();
        await sleep(50);
        assert.equal(ha.sockets.length, 0);
        assert.deepEqual(z.requests, []);
        assert.deepEqual(log.lines.map((l) => l.level), ["info"]);
        assert.match(log.lines[0].msg, /^BMS: группы по комнатам выключены — нет доступа к Home Assistant/);
    } finally {
        if (saved !== undefined) process.env.SUPERVISOR_TOKEN = saved;
    }
});

test("HA не принял токен — одна строка и выключение, без переподключений", async () => {
    const z = fakeZ2M(house());
    const ha = fakeHA({...house().ha, acceptToken: false});
    const {lines} = await start(z, ha);
    await sleep(100);
    assert.equal(ha.sockets.length, 1);
    assert.deepEqual(z.requests, []);
    assert.deepEqual(lines(), ["warning BMS: группы по комнатам выключены — Home Assistant не пустил (Invalid access token or password); нужен homeassistant_api: true в дополнении"]);
});

test("HA перезапустился — переподключение, подписка заново, проход", async () => {
    const {devices, ha: reg} = house();
    const z = fakeZ2M({devices});
    const ha = fakeHA(reg);
    const {ext, lines} = await start(z, ha);
    await settled(z, ext);
    ha.sockets[0].close();
    await until(() => ha.sockets.length === 2 && ha.subscriptions.filter((s) => s.ws === ha.sockets[1]).length === 3, "переподключились");
    ha.devices.find((d) => d.id === `dev-${L(5)}`).area_id = "kitchen";
    ha.fire("device_registry_updated");
    await until(() => z.members(1000).length === 4 && !ext.running, "lamp5 на кухне");
    assert.equal(lines().filter((l) => l.startsWith("warning BMS: группы по комнатам — нет связи")).length, 1);
});

test("A5: база уже содержит участника, но устройство потеряло группу — add и физическая проверка", async () => {
    const {devices, ha: registries} = house();
    const z = fakeZ2M({devices, groups: [{id: 1000, name: "Комната · Кухня", members: [[L(1), 1], [L(2), 1], [L(6), 1]]}]});
    const lost = z.zigbee.resolveEntity(L(1)).endpoint();
    lost.hardwareGroups.clear();
    const {ext} = await start(z, fakeHA(registries));
    await settled(z, ext);
    assert.ok(z.commands.some((c) => c.action === "add" && c.ieee === L(1) && c.group === 1000));
    assert.equal(lost.hardwareGroups.has(1000), true);
    assert.equal(ext.membership.isVerified(z.zigbee.resolveEntity("1000")), true);
});

test("A5: неподтверждённое физическое членство блокирует оптимизацию группы", async () => {
    const {devices, ha: registries} = house();
    const z = fakeZ2M({devices, groups: [{id: 1000, name: "Комната · Кухня", members: [[L(1), 1], [L(2), 1], [L(6), 1]]}]});
    z.zigbee.resolveEntity(L(1)).endpoint().command = async () => { throw new Error("Timeout"); };
    const {ext, log} = await start(z, fakeHA(registries));
    await until(() => log.lines.some((l) => /членство.*не подтверждено/.test(l.msg)), "ошибка проверки членства");
    assert.equal(ext.membership.isVerified(z.zigbee.resolveEntity("1000")), false);
});
