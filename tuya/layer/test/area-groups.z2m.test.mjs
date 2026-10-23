// bms-area-groups на настоящих классах Zigbee2MQTT из стенда (tools/stand.sh): расширение грузит его механизм
// внешних расширений, запросы разбирают его Bridge и Groups, ответы публикует его Mqtt (emitMQTTMessagePublished),
// discovery группы делает его HomeAssistant, группы и configuration.yaml ведёт его settings.
// Home Assistant — настоящий WebSocket-сервер (пакет ws из Z2M) с реестрами; адрес — через BMS_HA_WS_URL.
// Подставные только zigbee-herdsman (устройства/группы/endpoint с записью команд) и MQTT-клиент Mqtt.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {Device as ZhDevice, makeDataDir, requireZ2M, zhc} from "./stand.mjs";

const BASE = "zigbee2mqtt";
const L = (n) => `0x00000000000000b${n}`;
const LAMPS = [1, 2, 3].map((n) => ({ieee: L(n), name: `lamp${n}`}));

// ---------- Home Assistant: настоящий WebSocket API с реестрами ----------
const {WebSocketServer} = requireZ2M("ws");
const ha = {
    areas: [{area_id: "kitchen", name: "Кухня"}, {area_id: "hall", name: "Зал"}],
    devices: LAMPS.map((l, i) => ({id: `dev-${l.ieee}`, identifiers: [["mqtt", `zigbee2mqtt_${l.ieee}`]], area_id: i < 2 ? "kitchen" : "hall", disabled_by: null})),
    entities: LAMPS.map((l) => ({entity_id: `light.${l.name}`, device_id: `dev-${l.ieee}`, platform: "mqtt", unique_id: `${l.ieee}_light_${BASE}`, area_id: null, disabled_by: null, entity_category: null})),
    subs: [],
    auths: [],
};
const server = new WebSocketServer({port: 0, host: "127.0.0.1"});
await new Promise((resolve) => server.on("listening", resolve));
server.on("connection", (ws) => {
    ws.send(JSON.stringify({type: "auth_required", ha_version: "2026.9.0"}));
    ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        const result = (r) => ws.send(JSON.stringify({id: m.id, type: "result", success: true, result: r}));
        if (m.type === "auth") {
            ha.auths.push(m.access_token);
            ws.send(JSON.stringify({type: m.access_token === "supervisor-token" ? "auth_ok" : "auth_invalid"}));
        } else if (m.type === "subscribe_events") {
            ha.subs.push({ws, id: m.id, event_type: m.event_type});
            result(null);
        } else if (m.type === "config/area_registry/list") result(ha.areas);
        else if (m.type === "config/device_registry/list") result(ha.devices);
        else if (m.type === "config/entity_registry/list") result(ha.entities);
    });
});
const fire = (event_type) => {
    for (const s of ha.subs.filter((x) => x.event_type === event_type)) s.ws.send(JSON.stringify({id: s.id, type: "event", event: {event_type, data: {}}}));
};

// ---------- папка данных и окружение как у дополнения ----------
const dataDir = makeDataDir({withNodeModules: false});
fs.writeFileSync(
    path.join(dataDir, "configuration.yaml"),
    [
        "homeassistant: {enabled: true}",
        "frontend: {enabled: false}",
        `mqtt: {base_topic: ${BASE}, server: 'mqtt://localhost'}`,
        "serial: {port: /dev/null, adapter: ember}",
        "advanced: {log_level: debug, enable_external_js: true, cache_state: true}",
        "devices:",
        ...LAMPS.map((l) => `  '${l.ieee}': {friendly_name: ${l.name}}`),
        "groups:",
        "  '1': {friendly_name: Все лампы}",
    ].join("\n"),
);
process.env.ZIGBEE2MQTT_DATA = dataDir; // lib/util/data.ts:4 — до первого require из Z2M
process.env.SUPERVISOR_TOKEN = "supervisor-token";
process.env.BMS_HA_WS_URL = `ws://127.0.0.1:${server.address().port}`;
process.env.BMS_AREA_GROUPS_TIMING = JSON.stringify({startDelay: 0, debounce: 50, pause: 40, reply: 2000, retry: 200, retryMax: 200});

