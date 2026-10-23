import assert from "node:assert/strict";
import test from "node:test";
import {groupMembership, MEMBERSHIP} from "../external_extensions/bms-lib/group-membership.mjs";

const endpoint = (ieee, ID, groupIDs) => ({
    deviceIeeeAddress: ieee, ID,
    async command(cluster, command, payload, options) {
        assert.equal(cluster, "genGroups");
        assert.equal(command, "getMembership");
        assert.deepEqual(payload, {groupcount: 0, grouplist: []});
        assert.equal(options.timeout, 10_000);
        return {groupcount: groupIDs.length, grouplist: groupIDs};
    },
});

test("общий runtime: разные временные копии externalJS используют состояние Zigbee", async () => {
    const otherCopy = await import(`../external_extensions/bms-lib/group-membership.mjs?copy=${Date.now()}`);
    const zigbee = {};
    const a = groupMembership(zigbee);
    const b = otherCopy.groupMembership(zigbee);
    assert.equal(a, b);
    assert.equal(zigbee[MEMBERSHIP], a);
    const e1 = endpoint("dev", 1, [1000]);
    const e2 = endpoint("dev", 2, [1000]);
    const group = {ID: 1000, zh: {members: [e1, e2]}};
    assert.equal(a.isVerified(group), false);
    await a.verify(e1);
    assert.equal(a.isVerified(group), false);
    await b.verify(e2);
    assert.equal(a.isVerified(group), true);
    b.invalidate("dev", 2);
    assert.equal(a.isVerified(group), false);
});

test("очередь IEEE: отказ не блокирует следующий вызов и не останавливает другое устройство", async () => {
    const state = groupMembership({});
    const order = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = state.withDeviceLock("dev1", async () => { order.push("first"); await gate; throw new Error("failure"); });
    const failure = assert.rejects(first, /failure/);
    const second = state.withDeviceLock("dev1", async () => { order.push("second"); });
    await state.withDeviceLock("dev2", async () => { order.push("parallel"); });
    assert.deepEqual(order, ["first", "parallel"]);
    release();
    await Promise.all([failure, second]);
    assert.deepEqual(order, ["first", "parallel", "second"]);
});

test("ошибка/неполный ответ не подтверждают членство; announce во время запроса делает ответ устаревшим", async () => {
    const state = groupMembership({});
    const e = endpoint("dev", 1, [1000]);
    const group = {ID: 1000, zh: {members: [e]}};
    await state.verify(e);
    assert.equal(state.isVerified(group), true);
    e.command = async () => ({groupcount: 2, grouplist: [1000]});
    await assert.rejects(state.verify(e), /Некорректный/);
    assert.equal(state.isVerified(group), false);
    let answer;
    e.command = () => new Promise((resolve) => { answer = resolve; });
    const query = state.verify(e);
    state.invalidate("dev");
    answer({groupcount: 1, grouplist: [1000]});
    await assert.rejects(query, /переподключилось/);
    assert.equal(state.isVerified(group), false);
});

test("планировщик видит смену эпохи до изменения базы и активную операцию до завершения readback", async () => {
    const state = groupMembership({});
    const e = endpoint("dev", 1, [1000]);
    const group = {ID: 1000, zh: {members: [e]}};
    await state.verify(e);
    const epoch = state.getEpoch("dev");
    assert.equal(state.isChanging("dev"), false);
    let started, release;
    const entered = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const mutation = state.withDeviceLock("dev", async () => {
        state.invalidate("dev", 1);
        started();
        await gate;
        await state.verify(e);
        // Даже после readback блокировка ещё не отпущена: конкурентный publish ждёт.
        assert.equal(state.isChanging("dev"), true);
    });
    await entered;
    assert.ok(state.getEpoch("dev") > epoch);
    assert.equal(state.isChanging("dev"), true);
    assert.equal(state.isChanging("other"), false);
    assert.equal(state.isVerified(group), false);
    release();
    await mutation;
    assert.equal(state.isChanging("dev"), false);
    assert.equal(state.isVerified(group), true);
    await assert.rejects(state.withDeviceLock("dev", async () => { throw new Error("failure"); }), /failure/);
    assert.equal(state.isChanging("dev"), false);
});
