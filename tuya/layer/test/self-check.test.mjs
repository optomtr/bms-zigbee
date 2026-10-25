// Проверки расширения bms-self-check на подставных устройствах: только чтение, только после новой версии,
// батарейные не опрашиваются, повтор не ответивших, итог — в MQTT и уведомлением Home Assistant.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fakeLogger, importLayer, makeDataDir} from "./stand.mjs";

const dir = makeDataDir();
const {default: SelfCheck, STATE_FILE, NOTIFICATION_ID, isCheckable, summaryText} = await importLayer(dir, "external_extensions", "bms-self-check.mjs");

const TIMING = {startDelay: 5, pause: 1, retryDelay: 5, slow: 50};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeDevice(name, {type = "Router", power = "Mains (single phase)", answers = [true], delay = 0, interviewed = true} = {}) {
    const calls = [];
    const endpoint = {
        ID: 1,
        supportsInputCluster: (c) => c === "genBasic",
        read: async (cluster, attrs) => {
            calls.push({cluster, attrs});
            await sleep(delay);
            const ok = answers[Math.min(calls.length - 1, answers.length - 1)];
            if (!ok) throw new Error("Timeout");
            return {zclVersion: 3};
        },
        // Любая команда, кроме чтения, — провал проверки «ничего не переключаем».
        command: () => assert.fail("самопроверка отправила команду"),
        write: () => assert.fail("самопроверка что-то записала"),
    };
    return {name, ieeeAddr: `0x${name}`, options: {}, calls, zh: {type, powerSource: power, interviewCompleted: interviewed, ieeeAddr: `0x${name}`, endpoints: [endpoint]}};
}

function setup({devices, version = "2.14.2-bms.10", dataDir = makeDataDir()}) {
    const published = [];
    const notified = [];
    const handlers = [];
    const queued = [];
    const zigbee = {
        devicesIterator: function* () {
            yield* devices;
        },
        [Symbol.for("bms.commandQueue")]: {runDevice: (ieee, task) => (queued.push(ieee), task())},
    };
    const mqtt = {publish: async (topic, payload, options) => published.push({topic, payload: JSON.parse(payload), options})};
    const eventBus = {onMQTTMessage: (_, fn) => handlers.push(fn), removeListeners: () => {}};
    const settings = {get: () => ({mqtt: {base_topic: "zigbee2mqtt"}})};
    const logger = fakeLogger();
    const fetch = async (url, init) => (notified.push({url, body: JSON.parse(init.body), auth: init.headers.Authorization}), {ok: true, status: 200});
    const ext = new SelfCheck(zigbee, mqtt, {}, null, eventBus, null, null, null, settings, logger, {timing: TIMING, version, dataDir, token: "tok", fetch});
    const emit = (topic) => handlers.forEach((fn) => fn({topic, message: ""}));
    return {ext, published, notified, logger, queued, emit, dataDir};
}

async function until(cond, what, ms = 2000) {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) assert.fail(`не дождались: ${what}`);
        await sleep(2);
    }
}

test("кого проверяем: сеть — да; батарейки, координатор, без знакомства, отключённые — нет", () => {
    assert.equal(isCheckable(fakeDevice("lamp")), true);
    assert.equal(isCheckable(fakeDevice("relay", {type: "EndDevice", power: "Mains (single phase)"})), true);
    assert.equal(isCheckable(fakeDevice("sensor", {type: "EndDevice", power: "Battery"})), false);
    assert.equal(isCheckable(fakeDevice("unknown-end", {type: "EndDevice", power: "Unknown"})), false);
    assert.equal(isCheckable(fakeDevice("coord", {type: "Coordinator"})), false);
    assert.equal(isCheckable(fakeDevice("new", {interviewed: false})), false);
    assert.equal(isCheckable({...fakeDevice("off"), options: {disabled: true}}), false);
});