const settings = requireZ2M("./dist/util/settings.js");
settings.reRead();
const logger = requireZ2M("./dist/util/logger.js").default;
const log = [];
logger.log = (level, message, namespace) => log.push({level, namespace, message: typeof message === "function" ? message() : message});
logger.addTransport = () => {};
logger.removeTransport = () => {}; // Bridge.start вешает транспорт bridge/logging на winston, а winston без logger.init не поднят
zhc.setLogger(logger);
const EventBus = requireZ2M("./dist/eventBus.js").default;
const Mqtt = requireZ2M("./dist/mqtt.js").default;
const Device = requireZ2M("./dist/model/device.js").default;
const Group = requireZ2M("./dist/model/group.js").default;
const State = requireZ2M("./dist/state.js").default;
const ext = (name) => requireZ2M(`./dist/extension/${name}.js`).default;

// ---------- zigbee-herdsman: устройства с genGroups, группы, команды в эфир с отметкой времени ----------
const air = [];
class ZhGroup {
    constructor(groupID) {
        Object.assign(this, {groupID, members: [], meta: {}});
    }
    addMember(e) {
        if (!this.members.includes(e)) this.members.push(e);
    }
    removeMember(e) {
        this.members.splice(this.members.indexOf(e), 1);
    }
    // Как zh Group.removeFromNetwork: каждому участнику remove подряд, потом из базы.
    async removeFromNetwork() {
        for (const e of [...this.members]) await e.removeFromGroup(this);
        zhGroups.delete(this.groupID);
    }
    removeFromDatabase() {
        zhGroups.delete(this.groupID);
    }
}
const zhGroups = new Map([[1, new ZhGroup(1)]]);
const zhDevices = LAMPS.map((l) => new ZhDevice({ieeeAddr: l.ieee, manufacturerName: "_TZ3210_bmslight", modelID: "TS0502B", type: "Router", endpoints: [{ID: 1, input: ["genBasic", "genGroups", "genOnOff", "lightingColorCtrl"]}]}));
for (const zd of zhDevices) {
    for (const e of zd.endpoints) {
        Object.assign(e, {binds: [], configuredReportings: [], meta: {}, clusters: {}, getDevice: () => zd});
        // Как zh Endpoint.addToGroup/removeFromGroup: команда genGroups в эфир, потом правка базы группы.
        e.addToGroup = async (g) => {
            air.push({cmd: "add", ieee: zd.ieeeAddr, group: g.groupID, at: Date.now()});
            g.addMember(e);
            e.hardwareGroups.add(g.groupID);
        };
        e.removeFromGroup = async (g) => {
            air.push({cmd: "remove", ieee: zd.ieeeAddr, group: g.groupID, at: Date.now()});
            g.removeMember(e);
            e.hardwareGroups.delete(g.groupID);
        };
    }
}
zhGroups.get(1).members.push(...zhDevices.map((d) => d.endpoints[0]));
for (const d of zhDevices) d.endpoints[0].hardwareGroups.add(1);
const devices = zhDevices.map((zd) => new Device(zd));
const groupLookup = new Map();
const zigbee = {
    async resolveDevicesDefinitions(ignoreCache) {
        for (const d of devices) await d.resolveDefinition(ignoreCache);
    },
    // Как lib/zigbee.ts:322 (resolveEntity) / :305 (resolveGroup) / :461 (createGroup) / :480 (removeGroupFromLookup).
    resolveEntity(key) {
        if (typeof key === "object") return devices.find((d) => d.zh === key);
        const dev = devices.find((d) => d.name === key || d.ieeeAddr === key);
        if (dev) return dev;
        const g = settings.getGroup(key);
        if (g) return this.resolveGroup(g.ID) ?? this.createGroup(g.ID);
    },
    resolveGroup(id) {
        if (!groupLookup.has(id) && zhGroups.has(id)) groupLookup.set(id, new Group(zhGroups.get(id), (ieee) => devices.find((d) => d.ieeeAddr === ieee)));
        return groupLookup.get(id);
    },
    createGroup(id) {
        if (!zhGroups.has(id)) zhGroups.set(id, new ZhGroup(id));
        return this.resolveGroup(id);
    },
    removeGroupFromLookup: (id) => groupLookup.delete(id),
    resolveEntityAndEndpoint(id) {
        const entity = this.resolveEntity(id);
        return {ID: id, entity, endpointID: undefined, endpoint: entity?.endpoint?.()};
    },
    *devicesIterator(predicate = () => true) {
        yield* devices.filter((d) => predicate(d.zh));
    },
    *groupsIterator(predicate = () => true) {
        for (const g of [...zhGroups.values()].filter(predicate)) yield zigbee.resolveGroup(g.groupID);
    },
    *devicesAndGroupsIterator(dp = () => true, gp = () => true) {
        yield* zigbee.devicesIterator(dp);
        yield* zigbee.groupsIterator(gp);
    },
    firstCoordinatorEndpoint: () => ({ID: 1, deviceIeeeAddress: "0x00000000000000c0"}),
    getCoordinatorVersion: async () => ({type: "EmberZNet", meta: {}}),
    getNetworkParameters: async () => ({panID: 1, extendedPanID: "0x01", channel: 15}),
    getPermitJoin: () => false,
    getPermitJoinEnd: () => undefined,
    isStopping: () => false,
};
await zigbee.resolveDevicesDefinitions();

