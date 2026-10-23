// Проверки расширения bms-tuya-service на подставных устройствах, но с настоящими описаниями converters.
// «Двойной ответ» проверяется честно: перед нашим расширением сообщение проходит через конвертеры
// описания — так же, как это делает Receive в Z2M (lib/extension/receive.ts:113, :169).
import assert from "node:assert/strict";
import test from "node:test";
import {fakeBus, fakeLogger, importLayer, makeDataDir, dpv, tuya, z2mDevice, zhc} from "./stand.mjs";

const dir = makeDataDir();
const {default: Service, definitionAnswers, definitionSendsMagicPacket} = await importLayer(dir, "external_extensions", "bms-tuya-service.mjs");

const noop = async () => {};
const JAN_2000 = Date.UTC(2000, 0, 1);
let seq = 1;

async function start(devices = []) {
    const bus = fakeBus();
    const log = fakeLogger();
    const published = [];
    const byName = new Map(devices.map((d) => [d.name, d]));
    const zigbee = {resolveEntity: (name) => byName.get(name), firstCoordinatorEndpoint: () => ({ID: 1})};
    const settings = {get: () => ({mqtt: {base_topic: "zigbee2mqtt"}})};
    const service = new Service(zigbee, {}, {}, async (d, payload) => published.push({name: d.name, payload}), bus, noop, noop, noop, settings, log);
    await service.start();
    return {bus, log, published, service};
}

const message = (device, type, data = {}, cluster = "manuSpecificTuya") => ({
    type,
    device,
    endpoint: device.zh.endpoints[0],
    cluster,
    data,
    linkquality: 100,
    groupID: 0,
    meta: {zclTransactionSequenceNumber: seq++},
});

/** Сообщение проходит путь Z2M: конвертеры описания (Receive), затем наше расширение. */
async function deliver(bus, device, type, data) {
    const msg = message(device, type, data);
    for (const c of device.definition?.fromZigbee ?? []) {
        if (c.cluster === msg.cluster && [c.type].flat().includes(msg.type)) {
            await c.convert(device.definition, {...msg, device: device.zh}, noop, device.options, {device: device.zh, state: {}});
        }
    }
    await bus.h.deviceMessage(msg);
    return device.zh.endpoints[0].sent;
}

const commands = (sent, name) => sent.filter((s) => s.cluster === "manuSpecificTuya" && s.command === name);
const utcOf = (cmd) => Buffer.from(cmd.payload.payload.slice(0, 4)).readUInt32BE(0);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 5, `время ${actual}, ожидалось около ${expected}`);

test("неизвестная модель: ответы на время (1970) и статус шлюза — ровно по одному", async () => {
    const dev = await z2mDevice("_TZE200_bmsunk01");
    assert.equal(dev.definition.generated, true, "Z2M даёт неизвестному устройству сгенерированное описание");
    const {bus} = await start([dev]);
    const sent = await deliver(bus, dev, "commandMcuSyncTime", {payloadSize: 0});
    await deliver(bus, dev, "commandMcuGatewayConnectionStatus", {payloadSize: 0});
    const time = commands(sent, "mcuSyncTime");
    assert.equal(time.length, 1);
    assert.equal(time[0].payload.payloadSize, 8);
    near(utcOf(time[0]), Math.round(Date.now() / 1000));
    assert.deepEqual(commands(sent, "mcuGatewayConnectionStatus").map((c) => c.payload), [{payloadSize: 1, payload: 1}]);
});

test("описание converters с tuyaBase timeStart 2000 отвечает само — мы молчим (нет двойного ответа)", async () => {
    const dev = await z2mDevice("_TZE204_g2ki0ejr");
    assert.equal(dev.definition.model, "BAB-1413_Pro");
    const {bus} = await start([dev]);
    const sent = await deliver(bus, dev, "commandMcuSyncTime", {payloadSize: 0});
    await deliver(bus, dev, "commandMcuGatewayConnectionStatus", {payloadSize: 0});
    const time = commands(sent, "mcuSyncTime");
    assert.equal(time.length, 1, "один ответ — от описания");
    near(utcOf(time[0]), Math.round((Date.now() - JAN_2000) / 1000)); // отсчёт 2000 — значит, ответило описание
    assert.equal(commands(sent, "mcuGatewayConnectionStatus").length, 1);
});

