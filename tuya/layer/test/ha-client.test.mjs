// Таймауты проверяются без Home Assistant: сокеты намеренно молчат или отвечают с ошибкой.
import assert from "node:assert/strict";
import test from "node:test";
import {importLayer, makeDataDir} from "./stand.mjs";
const {HaClient, HA_EVENTS} = await importLayer(makeDataDir(), "external_extensions", "bms-area-groups.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
    const end = Date.now() + 1000;
    while (!fn()) {
        assert.ok(Date.now() < end, "таймаут теста");
        await sleep(2);
    }
}
function setup(t, handler = () => {}) {
    const sockets = [];
    const down = [];
    let ready = 0;
    let events = 0;
    class WS {
        constructor() { this.listeners = {}; this.sent = []; sockets.push(this); }
        addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
        emit(name, data) { for (const fn of this.listeners[name] ?? []) fn(data); }
        receive(msg) { this.emit("message", {data: JSON.stringify(msg)}); }
        send(raw) { const msg = JSON.parse(raw); this.sent.push(msg); handler(this, msg); }
        close() { this.closed = true; this.emit("close", {code: 1000}); }
    }
    const client = new HaClient({url: "ws://test", token: "test", WebSocket: WS, timing: {connect: 30, auth: 30, request: 30, reconnect: 5, reconnectMax: 10}, onReady: () => ready++, onEvent: () => events++, onDown: (r) => down.push(r)});
    t.after(() => client.close());
    client.connect();
    return {client, sockets, down, ready: () => ready, events: () => events};
}
const result = (ws, msg, success = true) => ws.receive({type: "result", id: msg.id, success, result: [], error: {message: "отказ подписки"}});

test("HA: молчащее подключение имеет дедлайн и переподключается один раз", async (t) => {
    const x = setup(t);
    await until(() => x.sockets.length === 2);
    assert.equal(x.sockets[0].closed, true);
    assert.equal(x.down.length, 1);
    assert.match(x.down[0], /подключения/);
});

test("HA: авторизация без auth_ok имеет отдельный дедлайн", async (t) => {
    const x = setup(t);
    x.sockets[0].emit("open", {});
    x.sockets[0].receive({type: "auth_required"});
    await until(() => x.sockets.length === 2);
    assert.match(x.down[0], /авторизации/);
    assert.equal(x.client.calls.size, 0);
});

test("A6: молчащий запрос отклоняется, остальные ожидания сняты, сокет заменён", async (t) => {
    const x = setup(t, (ws, msg) => { if (msg.type === "subscribe_events") result(ws, msg); });
    x.sockets[0].receive({type: "auth_ok"});
    await until(() => x.ready() === 1);
    const pending = [x.client.call("config/area_registry/list"), x.client.call("config/device_registry/list")];
    const results = await Promise.allSettled(pending);
    assert.ok(results.every((r) => r.status === "rejected" && /нет ответа/.test(r.reason.message)));
    assert.equal(x.client.calls.size, 0);
    await until(() => x.sockets.length === 2);
    assert.equal(x.down.length, 1);
    assert.equal(x.sockets[0].closed, true);
});

test("HA: частичная подписка с отказом — новая авторизация и все три подписки заново", async (t) => {
    let first = true;
    const x = setup(t, (ws, msg) => {
        if (msg.type !== "subscribe_events") return;
        if (first && msg.event_type === HA_EVENTS[1]) { first = false; result(ws, msg, false); }
        else result(ws, msg);
    });
    x.sockets[0].receive({type: "auth_ok"});
    await until(() => x.sockets.length === 2);
    assert.equal(x.ready(), 0);
    const next = x.sockets[1];
    next.receive({type: "auth_ok"});
    await until(() => x.ready() === 1);
    assert.deepEqual(next.sent.map((m) => m.event_type), HA_EVENTS);
    // Запоздалые события старого сокета не вызывают переподключение, sync и fatal.
    x.sockets[0].receive({type: "auth_invalid"});
    x.sockets[0].receive({type: "event", event: {event_type: HA_EVENTS[0]}});
    x.sockets[0].emit("close", {code: 1006});
    assert.equal(x.client.closed, false);
    assert.equal(x.client.ws, next);
    assert.equal(x.events(), 0);
});

test("HA: зависшая подписка тоже переподключается", async (t) => {
    const x = setup(t);
    x.sockets[0].receive({type: "auth_ok"});
    await until(() => x.sockets.length === 2);
    assert.equal(x.ready(), 0);
    assert.equal(x.client.calls.size, 0);
    assert.match(x.down[0], /subscribe_events/);
});

test("HA: ошибка send и stop очищают ожидания и не оставляют reconnect", async (t) => {
    const x = setup(t, (ws, msg) => {
        if (msg.type === "subscribe_events") result(ws, msg);
        else throw new Error("send failed");
    });
    x.sockets[0].receive({type: "auth_ok"});
    await until(() => x.ready() === 1);
    await assert.rejects(x.client.call("test"), /send failed/);
    assert.equal(x.client.calls.size, 0);
    x.client.close();
    await sleep(50);
    assert.equal(x.sockets.length, 1);
});