const eventBus = new EventBus();
const mqtt = new Mqtt(eventBus);
const broker = [];
// Клиент MQTT «подключён» и пишет в память; сама публикация (и emitMQTTMessagePublished) — настоящий Mqtt.publish.
mqtt.client = {
    reconnecting: false,
    disconnecting: false,
    disconnected: false,
    publishAsync: async (topic, payload, options) => broker.push({topic, payload, retain: Boolean(options?.retain)}),
    subscribeAsync: async () => {},
    unsubscribeAsync: async () => {},
    options: {protocolVersion: 4},
};
const state = new State(eventBus, zigbee);
const publishEntityState = async () => {};
const added = [];
const addExtension = async (extension) => {
    added.push(extension.constructor.name);
    await extension.start();
};
const args = [zigbee, mqtt, state, publishEntityState, eventBus, async () => {}, async () => {}, addExtension];
const started = [];
for (const name of ["bridge", "groups", "homeassistant", "externalExtensions"]) {
    const e = new (ext(name))(...args);
    await e.start();
    started.push(e);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(cond, what, ms = 5000) {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) assert.fail(`не дождались: ${what}\n${log.filter((l) => l.level !== "debug").map((l) => `${l.level} ${l.message}`).join("\n")}`);
        await sleep(10);
    }
}
// Тема discovery группы: homeassistant/light/<закодированная база>_<id группы>/light/config (homeassistant.ts: getDiscoveryTopic).
const discoveryOf = (id) => broker.filter((b) => new RegExp(`^homeassistant/light/[0-9a-z]+_${id}/light/config$`).test(b.topic));
const members = (id) => (zhGroups.get(id)?.members ?? []).map((e) => e.deviceIeeeAddress).sort();
const bmsLines = () => log.filter((l) => l.namespace === "bms:area-groups").map((l) => `${l.level} ${l.message}`);