test("tuyaBase по умолчанию (off): на время отвечаем мы (1970), на статус — описание", async () => {
    const dev = await z2mDevice("_TZE284_5qfrnbqs");
    assert.equal(dev.definition.model, "CTL-Mini-DTP-TYZ/AC");
    const {bus} = await start([dev]);
    const sent = await deliver(bus, dev, "commandMcuSyncTime", {payloadSize: 0});
    await deliver(bus, dev, "commandMcuGatewayConnectionStatus", {payloadSize: 0});
    const time = commands(sent, "mcuSyncTime");
    assert.equal(time.length, 1);
    near(utcOf(time[0]), Math.round(Date.now() / 1000));
    assert.equal(commands(sent, "mcuGatewayConnectionStatus").length, 1);
});

test("tuyaBase (off) вместе с ignore_tuya_set_time: описание на время молчит — отвечаем мы", async () => {
    const dev = await z2mDevice("_TZE200_d0yu2xgi");
    assert.equal(dev.definition.model, "NAS-AB02B0");
    const {bus} = await start([dev]);
    const sent = await deliver(bus, dev, "commandMcuSyncTime", {payloadSize: 0});
    assert.equal(commands(sent, "mcuSyncTime").length, 1);
});

test("опция устройства time_start: off — молчим, 2000 — отсчёт 2000, 1970 у tuyaBase — отвечает описание", async () => {
    const off = await z2mDevice("_TZE200_bmsunk02", {options: {time_start: "off"}});
    const y2k = await z2mDevice("_TZE200_bmsunk03", {options: {time_start: "2000"}});
    const base = await z2mDevice("_TZE284_5qfrnbqs", {options: {time_start: "1970"}});
    const {bus} = await start([off, y2k, base]);
    assert.equal(commands(await deliver(bus, off, "commandMcuSyncTime", {payloadSize: 0}), "mcuSyncTime").length, 0);
    const time = commands(await deliver(bus, y2k, "commandMcuSyncTime", {payloadSize: 0}), "mcuSyncTime");
    assert.equal(time.length, 1);
    near(utcOf(time[0]), Math.round((Date.now() - JAN_2000) / 1000));
    assert.equal(commands(await deliver(bus, base, "commandMcuSyncTime", {payloadSize: 0}), "mcuSyncTime").length, 1);
});

test("_TYST11_ (EF00 без _TZ): ответы, dp_<номер>, магический пакет и bms_dp — как у _TZ", async () => {
    const dev = await z2mDevice("_TYST11_bmstest", {modelID: "bmstest"});
    assert.equal(dev.isSupported, false);
    const {bus, published} = await start([dev]);
    const sent = await deliver(bus, dev, "commandMcuSyncTime", {payloadSize: 0});
    await deliver(bus, dev, "commandMcuGatewayConnectionStatus", {payloadSize: 0});
    assert.equal(commands(sent, "mcuSyncTime").length, 1);
    assert.equal(commands(sent, "mcuGatewayConnectionStatus").length, 1);
    await bus.h.deviceMessage(message(dev, "commandDataReport", {seq: 1, dpValues: [dpv(1, 1, [1])]}));
    assert.deepEqual(published, [{name: dev.name, payload: {dp_1: {type: "bool", value: true}}}]);
    await bus.h.deviceInterview({device: dev, status: "successful"});
    assert.equal(dev.zh.endpoints[0].reads.length, 1, "магический пакет");
    await bus.h.mqttMessage({topic: `zigbee2mqtt/${dev.name}/set`, message: JSON.stringify({bms_dp: {dp: 1, type: "bool", value: false}})});
    assert.equal(commands(sent, "dataRequest").length, 1, "bms_dp");
});

test("EF00 от устройства с любым производителем — служебные ответы по самому сообщению", async () => {
    const dev = await z2mDevice("ACME", {modelID: "acme.ef00"});
    const {bus} = await start([dev]);
    const sent = await deliver(bus, dev, "commandMcuSyncTime", {payloadSize: 0});
    assert.equal(commands(sent, "mcuSyncTime").length, 1);
    // Но без сообщения (интервью, bms_dp) признак — производитель, а он не _TZ/_TY: ничего не шлём.
    await bus.h.deviceInterview({device: dev, status: "successful"});
    await bus.h.mqttMessage({topic: `zigbee2mqtt/${dev.name}/set`, message: JSON.stringify({bms_dp: {dp: 1, type: "bool", value: true}})});
    assert.equal(dev.zh.endpoints[0].reads.length, 0);
    assert.equal(commands(sent, "dataRequest").length, 0);
});

