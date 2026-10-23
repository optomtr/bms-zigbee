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

/** groups — группы базы zigbee-herdsman ({groupID, members: [endpoint]}); groupsIterator — как lib/zigbee.ts:400. */
async function start(devices = [], groups = []) {
    const bus = fakeBus();
    const log = fakeLogger();
    const published = [];
    const byName = new Map(devices.map((d) => [d.name, d]));
    const zigbee = {
        resolveEntity: (name) => byName.get(name),
        firstCoordinatorEndpoint: () => ({ID: 1}),
        *groupsIterator(predicate = () => true) {
            yield* groups.filter(predicate);
        },
    };
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

// Контроллер света, как TS0502B: серверный genGroups на endpoint 1 и 2, у 242 (Green Power) его нет.
const LIGHT = [
    {ID: 1, input: ["genBasic", "genIdentify", "genGroups", "genScenes", "genOnOff", "genLevelCtrl", "lightingColorCtrl"], output: ["genOta", "genTime"]},
    {ID: 2, input: ["genGroups", "genOnOff"]},
    {ID: 242, output: ["greenPower"]},
];
const light = (manufacturerName = "_TZ3210_bmslight", options = {}) => z2mDevice(manufacturerName, {modelID: "TS0502B", type: "Router", endpoints: LIGHT, ...options});
const removeAllOn = (dev) => dev.zh.endpoints.filter((e) => e.sent.some((s) => s.cluster === "genGroups" && s.command === "removeAll")).map((e) => e.ID);

test("таблица групп: новое устройство Tuya без групп — removeAll на каждом endpoint с серверным genGroups", async () => {
    const dev = await light();
    const {bus, log} = await start([dev]);
    await bus.h.deviceInterview({device: dev, status: "successful"});
    assert.deepEqual(removeAllOn(dev), [1, 2]);
    const line = log.lines.find((l) => l.level === "info" && l.msg.startsWith("BMS: "));
    assert.match(line?.msg ?? "", new RegExp(`очищена таблица групп на '${dev.name}' \\(endpoint 1, 2\\)`));
    // Только после интервью: повторное подключение и неудачное интервью не чистят.
    const again = await light("_TYZB01_bmslight");
    const {bus: bus2} = await start([again]);
    await bus2.h.deviceAnnounce({device: again});
    await bus2.h.deviceInterview({device: again, status: "failed"});
    await bus2.h.deviceInterview({device: again, status: "started"});
    assert.deepEqual(removeAllOn(again), []);
    await bus2.h.deviceInterview({device: again, status: "successful"});
    assert.deepEqual(removeAllOn(again), [1, 2], "_TY… — тоже Tuya");
});

test("таблица групп: устройство уже в группе Z2M (на любом endpoint) — ничего", async () => {
    const dev = await light();
    const {bus, log} = await start([dev], [{groupID: 7, members: [dev.zh.endpoints[1]]}]);
    await bus.h.deviceInterview({device: dev, status: "successful"});
    assert.deepEqual(removeAllOn(dev), []);
    assert.ok(log.lines.some((l) => l.level === "debug" && /уже в группе Z2M/.test(l.msg)));
});

test("таблица групп: не-Tuya, без серверного genGroups, пульт с клиентским genOnOff — ничего", async () => {
    // Описание задаём сами: поиск converters для подставной лампы здесь не нужен (чистка от описания не зависит).
    const notTuya = await light("IKEA of Sweden", {modelID: "TRADFRI bulb", definition: {model: "TRADFRI", vendor: "IKEA", fromZigbee: [], toZigbee: []}});
    const noGroups = await z2mDevice("_TZE200_bmsnogrp", {endpoints: [{ID: 1, input: ["genBasic", "manuSpecificTuya"], output: ["genGroups"]}]});
    const remote = await z2mDevice("_TZ3000_bmsremot", {
        modelID: "TS004F",
        endpoints: [{ID: 1, input: ["genBasic", "genPowerCfg", "genIdentify", "genGroups", "genOnOff"], output: ["genGroups", "genScenes", "genOnOff", "genLevelCtrl"]}],
    });
    const {bus, log} = await start([notTuya, noGroups, remote]);
    for (const device of [notTuya, noGroups, remote]) await bus.h.deviceInterview({device, status: "successful"});
    assert.deepEqual([notTuya, noGroups, remote].flatMap(removeAllOn), []);
    assert.equal(log.lines.filter((l) => l.msg.startsWith("BMS: ")).length, 0);
});

test("таблица групп: ошибка команды — строка в журнале, остальные endpoint чистятся, без исключения", async () => {
    const dev = await light();
    dev.zh.endpoints[0].failOn = "removeAll";
    const {bus, log} = await start([dev]);
    await bus.h.deviceInterview({device: dev, status: "successful"}); // не бросает
    assert.deepEqual(removeAllOn(dev), [2]);
    assert.ok(log.lines.some((l) => l.level === "warning" && /^BMS: таблицу групп на .*endpoint 1\) очистить не удалось: Timeout/.test(l.msg)));
    assert.ok(log.lines.some((l) => l.level === "info" && /endpoint 2\)/.test(l.msg)));
});