test.after(async () => {
    for (const e of started) await e.stop?.();
    for (const c of server.clients) c.terminate();
    server.close();
    // HomeAssistant.start оставляет таймер discovery на 5 с — не ждём его.
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

test("Z2M загрузил расширение своим механизмом, вход в HA по SUPERVISOR_TOKEN", async () => {
    assert.ok(log.some((l) => l.message === "Loaded external extension 'bms-area-groups.mjs'."), "не загружено");
    assert.ok(added.includes("BmsAreaGroups"));
    const files = fs.readdirSync(path.join(dataDir, "external_extensions"));
    assert.deepEqual(files.filter((f) => f.endsWith(".invalid")), []);
    await until(() => ha.subs.length === 3, "подписка на три события реестров");
    assert.deepEqual(ha.auths, ["supervisor-token"]);
    assert.deepEqual(ha.subs.map((s) => s.event_type).sort(), ["area_registry_updated", "device_registry_updated", "entity_registry_updated"]);
});

test("кухня (2 лампы) — группа 1000 в configuration.yaml и базе, add в эфир по одному, discovery светильника в HA; зал (1 лампа) — без группы", async () => {
    await until(() => members(1000).length === 2, "группа кухни собрана");
    await sleep(200);
    assert.deepEqual(settings.getGroup(1000), {friendly_name: "Комната · Кухня", ID: 1000});
    assert.match(fs.readFileSync(path.join(dataDir, "configuration.yaml"), "utf8"), /'1000':\s*\n\s*friendly_name: Комната · Кухня/);
    assert.deepEqual(members(1000), [L(1), L(2)]);
    assert.equal(settings.getGroup(1001), undefined);
    // «Все лампы» (id 1) как была.
    assert.deepEqual(settings.getGroup(1), {friendly_name: "Все лампы", ID: 1});
    assert.deepEqual(members(1), [L(1), L(2), L(3)]);
    const adds = air.filter((a) => a.cmd === "add");
    assert.deepEqual(adds.map((a) => [a.ieee, a.group]), [[L(1), 1000], [L(2), 1000]]);
    assert.ok(adds[1].at - adds[0].at >= 38, `пауза ${adds[1].at - adds[0].at} мс`);
    // Ответы Bridge/Groups пришли в MQTT с нашим transaction.
    const responses = broker.filter((b) => b.topic.startsWith(`${BASE}/bridge/response/`)).map((b) => [b.topic.slice(BASE.length + 1), JSON.parse(b.payload).status]);
    assert.deepEqual(responses, [["bridge/response/group/add", "ok"], ["bridge/response/group/members/add", "ok"], ["bridge/response/group/members/add", "ok"]]);
    // Discovery: Home Assistant получит светильник группы с участниками.
    const disc = discoveryOf(1000).filter((b) => b.payload).map((b) => JSON.parse(b.payload)).at(-1);
    assert.ok(disc, broker.map((b) => b.topic).join("\n"));
    assert.equal(disc.device.name, "Комната · Кухня");
    assert.equal(disc.command_topic, `${BASE}/Комната · Кухня/set`);
    assert.deepEqual(disc.group?.sort(), [`${L(1)}_light_${BASE}`, `${L(2)}_light_${BASE}`]);
    assert.deepEqual(bmsLines().filter((l) => !l.startsWith("debug")), [
        "info BMS: группы по комнатам — Home Assistant на связи, слежу за областями",
        "info BMS: создана группа 'Комната · Кухня' (id 1000)",
        "info BMS: в группу 'Комната · Кухня' добавлены: lamp1/1, lamp2/1",
    ]);
    assert.deepEqual(log.filter((l) => l.level === "error"), []);
});

test("область удалили в HA — участники сняты по одному, группа удалена штатно, discovery очищен; «Все лампы» на месте", async () => {
    ha.areas = ha.areas.filter((a) => a.area_id !== "kitchen");
    for (const d of ha.devices) if (d.area_id === "kitchen") d.area_id = null;
    fire("area_registry_updated");
    await until(() => !zhGroups.has(1000) && settings.getGroup(1000) === undefined, "группа кухни удалена");
    await sleep(100);
    assert.doesNotMatch(fs.readFileSync(path.join(dataDir, "configuration.yaml"), "utf8"), /Комната/);
    const removes = air.filter((a) => a.cmd === "remove");
    assert.deepEqual(removes.map((a) => [a.ieee, a.group]), [[L(1), 1000], [L(2), 1000]]);
    assert.ok(removes[1].at - removes[0].at >= 38, `пауза ${removes[1].at - removes[0].at} мс`);
    const cleared = discoveryOf(1000).at(-1);
    assert.equal(cleared.payload, "", "discovery группы снят");
    assert.deepEqual(members(1), [L(1), L(2), L(3)]);
    assert.ok(bmsLines().includes("info BMS: удалена группа 'Комната · Кухня' (id 1000) — области больше нет"), bmsLines().join("\n"));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "bms-area-groups.json"), "utf8")), {areas: {}});
    assert.deepEqual(log.filter((l) => l.level === "error"), []);
});