test("новая версия: опрос только чтением, итог в MQTT и уведомлении, версия запомнена", async () => {
    const devices = [fakeDevice("lamp1"), fakeDevice("lamp2"), fakeDevice("battery", {type: "EndDevice", power: "Battery"})];
    const s = setup({devices});
    await s.ext.start();
    await until(() => s.notified.length === 1, "уведомление");
    assert.deepEqual(devices[2].calls, [], "батарейное устройство не опрашивается");
    assert.deepEqual(devices[0].calls, [{cluster: "genBasic", attrs: ["zclVersion"]}]);
    assert.deepEqual(s.queued, ["0xlamp1", "0xlamp2"], "чтение идёт через общую очередь устройства");
    const n = s.notified[0];
    assert.equal(n.body.notification_id, NOTIFICATION_ID);
    assert.equal(n.auth, "Bearer tok");
    assert.match(n.body.title, /в порядке/);
    assert.match(n.body.message, /ответили 2 из 2/);
    assert.match(n.body.message, /не включался и не выключался/);
    const mq = s.published.find((p) => p.topic === "bms/self_check");
    assert.equal(mq.options.clientOptions.retain, true);
    assert.equal(mq.payload.ok, 2);
    const saved = JSON.parse(fs.readFileSync(path.join(s.dataDir, STATE_FILE), "utf8"));
    assert.equal(saved.checkedVersion, "2.14.2-bms.10");
    await s.ext.stop();
});

test("та же версия после перезапуска — проверки нет (дом не трогаем при каждом запуске)", async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, STATE_FILE), JSON.stringify({checkedVersion: "2.14.2-bms.10"}));
    const devices = [fakeDevice("lamp")];
    const s = setup({devices, dataDir});
    await s.ext.start();
    await sleep(40);
    assert.deepEqual(devices[0].calls, []);
    assert.equal(s.notified.length, 0);
    await s.ext.stop();
});

test("не ответившее со второго раза — в «ответили со второго раза», не в «не ответили»", async () => {
    const devices = [fakeDevice("lamp"), fakeDevice("far", {answers: [false, true]}), fakeDevice("dead", {answers: [false]})];
    const s = setup({devices});
    await s.ext.start();
    await until(() => s.notified.length === 1, "уведомление");
    const {body} = s.notified[0];
    assert.match(body.title, /не все/);
    assert.match(body.message, /ответили 2 из 3/);
    assert.match(body.message, /Не ответили: dead/);
    assert.match(body.message, /со второго раза: far/);
    assert.equal(devices[1].calls.length, 2);
    assert.ok(s.logger.lines.some((l) => l.level === "warning" && /Не ответили: dead/.test(l.msg)));
    await s.ext.stop();
});

test("медленные ответы отмечены отдельно", async () => {
    const devices = [fakeDevice("quick"), fakeDevice("slow", {delay: 80})];
    const s = setup({devices});
    await s.ext.start();
    await until(() => s.notified.length === 1, "уведомление");
    assert.match(s.notified[0].body.message, /медленно .*: slow/);
    await s.ext.stop();
});

test("вручную по MQTT bms/self_check/run — и без версии дополнения", async () => {
    const devices = [fakeDevice("lamp")];
    const s = setup({devices, version: ""});
    s.ext.opts.version = undefined;
    const prev = process.env.BMS_ADDON_VERSION;
    delete process.env.BMS_ADDON_VERSION;
    await s.ext.start();
    await sleep(30);
    assert.equal(devices[0].calls.length, 0, "без версии само не запускается");
    s.emit("zigbee2mqtt/bms/self_check/run");
    await until(() => s.notified.length === 1, "уведомление по запросу");
    assert.match(s.notified[0].body.message, /^ответили 1 из 1/);
    assert.equal(fs.existsSync(path.join(s.dataDir, STATE_FILE)), false, "ручной запуск без версии ничего не запоминает");
    if (prev !== undefined) process.env.BMS_ADDON_VERSION = prev;
    await s.ext.stop();
});

test("остановка Z2M во время ожидания повтора — сразу, без уведомления", async () => {
    const devices = [fakeDevice("dead", {answers: [false]})];
    const s = setup({devices});
    s.ext.timing.retryDelay = 60_000;
    await s.ext.start();
    await until(() => devices[0].calls.length === 1, "первое чтение");
    const t = Date.now();
    await s.ext.stop();
    await sleep(10);
    assert.ok(Date.now() - t < 1000);
    assert.equal(s.notified.length, 0);
});

test("текст: нет устройств", () => {
    assert.match(summaryText({version: "x", total: 0, ok: 0, failed: [], slow: [], retried: []}), /проверять нечего/);
});