test("обычное не-Tuya устройство — ничего не делаем", async () => {
    const dev = await z2mDevice("LUMI", {modelID: "lumi.weather"});
    const {bus, published, log} = await start([dev]);
    await bus.h.deviceMessage(message(dev, "attributeReport", {measuredValue: 2350}, "msTemperatureMeasurement"));
    await bus.h.deviceMessage(message(dev, "read", ["time"], "genTime"));
    await bus.h.deviceInterview({device: dev, status: "successful"});
    await bus.h.deviceAnnounce({device: dev});
    await bus.h.mqttMessage({topic: `zigbee2mqtt/${dev.name}/set`, message: JSON.stringify({bms_dp: {dp: 1, type: "bool", value: true}})});
    assert.deepEqual(dev.zh.endpoints[0].sent, []);
    assert.deepEqual(dev.zh.endpoints[0].reads, []);
    assert.deepEqual(published, []);
    assert.match(log.lines.find((l) => l.level === "error")?.msg ?? "", /не устройство Tuya/);
});

test("definitionAnswers: tuyaBase с forceTimeUpdates на статус шлёт время — считаем, что отвечает описание", async () => {
    const def = zhc.prepareDefinition({
        model: "t",
        vendor: "t",
        description: "t",
        extend: [tuya.modernExtend.tuyaBase({forceTimeUpdates: true, timeStart: "1970"})],
    });
    assert.equal(await definitionAnswers(def, "commandMcuGatewayConnectionStatus", {}), true);
    assert.equal(await definitionAnswers(undefined, "commandMcuSyncTime", {}), false);
});

test("сырые точки неописанного устройства → dp_<номер> с типом; повтор того же кадра не публикуется", async () => {
    const dev = await z2mDevice("_TZE200_bmsunk04");
    const known = await z2mDevice("_TZE204_g2ki0ejr");
    const {bus, published} = await start([dev, known]);
    const dpValues = [
        dpv(1, 1, [1]),
        dpv(2, 2, [0xff, 0xff, 0xff, 0xfe]),
        dpv(3, 4, [2]),
        dpv(4, 3, [0x61, 0x62]),
        dpv(5, 0, [0x0a, 0xff]),
        dpv(6, 5, [0x05]),
    ];
    const msg = message(dev, "commandDataReport", {seq: 7, dpValues});
    await bus.h.deviceMessage(msg);
    await bus.h.deviceMessage(msg); // Tuya часто шлёт кадр дважды; converters отбрасывают повтор по номеру ZCL
    await bus.h.deviceMessage(message(known, "commandDataReport", {seq: 8, dpValues}));
    assert.deepEqual(published, [
        {
            name: dev.name,
            payload: {
                dp_1: {type: "bool", value: true},
                dp_2: {type: "value", value: -2},
                dp_3: {type: "enum", value: 2},
                dp_4: {type: "string", value: "ab"},
                dp_5: {type: "raw", value: "0aff"},
                dp_6: {type: "bitmap", value: 5},
            },
        },
    ]);
});

test("bms_dp: каждый тип уходит dataRequest с кодировкой converters", async () => {
    const dev = await z2mDevice("_TZE200_bmsunk05");
    const {bus, log} = await start([dev]);
    const cases = [
        [{dp: 1, type: "bool", value: true}, 1, [1]],
        [{dp: 2, type: "value", value: -2}, 2, [0xff, 0xff, 0xff, 0xfe]],
        [{dp: 3, type: "enum", value: 3}, 4, [3]],
        [{dp: 4, type: "bitmap", value: 5}, 5, [5]],
        [{dp: 5, type: "string", value: "ab"}, 3, [0x61, 0x62]],
        [{dp: 6, type: "raw", value: "0a0B"}, 0, [0x0a, 0x0b]],
    ];
    for (const [cmd] of cases) await bus.h.mqttMessage({topic: `zigbee2mqtt/${dev.name}/set`, message: JSON.stringify({bms_dp: cmd})});
    const sent = commands(dev.zh.endpoints[0].sent, "dataRequest");
    assert.equal(sent.length, cases.length, JSON.stringify(log.lines));
    sent.forEach((s, i) => {
        const [cmd, datatype, bytes] = cases[i];
        assert.deepEqual(s.payload.dpValues, [{dp: cmd.dp, datatype, data: Buffer.from(bytes)}]);
    });
});

