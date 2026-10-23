// Прогон на настоящих классах Zigbee2MQTT из стенда (tools/stand.sh): наши файлы грузит его механизм
// внешних файлов (ExternalConverters / ExternalExtensions), сообщения разбирают его Receive и Publish,
// события идут через его EventBus, устройства — его Device с поиском описания converters.
// Подставные только адаптер (zh-устройства с записью отправленного), MQTT-клиент и хранилище состояния.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {Device as ZhDevice, dpv, makeDataDir, requireZ2M, zhc} from "./stand.mjs";

const YAML = `
- fingerprint: [{modelID: TS0601, manufacturerName: _TZE200_bmscurt1}]
  model: BMS-test-curtain
  points:
    - {dp: 1, kind: cover_control}
    - {dp: 2, kind: cover_position, invert: true}
- fingerprint: [{modelID: TS0601, manufacturerName: _TZE200_bmsrel01}]
  model: BMS-test-relay
  points:
    - {dp: 1, kind: switch, endpoint: l1}
    - {dp: 2, kind: switch, endpoint: l2}
- fingerprint: [{modelID: TS0601, manufacturerName: _TZE200_8daqwrsj}]
  model: BMS-test-override
  points:
    - {dp: 1, kind: switch}
`;
const DEVICES = {
    yaml_curtain: {ieee: "0x00000000000000a1", manufacturerName: "_TZE200_bmscurt1"},
    unknown_tze: {ieee: "0x00000000000000a2", manufacturerName: "_TZE200_bmsunkn1"},
    known_bab: {ieee: "0x00000000000000a3", manufacturerName: "_TZE204_g2ki0ejr"},
    // У converters для этого отпечатка своё описание (SMART-HEAT10) — YAML должен его перекрыть.
    overridden: {ieee: "0x00000000000000a4", manufacturerName: "_TZE200_8daqwrsj"},
};

// Папка данных как у дополнения, но ссылку node_modules не кладём: её должен сделать сам Z2M.
const dataDir = makeDataDir({yaml: YAML, withNodeModules: false});
fs.writeFileSync(
    path.join(dataDir, "configuration.yaml"),
    [
        "homeassistant: {enabled: false}",
        "frontend: {enabled: false}",
        "mqtt: {base_topic: zigbee2mqtt, server: 'mqtt://localhost'}",
        "serial: {port: /dev/null, adapter: ember}",
        "advanced: {log_level: debug, enable_external_js: true}",
        "devices:",
        ...Object.entries(DEVICES).map(([name, d]) => `  '${d.ieee}': {friendly_name: ${name}}`),
    ].join("\n"),
);
process.env.ZIGBEE2MQTT_DATA = dataDir; // lib/util/data.ts:4 — до первого require из Z2M

const settings = requireZ2M("./dist/util/settings.js");
settings.reRead();
const logger = requireZ2M("./dist/util/logger.js").default;
const log = [];
logger.log = (level, message, namespace) => log.push({level, namespace, message: typeof message === "function" ? message() : message});
zhc.setLogger(logger); // так делает Controller (controller.ts: zhcSetLogger)
const EventBus = requireZ2M("./dist/eventBus.js").default;
const Device = requireZ2M("./dist/model/device.js").default;
const ext = (name) => requireZ2M(`./dist/extension/${name}.js`).default;

const eventBus = new EventBus();
const coordinatorEndpoint = {ID: 1};
const devices = Object.entries(DEVICES).map(([, d]) => new Device(new ZhDevice({ieeeAddr: d.ieee, manufacturerName: d.manufacturerName})));
const dev = (name) => devices.find((d) => d.name === name);
const zigbee = {
    async resolveDevicesDefinitions(ignoreCache) {
        for (const d of devices) await d.resolveDefinition(ignoreCache);
    },
    resolveEntity: (key) => devices.find((d) => d.name === key || d.ieeeAddr === key || d.zh === key),
    resolveEntityAndEndpoint(id) {
        const entity = this.resolveEntity(id);
        return {ID: id, entity, endpointID: undefined, endpoint: entity?.endpoint()};
    },
    firstCoordinatorEndpoint: () => coordinatorEndpoint,
    *devicesIterator() {
        yield* devices;
    },
};
const published = [];
const mqtt = {publish: async () => {}};
const state = {get: () => ({}), set: (entity, payload) => payload};
const publishEntityState = async (entity, payload) => published.push({name: entity.name, payload});
const added = [];
const addExtension = async (extension) => {
    added.push(extension.constructor.name);
    await extension.start();
};
const args = [zigbee, mqtt, state, publishEntityState, eventBus, async () => {}, async () => {}, addExtension];
// Порядок как в controller.ts:66-85: внешние конвертеры первыми, внешние расширения последними.
for (const Ext of [ext("externalConverters"), ext("receive"), ext("publish"), ext("externalExtensions")]) await new Ext(...args).start();

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const sent = (name, command) => dev(name).zh.endpoints[0].sent.filter((s) => s.command === command);
const emit = async (name, type, data) => {
    const d = dev(name);
    eventBus.emitDeviceMessage({type, device: d, endpoint: d.zh.endpoints[0], cluster: "manuSpecificTuya", data, linkquality: 90, groupID: 0, meta: {zclTransactionSequenceNumber: Math.floor(Math.random() * 250)}});
    await settle();
};

