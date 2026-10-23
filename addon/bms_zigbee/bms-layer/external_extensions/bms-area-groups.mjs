// BMS: группы Zigbee по комнатам (областям) Home Assistant — как у хаба Tuya, где комната включается
// одной групповой командой, а не командой каждой лампе по очереди.
//
// Что делает: для каждой области HA, где не меньше двух устройств Z2M с серверным genGroups (лампы, реле),
// держит группу Z2M «Комната · <область>» с id из своего диапазона (1000–1999) и приводит её состав к области.
// Чужие группы (вне диапазона или без приставки) не трогает никогда.
//
// Почему через запросы bridge (eventBus.emitMQTTMessage): так группа создаётся, меняется и удаляется ровно тем же
// кодом Z2M, что и из интерфейса или MQTT (lib/extension/bridge.ts: groupAdd/groupRename/removeEntity,
// lib/extension/groups.ts: members add/remove) — база, configuration.yaml, bridge/groups и discovery в HA
// обновляются штатно. Ответ ловим по transaction в bridge/response/… (mqtt.ts:235 — emitMQTTMessagePublished
// идёт всегда, даже без связи с брокером).
//
// Откуда области: WebSocket API Home Assistant через Supervisor (ws://supervisor/core/websocket, токен
// SUPERVISOR_TOKEN, в config.yaml дополнения — homeassistant_api: true). Реестры областей/устройств/сущностей
// есть только в WebSocket API (config/*_registry/list), REST их не отдаёт.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const NS = "bms:area-groups";
export const PREFIX = "Комната · ";
export const ID_MIN = 1000;
export const ID_MAX = 1999;
export const MAP_FILE = "bms-area-groups.json";
export const HA_EVENTS = ["area_registry_updated", "device_registry_updated", "entity_registry_updated"];
export const DEFAULT_URL = "ws://supervisor/core/websocket";

// Сроки (мс). startDelay — после старта Z2M даём сети и discovery успокоиться; debounce — склейка событий
// реестров (переименование области в HA даёт пачку событий); pause — между командами в эфир: пачка
// genGroups.add на живой сети забивала эфир и ловила таймауты; reply — ждём ответа bridge (add к спящему/
// дальнему устройству идёт с повторами zigbee-herdsman); retry — повтор после неудачи, растёт до retryMax.
export const TIMING = {startDelay: 30_000, debounce: 10_000, pause: 1500, reply: 90_000, retry: 120_000, retryMax: 1_800_000, reconnect: 10_000, reconnectMax: 300_000};