test("bms_dp: ошибки не отправляются и называются в журнале", async () => {
    const dev = await z2mDevice("_TZE200_bmsunk06");
    const known = await z2mDevice("_TZE204_g2ki0ejr");
    const {bus, log} = await start([dev, known]);
    const send = (name, bms_dp) => bus.h.mqttMessage({topic: `zigbee2mqtt/${name}/set`, message: JSON.stringify({bms_dp})});
    await send(dev.name, {dp: 0, type: "bool", value: true});
    await send(dev.name, {dp: 1, type: "number", value: 1});
    await send(dev.name, {dp: 1, type: "enum", value: 300});
    await send(dev.name, {dp: 1, type: "raw", value: "abc"});
    await send(known.name, {dp: 1, type: "bool", value: true});
    await send("нет-такого", {dp: 1, type: "bool", value: true});
    await bus.h.mqttMessage({topic: `zigbee2mqtt/${dev.name}/get`, message: JSON.stringify({bms_dp: {dp: 1, type: "bool", value: true}})});
    assert.equal(dev.zh.endpoints[0].sent.length + known.zh.endpoints[0].sent.length, 0);
    const errors = log.lines.filter((l) => l.level === "error").map((l) => l.msg);
    assert.equal(errors.length, 6, errors.join("\n"));
    assert.match(errors[0], /dp — целое/);
    assert.match(errors[1], /type — одно из/);
    assert.match(errors[2], /не подходит к типу enum/);
    assert.match(errors[4], /есть описание модели/);
});

test("магический пакет: шлём, только если описание не шлёт его само", async () => {
    const unknown = await z2mDevice("_TZE200_bmsunk07");
    const viaTuyaBase = await z2mDevice("_TZE204_g2ki0ejr");
    const viaClosure = await z2mDevice("_TZ3000_hktqahrq", {modelID: "TS000F"});
    const noConfigure = await z2mDevice("_TZE200_8daqwrsj");
    assert.equal(viaClosure.definition.model, "WHD02");
    assert.equal(noConfigure.definition.model, "SMART-HEAT10");
    assert.equal(await definitionSendsMagicPacket(viaTuyaBase.zh), true);
    assert.equal(await definitionSendsMagicPacket(viaClosure.zh), true);
    assert.equal(await definitionSendsMagicPacket(noConfigure.zh), false);
    assert.equal(await definitionSendsMagicPacket(unknown.zh), false);

    const {bus} = await start([unknown, viaTuyaBase, viaClosure, noConfigure]);
    for (const device of [unknown, viaTuyaBase, viaClosure, noConfigure]) await bus.h.deviceInterview({device, status: "successful"});
    const magic = {cluster: "genBasic", attributes: ["manufacturerName", "zclVersion", "appVersion", "modelId", "powerSource", 0xfffe]};
    assert.deepEqual(unknown.zh.endpoints[0].reads, [magic]);
    assert.deepEqual(noConfigure.zh.endpoints[0].reads, [magic]);
    assert.equal(viaTuyaBase.zh.endpoints[0].reads.length + viaClosure.zh.endpoints[0].reads.length, 0);

    // Повторное подключение известного устройства — ещё раз; неопрошенное и неудачное интервью — нет.
    await bus.h.deviceAnnounce({device: unknown});
    assert.equal(unknown.zh.endpoints[0].reads.length, 2);
    const fresh = await z2mDevice("_TZE200_bmsunk08");
    fresh.interviewed = false;
    await bus.h.deviceAnnounce({device: fresh});
    await bus.h.deviceInterview({device: fresh, status: "failed"});
    assert.equal(fresh.zh.endpoints[0].reads.length, 0);
});