test("Z2M загрузил наши файлы своим механизмом: без ошибок, ссылка node_modules его", () => {
    const errors = log.filter((l) => l.level === "error");
    assert.deepEqual(errors, []);
    const loaded = log.filter((l) => /^Loaded external (converter|extension)/.test(l.message)).map((l) => l.message);
    assert.deepEqual(loaded, [
        "Loaded external converter 'bms-models.mjs'.",
        "Loaded external converter 'bms-models.mjs'.",
        "Loaded external converter 'bms-models.mjs'.",
        "Loaded external extension 'bms-tuya-service.mjs'.",
    ]);
    assert.deepEqual(added, ["BmsTuyaService"]);
    for (const kind of ["external_converters", "external_extensions"]) {
        const files = fs.readdirSync(path.join(dataDir, kind));
        assert.ok(fs.lstatSync(path.join(dataDir, kind, "node_modules")).isSymbolicLink(), `${kind}: ссылки node_modules нет`);
        assert.deepEqual(files.filter((f) => f.endsWith(".invalid") || f.startsWith(".tmp-")), [], `${kind}: ${files}`);
    }
});

test("описание из YAML находится по отпечатку тем же поиском, что у Z2M", () => {
    const curtain = dev("yaml_curtain");
    assert.equal(curtain.definition.model, "BMS-test-curtain");
    assert.equal(curtain.definition.externalConverterName, "bms-models.mjs");
    assert.equal(curtain.isSupported, true);
    assert.equal(dev("known_bab").definition.model, "BAB-1413_Pro");
    assert.equal(dev("unknown_tze").isSupported, false);
    assert.equal(dev("unknown_tze").definition.generated, true);
    assert.equal(dev("overridden").definition.model, "BMS-test-override", "YAML перекрывает встроенное описание с тем же отпечатком");
});

test("запрос времени: каждому устройству ровно один ответ (описание или мы)", async () => {
    for (const name of Object.keys(DEVICES)) await emit(name, "commandMcuSyncTime", {payloadSize: 0});
    for (const name of Object.keys(DEVICES)) await emit(name, "commandMcuGatewayConnectionStatus", {payloadSize: 0});
    for (const name of Object.keys(DEVICES)) {
        assert.equal(sent(name, "mcuSyncTime").length, 1, `${name}: время`);
        assert.equal(sent(name, "mcuGatewayConnectionStatus").length, 1, `${name}: статус`);
    }
});

test("отчёты: неописанное — dp_<номер>, описанное из YAML — разбирает Receive", async () => {
    published.length = 0;
    await emit("unknown_tze", "commandDataReport", {seq: 1, dpValues: [dpv(1, 1, [1]), dpv(3, 2, [0, 0, 1, 0])]});
    await emit("yaml_curtain", "commandDataReport", {seq: 2, dpValues: [dpv(2, 2, [0, 0, 0, 30])]});
    assert.deepEqual(published, [
        {name: "unknown_tze", payload: {dp_1: {type: "bool", value: true}, dp_3: {type: "value", value: 256}}},
        {name: "yaml_curtain", payload: {position: 70}},
    ]);
});

test("команды через MQTT: bms_dp неописанному, position описанному из YAML (через Publish)", async () => {
    eventBus.emitMQTTMessage({topic: "zigbee2mqtt/unknown_tze/set", message: JSON.stringify({bms_dp: {dp: 1, type: "bool", value: false}})});
    eventBus.emitMQTTMessage({topic: "zigbee2mqtt/yaml_curtain/set", message: JSON.stringify({position: 30})});
    await settle();
    const dpOf = (name) => sent(name, "dataRequest").map((s) => s.payload.dpValues[0]);
    assert.deepEqual(dpOf("unknown_tze"), [{dp: 1, datatype: 1, data: Buffer.from([0])}]);
    assert.deepEqual(dpOf("yaml_curtain"), [{dp: 2, datatype: 2, data: Buffer.from([0, 0, 0, 70])}]);
    // Publish самого Z2M не знает ключа bms_dp и пишет об этом в журнал — известный шум, см. README.
    const errors = log.filter((l) => l.level === "error").map((l) => l.message);
    assert.deepEqual(errors, ["No converter available for 'bms_dp' on 'unknown_tze': ({\"dp\":1,\"type\":\"bool\",\"value\":false})"]);
});

test("магический пакет после интервью: неописанному — да, описанному из YAML (tuyaBase) — нет", async () => {
    eventBus.emitDeviceInterview({device: dev("unknown_tze"), status: "successful"});
    eventBus.emitDeviceInterview({device: dev("yaml_curtain"), status: "successful"});
    await settle();
    const reads = (name) => dev(name).zh.endpoints[0].reads.filter((r) => r.cluster === "genBasic" && r.attributes.includes(0xfffe));
    assert.equal(reads("unknown_tze").length, 1);
    assert.equal(reads("yaml_curtain").length, 0);
});