export const groupName = (areaName) =>
    // Z2M не пускает в имя «#», «+» (шаблоны MQTT) и «/цифры» в конце (utils.ts: validateFriendlyName).
    PREFIX + String(areaName).replace(/[#+/]/g, "-").replace(/[\u0000-\u001f\u007f]/g, "").trim();
export const isOwnGroup = (id, name) => Number.isInteger(id) && id >= ID_MIN && id <= ID_MAX && typeof name === "string" && name.startsWith(PREFIX);

const memberKey = (ieee, endpointID) => `${ieee}/${endpointID}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Какие группы нужны: область → {name, members: Map(«ieee/endpoint» → {ieee, endpointID, deviceName})}.
 * Связь устройства Z2M с устройством HA — идентификатор discovery `zigbee2mqtt_<ieee>` (homeassistant.ts:
 * getDevicePayload), домен «mqtt» (HA mqtt/entity.py: identifiers={(DOMAIN, id)}).
 * Область берём у сущности светильника/выключателя, а если у неё своей нет — у устройства (так считает и HA).
 * Сущность → endpoint: unique_id Z2M = `<ieee>_<object_id>_<base_topic>`, object_id = light|switch[_<endpoint>]
 * (homeassistant.ts:647, :709). Так у двухканального реле каналы могут жить в разных комнатах.
 */
export function desiredAreas({areas, devices, entities}, z2mDevices, baseTopic) {
    const byIdentifier = new Map(z2mDevices.map((d) => [`zigbee2mqtt_${d.ieeeAddr}`, d]));
    const haToZ2m = new Map();
    for (const hd of devices) {
        const id = (hd.identifiers ?? []).find(([domain, value]) => domain === "mqtt" && byIdentifier.has(value));
        if (id && !hd.disabled_by) haToZ2m.set(hd.id, {ha: hd, z2m: byIdentifier.get(id[1])});
    }
    const areaName = new Map(areas.map((a) => [a.area_id, a.name]));
    const out = new Map();
    for (const e of entities) {
        const link = haToZ2m.get(e.device_id);
        if (!link || e.platform !== "mqtt" || e.disabled_by || e.entity_category) continue;
        const domain = String(e.entity_id).split(".")[0];
        if (domain !== "light" && domain !== "switch") continue;
        const {z2m} = link;
        const m = String(e.unique_id ?? "").match(new RegExp(`^${escapeRe(z2m.ieeeAddr)}_(light|switch)(?:_(.+))?_${escapeRe(baseTopic)}$`));
        if (!m) continue;
        const areaId = e.area_id ?? link.ha.area_id;
        if (!areaId || !areaName.has(areaId)) continue;
        // «switch_<свойство>» (например switch_do_not_disturb) не канал: endpoint с таким именем не найдётся.
        const endpoint = z2m.endpoint(m[2]);
        if (!endpoint?.supportsInputCluster?.("genGroups")) continue;
        if (!out.has(areaId)) out.set(areaId, {areaId, name: groupName(areaName.get(areaId)), members: new Map()});
        out.get(areaId).members.set(memberKey(z2m.ieeeAddr, endpoint.ID), {ieee: z2m.ieeeAddr, endpointID: endpoint.ID, deviceName: z2m.name});
    }
    // Группа нужна, только если в комнате два устройства и больше: одной лампе группа ничего не ускоряет.
    for (const [areaId, a] of out) {
        if (new Set([...a.members.values()].map((m) => m.ieee)).size < 2) out.delete(areaId);
    }
    return out;
}

/** Клиент WebSocket API Home Assistant: вход по токену, вызовы с ответом, подписка на события, переподключение. */
export class HaClient {
    constructor({url, token, WebSocket, timing, onReady, onEvent, onFatal, onDown}) {
        Object.assign(this, {url, token, WebSocket, timing, onReady, onEvent, onFatal, onDown});
        this.seq = 0;
        this.calls = new Map();
        this.closed = false;
        this.backoff = timing.reconnect;
    }

    connect() {
        if (this.closed) return;
        let ws;
        try {
            ws = new this.WebSocket(this.url);
        } catch (error) {
            this.down(error.message);
            return;
        }
        this.ws = ws;
        ws.addEventListener("message", (ev) => this.onMessage(ws, ev.data));
        ws.addEventListener("error", () => {}); // причина придёт в close; без слушателя ws бросил бы исключение
        ws.addEventListener("close", (ev) => {
            if (this.ws !== ws) return;
            this.ws = undefined;
            this.down(ev?.reason || `соединение закрыто (${ev?.code ?? "?"})`);
        });
    }

    down(reason) {
        for (const [, c] of this.calls) c.reject(new Error(`Home Assistant: ${reason}`));
        this.calls.clear();
        if (this.closed) return;
        this.onDown?.(reason);
        this.timer = setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, this.timing.reconnectMax);
    }

    async onMessage(ws, raw) {
        let msg;
        try {
            msg = JSON.parse(String(raw));
        } catch {
            return;
        }
        if (msg.type === "auth_required") {
            ws.send(JSON.stringify({type: "auth", access_token: this.token}));
        } else if (msg.type === "auth_invalid") {
            // Токен не принят: дополнению не дали homeassistant_api. Повторять бессмысленно.
            this.close();
            this.onFatal?.(msg.message ?? "auth_invalid");
        } else if (msg.type === "auth_ok") {
            this.backoff = this.timing.reconnect;
            try {
                for (const event_type of HA_EVENTS) await this.call("subscribe_events", {event_type});
                this.onReady?.();
            } catch (error) {
                this.onDown?.(error.message);
            }
        } else if (msg.type === "result") {
            const c = this.calls.get(msg.id);
            if (!c) return;
            this.calls.delete(msg.id);
            if (msg.success) c.resolve(msg.result);
            else c.reject(new Error(`Home Assistant: ${msg.error?.message ?? msg.error?.code ?? "ошибка"}`));
        } else if (msg.type === "event" && HA_EVENTS.includes(msg.event?.event_type)) {
            this.onEvent?.(msg.event);
        }
    }

    call(type, extra = {}) {
        const ws = this.ws;
        if (!ws) return Promise.reject(new Error("Home Assistant: нет соединения"));
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.calls.set(id, {resolve, reject});
            ws.send(JSON.stringify({id, type, ...extra}));
        });
    }

    close() {
        this.closed = true;
        clearTimeout(this.timer);
        const ws = this.ws;
        this.ws = undefined;
        for (const [, c] of this.calls) c.reject(new Error("Home Assistant: соединение закрыто"));
        this.calls.clear();
        try {
            ws?.close();
        } catch {}
    }
}

export default class BmsAreaGroups {
    // 11-й аргумент Z2M не передаёт (externalExtensions.ts:42) — он только для проверок: подставной WebSocket, сроки.
    constructor(zigbee, mqtt, state, publishEntityState, eventBus, enableDisableExtension, restartCallback, addExtension, settings, logger, opts = {}) {
        Object.assign(this, {zigbee, eventBus, settings, logger});
        this.opts = opts;
        this.timing = {...TIMING, ...opts.timing};
        if (process.env.BMS_AREA_GROUPS_TIMING) Object.assign(this.timing, JSON.parse(process.env.BMS_AREA_GROUPS_TIMING));
        this.pending = new Map();
        this.seq = 0;
        this.retryDelay = this.timing.retry;
        this.warned = new Set();
        // Папка данных Z2M: окружение, как lib/util/data.ts; иначе — родитель external_extensions (Z2M грузит
        // нас из копии .tmp-… в этой папке, externalJS.ts:232).
        this.dataDir = opts.dataDir ?? process.env.ZIGBEE2MQTT_DATA ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    }

    async start() {
        const token = this.opts.token ?? process.env.SUPERVISOR_TOKEN;
        if (!token) {
            this.logger.info("BMS: группы по комнатам выключены — нет доступа к Home Assistant (нет SUPERVISOR_TOKEN: Z2M запущен не как дополнение)", NS);
            return;
        }
        const WebSocket = this.opts.WebSocket ?? globalThis.WebSocket ?? (await import("ws")).default;
        this.eventBus.onMQTTMessagePublished(this, (data) => this.onPublished(data));
        this.startupUntil = Date.now() + this.timing.startDelay;
        let downLogged = false;
        this.ha = new HaClient({
            url: this.opts.url ?? process.env.BMS_HA_WS_URL ?? DEFAULT_URL,
            token,
            WebSocket,
            timing: this.timing,
            onReady: () => {
                downLogged = false;
                this.logger.info("BMS: группы по комнатам — Home Assistant на связи, слежу за областями", NS);
                this.schedule(this.timing.debounce);
            },
            onEvent: () => this.schedule(this.timing.debounce),
            onFatal: (why) => {
                this.logger.warning(`BMS: группы по комнатам выключены — Home Assistant не пустил (${why}); нужен homeassistant_api: true в дополнении`, NS);
                this.stopTimers();
            },
            onDown: (why) => {
                // Одна строка на обрыв, а не на каждую попытку: HA перезапускается — это нормально.
                if (!downLogged) this.logger.warning(`BMS: группы по комнатам — нет связи с Home Assistant (${why}), переподключаюсь`, NS);
                downLogged = true;
            },
        });
        this.ha.connect();
    }

    async stop() {
        this.stopped = true;
        this.stopTimers();
        this.ha?.close();
        for (const [, p] of this.pending) p.resolve({status: "error", error: "Z2M останавливается"});
        this.pending.clear();
        this.eventBus.removeListeners(this);
    }

    stopTimers() {
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    /** Склейка: каждое новое событие отодвигает проход; первый проход — не раньше startDelay после старта. */
    schedule(delay) {
        if (this.stopped || this.ha?.closed) return;
        if (this.running) {
            this.again = true;
            return;
        }
        clearTimeout(this.timer);
        const due = Math.max(Date.now() + delay, this.startupUntil ?? 0);
        this.timer = setTimeout(() => this.sync(), due - Date.now());
    }

    async sync() {
        this.timer = undefined;
        if (this.running || this.stopped) return;
        this.running = true;
        this.again = false;
        let failed = true;
        try {
            const [areas, devices, entities] = await Promise.all([
                this.ha.call("config/area_registry/list"),
                this.ha.call("config/device_registry/list"),
                this.ha.call("config/entity_registry/list"),
            ]);
            failed = await this.apply({areas, devices, entities});
        } catch (error) {
            this.logger.warning(`BMS: группы по комнатам — проход не удался (${error.message}), повторю позже`, NS);
        } finally {
            this.running = false;
        }
        if (this.stopped) return;
        if (this.again) {
            this.schedule(this.timing.debounce);
        } else if (failed) {
            this.schedule(this.retryDelay);
            this.retryDelay = Math.min(this.retryDelay * 2, this.timing.retryMax);
        } else {
            this.retryDelay = this.timing.retry;
        }
    }

    /** Приводит группы к областям. Возвращает true, если что-то не вышло и нужен повтор. */
    async apply(registries) {
        const base = this.settings.get().mqtt.base_topic;
        const z2mDevices = [...this.zigbee.devicesIterator()].filter((d) => d && d.zh?.type !== "Coordinator" && !d.options?.disabled);
        const want = desiredAreas(registries, z2mDevices, base);
        const groups = [...this.zigbee.groupsIterator()];
        const own = new Map(groups.filter((g) => isOwnGroup(g.ID, g.name)).map((g) => [g.ID, g]));
        const taken = new Set([...groups.map((g) => g.ID), ...Object.keys(this.settings.get().groups ?? {}).map(Number)]);
        const foreign = (id) => taken.has(id) && !own.has(id);

        // id области стабилен (файл в папке данных): та же комната — та же группа, и после «меньше двух
        // устройств» и обратно тоже. Забываем id только вместе с областью.
        const map = this.loadMap();
        const before = JSON.stringify(map);
        const plan = new Map();
        for (const [areaId, area] of want) {
            let id = map[areaId];
            if (!isOwnGroup(id, PREFIX) || foreign(id) || plan.has(id)) id = undefined;
            id ??= [...own.values()].find((g) => g.name === area.name && !plan.has(g.ID))?.ID;
            id ??= this.freeId(taken, plan, map, areaId);
            if (id === undefined) {
                this.warnOnce(`full`, `BMS: группы по комнатам — кончились свободные id ${ID_MIN}–${ID_MAX}`);
                continue;
            }
            map[areaId] = id;
            plan.set(id, area);
        }
        const areaIds = new Set(registries.areas.map((a) => a.area_id));
        for (const areaId of Object.keys(map)) if (!areaIds.has(areaId)) delete map[areaId];
        if (JSON.stringify(map) !== before) this.saveMap(map);

        let failed = false;
        for (const [id, g] of own) {
            if (plan.has(id) || this.stopped) continue;
            const why = [...Object.entries(map)].some(([, v]) => v === id) ? "в комнате меньше двух устройств" : "области больше нет";
            if (!(await this.deleteGroup(g, why))) failed = true;
        }
        for (const [id, area] of plan) {
            if (this.stopped) break;
            if (!(await this.syncGroup(id, area, own.get(id)))) failed = true;
        }
        return failed;
    }

    freeId(taken, plan, map, areaId) {
        const reserved = new Set(Object.entries(map).filter(([a]) => a !== areaId).map(([, v]) => v));
        for (let id = ID_MIN; id <= ID_MAX; id++) if (!taken.has(id) && !plan.has(id) && !reserved.has(id)) return id;
    }

    async syncGroup(id, area, group) {
        // Имя занято чужой группой или устройством — не наше, не трогаем; предупреждаем один раз.
        const clash = this.zigbee.resolveEntity(area.name);
        if (clash && !(clash.constructor?.name === "Group" && clash.ID === id)) {
            this.warnOnce(`clash:${area.name}`, `BMS: группа '${area.name}' не создана — имя уже занято в Z2M`);
            return true;
        }
        if (!group) {
            const r = await this.request("group/add", {friendly_name: area.name, id: String(id)});
            if (r.status !== "ok") {
                this.logger.error(`BMS: группа '${area.name}' (id ${id}) не создана: ${r.error}`, NS);
                return false;
            }
            this.logger.info(`BMS: создана группа '${area.name}' (id ${id})`, NS);
            group = this.findGroup(id);
            if (!group) return false;
        } else if (group.name !== area.name) {
            const from = group.name;
            const r = await this.request("group/rename", {from, to: area.name});
            if (r.status !== "ok") {
                this.logger.error(`BMS: группа '${from}' (id ${id}) не переименована в '${area.name}': ${r.error}`, NS);
                return false;
            }
            this.logger.info(`BMS: группа '${from}' (id ${id}) переименована в '${area.name}'`, NS);
        }
        const have = new Map(group.zh.members.map((e) => [memberKey(e.deviceIeeeAddress, e.ID), e]));
        let ok = true;
        const done = {add: [], remove: []};
        for (const [key, e] of have) {
            if (area.members.has(key) || this.stopped) continue;
            const name = this.zigbee.resolveEntity(e.deviceIeeeAddress)?.name ?? e.deviceIeeeAddress;
            if (await this.member("remove", area.name, id, e.deviceIeeeAddress, e.ID, name)) done.remove.push(`${name}/${e.ID}`);
            else ok = false;
        }
        for (const [key, m] of area.members) {
            if (have.has(key) || this.stopped) continue;
            if (await this.member("add", area.name, id, m.ieee, m.endpointID, m.deviceName)) done.add.push(`${m.deviceName}/${m.endpointID}`);
            else ok = false;
        }
        if (done.add.length) this.logger.info(`BMS: в группу '${area.name}' добавлены: ${done.add.join(", ")}`, NS);
        if (done.remove.length) this.logger.info(`BMS: из группы '${area.name}' убраны: ${done.remove.join(", ")}`, NS);
        return ok;
    }

    async deleteGroup(group, why) {
        const name = group.name;
        // Сначала участники по одному с паузой: group/remove сам снял бы их подряд без пауз (zh Group.removeFromNetwork).
        let ok = true;
        for (const e of [...group.zh.members]) {
            if (this.stopped) return false;
            const dev = this.zigbee.resolveEntity(e.deviceIeeeAddress)?.name ?? e.deviceIeeeAddress;
            if (!(await this.member("remove", name, group.ID, e.deviceIeeeAddress, e.ID, dev))) ok = false;
        }
        if (!ok) {
            this.logger.warning(`BMS: группа '${name}' (id ${group.ID}) пока не удалена (${why}) — не все устройства ответили, повторю позже`, NS);
            return false;
        }
        const r = await this.request("group/remove", {id: String(group.ID)});
        if (r.status !== "ok") {
            this.logger.error(`BMS: группа '${name}' (id ${group.ID}) не удалена: ${r.error}`, NS);
            return false;
        }
        this.logger.info(`BMS: удалена группа '${name}' (id ${group.ID}) — ${why}`, NS);
        return true;
    }

    /** Одна команда участнику — с паузой от предыдущей; таймаут — строка в журнале и повтор позже, не авария. */
    async member(action, groupName, id, ieee, endpoint, deviceName) {
        const wait = (this.lastCommandAt ?? 0) + this.timing.pause - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        const r = await this.request(`group/members/${action}`, {group: String(id), device: ieee, endpoint});
        this.lastCommandAt = Date.now();
        if (r.status === "ok") return true;
        const verb = action === "add" ? "не добавлено в" : "не убрано из";
        this.logger.warning(`BMS: '${deviceName}' (endpoint ${endpoint}) ${verb} '${groupName}': ${r.error} — повторю позже`, NS);
        return false;
    }

    findGroup(id) {
        for (const g of this.zigbee.groupsIterator((zg) => zg.groupID === id)) return g;
    }

    /** Запрос bridge так же, как из MQTT; ответ — из bridge/response/<имя> с нашим transaction. */
    request(name, payload) {
        const base = this.settings.get().mqtt.base_topic;
        const transaction = `bms-area-${++this.seq}`;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(transaction);
                resolve({status: "error", error: `нет ответа Z2M за ${Math.round(this.timing.reply / 1000)} с`});
            }, this.timing.reply);
            this.pending.set(transaction, {
                topic: `${base}/bridge/response/${name}`,
                resolve: (r) => {
                    clearTimeout(timer);
                    resolve(r);
                },
            });
            this.eventBus.emitMQTTMessage({topic: `${base}/bridge/request/${name}`, message: JSON.stringify({...payload, transaction})});
        });
    }

    onPublished({topic, payload}) {
        if (!topic.includes("/bridge/response/") || !payload.includes("bms-area-")) return;
        let msg;
        try {
            msg = JSON.parse(payload);
        } catch {
            return;
        }
        const p = this.pending.get(msg?.transaction);
        if (!p || p.topic !== topic) return;
        this.pending.delete(msg.transaction);
        p.resolve(msg);
    }

    loadMap() {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(this.dataDir, MAP_FILE), "utf8"));
            return data && typeof data.areas === "object" ? {...data.areas} : {};
        } catch {
            return {};
        }
    }

    saveMap(map) {
        try {
            const file = path.join(this.dataDir, MAP_FILE);
            fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({areas: map}, null, 2)}\n`);
            fs.renameSync(`${file}.tmp`, file);
        } catch (error) {
            this.logger.warning(`BMS: группы по комнатам — не записан ${MAP_FILE} (${error.message})`, NS);
        }
    }

    warnOnce(key, text) {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        this.logger.warning(text, NS);
    }
}