test("служебные возможности: чужие обработчики никогда не исполняются на пробном устройстве", async () => {
    let calls = 0;
    const converter = {cluster: "manuSpecificTuya", type: ["commandMcuSyncTime"], convert() { calls++; throw new Error("только реальное сообщение"); }};
    const definition = {fromZigbee: [converter]};
    assert.equal(definitionAnswers(definition, "commandMcuSyncTime", {}), true);
    assert.equal(calls, 0);
    definition.meta = {bmsTuyaServices: {commandMcuSyncTime: "fallback"}};
    assert.equal(definitionAnswers(definition, "commandMcuSyncTime", {}), false);
    assert.equal(calls, 0);
});

test("служебные возможности: forceTimeUpdates — только реальный обработчик, одно сообщение в эфир", async () => {
    const definition = zhc.prepareDefinition({model: "force", vendor: "test", description: "test", extend: [tuya.modernExtend.tuyaBase({forceTimeUpdates: true, timeStart: "1970"})]});
    const dev = await z2mDevice("_TZE200_bmsforce", {definition});
    const {bus} = await start([dev]);
    for (let i = 0; i < 5; i++) assert.equal(definitionAnswers(definition, "commandMcuGatewayConnectionStatus", {}), true);
    assert.equal(dev.zh.endpoints[0].sent.length, 0);
    const sent = await deliver(bus, dev, "commandMcuGatewayConnectionStatus", {payloadSize: 0});
    assert.equal(sent.length, 1);
    assert.equal(sent[0].command, "mcuSyncTime");
    await deliver(bus, dev, "commandMcuGatewayConnectionStatus", {payloadSize: 0});
    assert.equal(sent.length, 2);
    assert.equal(sent[1].command, "mcuGatewayConnectionStatus");
});

test("A5: cleanup двух каналов и конкурентный add второго канала сериализуются по IEEE", async () => {
    const dev = await light();
    const groups = [];
    const {service} = await start([dev], groups);
    const e1 = dev.zh.endpoints[0];
    const e2 = dev.zh.endpoints[1];
    const order = [];
    let release;
    const paused = new Promise((resolve) => { release = resolve; });
    let started;
    const first = new Promise((resolve) => { started = resolve; });
    const original1 = e1.command.bind(e1);
    e1.command = async (...args) => {
        if (args[1] === "removeAll") {
            order.push("removeAll1");
            started();
            await paused;
        }
        return original1(...args);
    };
    const original2 = e2.command.bind(e2);
    e2.command = async (...args) => {
        if (["removeAll", "add"].includes(args[1])) order.push(`${args[1]}2`);
        return original2(...args);
    };
    const cleanup = service.clearForeignGroups(dev);
    await first;
    const addition = service.membership.withDeviceLock(dev.ieeeAddr, async () => {
        service.membership.invalidate(dev.ieeeAddr, 2);
        await e2.command("genGroups", "add", {groupid: 1000});
        groups.push({groupID: 1000, members: [e2]});
        await service.membership.verify(e2);
    });
    release();
    await Promise.all([cleanup, addition]);
    assert.deepEqual(order, ["removeAll1", "removeAll2", "add2"]);
    assert.equal(e2.hardwareGroups.has(1000), true);
    assert.equal(service.membership.isVerified(groups[0]), true);
    // Проверка членства должна происходить внутри очереди, а не перед ожиданием add.
    await service.clearForeignGroups(dev);
    assert.deepEqual(order, ["removeAll1", "removeAll2", "add2"]);
});

test("cleanup: непроверенное removeAll не помечается успешным", async () => {
    const dev = await light();
    const {service, log} = await start([dev]);
    const endpoint = dev.zh.endpoints[0];
    endpoint.hardwareGroups.add(7);
    const original = endpoint.command.bind(endpoint);
    endpoint.command = async (...args) => args[1] === "removeAll" ? undefined : original(...args);
    await service.clearForeignGroups(dev);
    assert.ok(log.lines.some((l) => /устройство сохранило группы/.test(l.msg)));
    // Проверка вернула старую физическую группу. Это правда, но очищенным endpoint не считается.
    assert.ok(endpoint.hardwareGroups.has(7));
});
