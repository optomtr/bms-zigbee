// Проверки конвертера bms-models: из YAML собираются описания converters, точки разбираются и отправляются.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {captureZhcLog, Device, dpv, importLayer, LAYER, makeDataDir, zhc} from "./stand.mjs";

async function load(yaml) {
    const log = captureZhcLog();
    const dir = makeDataDir({yaml});
    const {default: definitions} = await importLayer(dir, "external_converters", "bms-models.mjs");
    return {definitions, log, errors: log.filter((l) => l.level === "error").map((l) => l.msg)};
}

// Образцы из bms-models.example.yaml, раскомментированные, — пример обязан быть рабочим.
function exampleUncommented() {
    const text = fs.readFileSync(path.join(LAYER, "bms-models.example.yaml"), "utf8").split("\n");
    const first = text.findIndex((l) => l.startsWith("# - fingerprint:"));
    return text.map((l, i) => (i >= first ? l.replace(/^# ?/, "") : l)).join("\n");
}

const zh = new Device({ieeeAddr: "0x00000000000000aa", manufacturerName: "_TZE200_xxxxxxxx"});
let seq = 100;

/** Как Receive (receive.ts:113): все конвертеры описания для кадра Tuya, результаты сливаются. */
async function fromDevice(def, dpValues) {
    let state = {};
    const published = [];
    const msg = {type: "commandDataReport", cluster: "manuSpecificTuya", data: {seq: 1, dpValues}, endpoint: zh.endpoints[0], device: zh, meta: {zclTransactionSequenceNumber: seq++}};
    for (const c of def.fromZigbee.filter((c) => c.cluster === msg.cluster && [c.type].flat().includes(msg.type))) {
        state = {...state, ...((await c.convert(def, msg, (p) => published.push(p), {}, {device: zh, state: {}})) ?? {})};
    }
    return state;
}

/** Как Publish (publish.ts): ищет конвертер по ключу и каналу, снимает имя канала с ключа, зовёт convertSet. */
async function toDevice(def, property, value) {
    const endpoints = def.endpoint ? Object.keys(def.endpoint(zh)) : [];
    const match = property.match(new RegExp(`^(.*?)_(${endpoints.join("|")})$`));
    const [key, endpointName] = endpoints.length && match ? [match[1], match[2]] : [property, undefined];
    const c = def.toZigbee.find((t) => (!t.key || t.key.includes(key)) && (!t.endpoints || (endpointName && t.endpoints.includes(endpointName))));
    assert.ok(c, `нет конвертера для ${property}`);
    const ep = zh.endpoints[0];
    ep.sent.length = 0;
    const result = await c.convertSet(ep, key, value, {message: {[key]: value}, mapped: def, endpoint_name: endpointName, options: {}, device: zh, state: {}});
    return {sent: ep.sent.map((s) => s.payload.dpValues[0]), state: result?.state};
}

const byModel = (defs) => Object.fromEntries(defs.map((d) => [d.model, zhc.prepareDefinition({...d, externalConverterName: "bms-models.mjs"})]));

test("нет bms-models.yaml — пустой список, без ошибок", async () => {
    const {definitions, log, errors} = await load(undefined);
    assert.deepEqual(definitions, []);
    assert.deepEqual(errors, []);
    assert.ok(log.some((l) => l.level === "info" && /bms-models\.yaml: файла нет/.test(l.msg)));
});

test("пример из bms-models.example.yaml собирается: штора, реле на 2 канала, датчик", async () => {
    const {definitions, errors} = await load(exampleUncommented());
    assert.deepEqual(errors, []);
    assert.deepEqual(definitions.map((d) => d.model), ["BMS-curtain-example", "BMS-relay2-example", "BMS-th-sensor-example"]);
    assert.deepEqual(definitions[0].fingerprint, [{modelID: "TS0601", manufacturerName: "_TZE200_xxxxxxxx"}]);
    // prepareDefinition с externalConverterName — та же проверка полей, что Z2M делает с внешним описанием.
    const defs = byModel(definitions);
    const exposed = (m) => defs[m].exposes.map((e) => (e.features ? `${e.type}:${e.features.map((f) => f.property).join("+")}` : e.property));
    assert.deepEqual(exposed("BMS-curtain-example"), ["cover:state+position"]);
    assert.deepEqual(exposed("BMS-relay2-example"), ["switch:state_l1", "switch:state_l2", "power_on_behavior"]);
    assert.deepEqual(exposed("BMS-th-sensor-example"), ["temperature", "humidity", "battery"]);
    assert.ok(defs["BMS-curtain-example"].options.some((o) => o.name === "time_start"), "у описания есть tuyaBase (опция time_start)");
});

test("точки примера: разбор отчётов и команды", async () => {
    const defs = byModel((await load(exampleUncommented())).definitions);
    const curtain = defs["BMS-curtain-example"];
    // invert: мотор шлёт 30 — значит открыта на 70 %.
    assert.deepEqual(await fromDevice(curtain, [dpv(3, 2, [0, 0, 0, 30]), dpv(1, 4, [2])]), {position: 70, state: "CLOSE"});
    assert.deepEqual((await toDevice(curtain, "position", 30)).sent, [{dp: 2, datatype: 2, data: Buffer.from([0, 0, 0, 70])}]);
    assert.deepEqual((await toDevice(curtain, "state", "OPEN")).sent, [{dp: 1, datatype: 4, data: Buffer.from([0])}]);

    const relay = defs["BMS-relay2-example"];
    assert.deepEqual(await fromDevice(relay, [dpv(2, 1, [1]), dpv(1, 1, [0]), dpv(14, 4, [2])]), {state_l1: "OFF", state_l2: "ON", power_on_behavior: "previous"});
    assert.deepEqual(await toDevice(relay, "state_l2", "ON"), {sent: [{dp: 2, datatype: 1, data: Buffer.from([1])}], state: {state: "ON"}});

    const sensor = defs["BMS-th-sensor-example"];
    assert.deepEqual(await fromDevice(sensor, [dpv(1, 2, [0, 0, 0, 235]), dpv(2, 2, [0, 0, 0, 55]), dpv(4, 2, [0, 0, 0, 90])]), {
        temperature: 23.5,
        humidity: 55,
        battery: 90,
    });
});

test("штора по двум краям (закрыта = 100, открыта = 7) и прижим к 0…100", async () => {
    const yaml = `
- fingerprint: [{modelID: TS0601, manufacturerName: _TZE200_cal00001}]
  points:
    - {dp: 2, kind: cover_position, closed_raw: 100, open_raw: 7}
`;
    const {definitions, errors} = await load(yaml);
    assert.deepEqual(errors, []);
    const def = byModel(definitions)["TS0601__TZE200_cal00001"];
    const at = async (raw) => (await fromDevice(def, [dpv(2, 2, [0, 0, 0, raw])])).position;
    assert.deepEqual([await at(100), await at(7), await at(0), await at(54)], [0, 100, 100, 49]);
    assert.deepEqual((await toDevice(def, "position", 50)).sent, [{dp: 2, datatype: 2, data: Buffer.from([0, 0, 0, 54])}]);
});

test("ошибка в модели пропускает только её; остальные загружаются", async () => {
    const yaml = `
- fingerprint: [{modelID: TS0601, manufacturerName: _TZE200_good0001}]
  points: [{dp: 1, kind: switch}]
- fingerprint: [{modelID: TS0601, manufacturerName: _TZE200_bad00001}]
  points: [{dp: 1, kind: lamp}]
- fingerprint: [{modelID: TS0601, manufacturerName: _TZE200_bad00002}]
  model: опечатка
  points: [{dp: 1, kind: numeric, name: temperature, scal: 10}]
- fingerprint: [{modelID: TS0601, manufacturerName: _TZE200_good0001}]
  points: [{dp: 1, kind: switch}]
- fingerprint: [{modelID: TS0601, manufacturerName: _TZE200_bad00003}]
  points: [{dp: 1, kind: switch}, {dp: 2, kind: switch}]
- fingerprint: [{modelID: TS0601, manufacturerName: _TZE200_bad00004}]
  points: [{dp: 1, kind: enum, name: mode}]
- fingerprint: [{modelID: TS0601, manufacturerName: _TZE200_good0002}]
  points: [{dp: 7, kind: binary, name: contact, read_only: true}]
`;
    const {definitions, errors} = await load(yaml);
    assert.deepEqual(definitions.map((d) => d.model), ["TS0601__TZE200_good0001", "TS0601__TZE200_good0002"]);
    assert.equal(errors.length, 5, errors.join("\n"));
    assert.match(errors[0], /модель №2: .*kind — одно из/);
    assert.match(errors[1], /модель №3 \(опечатка\): .*поле «scal» не бывает у kind numeric/);
    assert.match(errors[2], /модель №4: отпечаток TS0601\/_TZE200_good0001 уже описан выше/);
    assert.match(errors[3], /модель №5: две записываемые точки отвечают за «state»/);
    assert.match(errors[4], /модель №6: .*у enum нужны values/);
});

test("битый YAML и не список — пусто, ошибка в журнале, без исключения", async () => {
    for (const yaml of ["- fingerprint: [unclosed", "fingerprint: {modelID: TS0601}"]) {
        const {definitions, errors} = await load(yaml);
        assert.deepEqual(definitions, []);
        assert.equal(errors.length, 1, errors.join("\n"));
    }
});
