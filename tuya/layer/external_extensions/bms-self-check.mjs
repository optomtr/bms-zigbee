// BMS: самопроверка сети после обновления дополнения — владелец сразу видит итог в Home Assistant
// («ответили 28 из 28, среднее 0,2 с»), а не узнаёт о сбое, когда свет не включится.
//
// Почему только чтение: проверка не должна ничего включать и выключать — дом не должен мигать при обновлении.
// Чтение атрибута genBasic.zclVersion проходит тот же путь по радио, что и команда (туда и обратно через те же
// ретрансляторы), и есть у любого устройства Zigbee.
//
// Почему не при каждом запуске: перезапуск Z2M — обычное дело (HA обновился, свет моргнул), а проверка нужна, когда
// поменялся наш код. Версию дополнения кладёт Dockerfile в BMS_ADDON_VERSION; проверенная версия — в файле
// bms-self-check.json в папке данных. Вручную: MQTT `<base>/bms/self_check/run` (любое сообщение).
//
// Устройства на батарейках спят и на чтение не отвечают — их не трогаем, иначе каждое попадало бы в «не ответили».
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const NS = "bms:self-check";
export const STATE_FILE = "bms-self-check.json";
export const NOTIFICATION_ID = "bms_zigbee_self_check";
export const DEFAULT_NOTIFY_URL = "http://supervisor/core/api/services/persistent_notification/create";

// Сроки (мс). startDelay — после старта сеть собирает маршруты, первые минуты ответы медленные и не показательны;
// pause — между чтениями, чтобы проверка не мешала командам; retryDelay — повтор не ответивших: устройство могло
// быть занято или перестраивать маршрут; slow — порог «отвечает медленно».
export const TIMING = {startDelay: 120_000, pause: 500, retryDelay: 60_000, slow: 1500};

/** Кого проверяем: всё, что питается от сети и прошло знакомство. Координатор, отключённые и батарейные — нет. */
export function isCheckable(device) {
    const zh = device?.zh;
    if (!zh || zh.type === "Coordinator" || device.options?.disabled || !zh.interviewCompleted) return false;
    const power = String(zh.powerSource ?? "").toLowerCase();
    if (power.includes("battery")) return false;
    return zh.type === "Router" || power.includes("mains") || power.includes("dc");
}

const seconds = (ms) => `${(ms / 1000).toFixed(1).replace(".", ",")} с`;

/** Текст уведомления: по-русски, коротко, с тем, что делать. */
export function summaryText(r) {
    const lines = [];
    const head = r.version ? `Версия ${r.version}: ` : "";
    if (!r.total) return `${head}устройств с питанием от сети пока нет — проверять нечего.`;
    lines.push(`${head}ответили ${r.ok} из ${r.total} устройств, в среднем ${seconds(r.avgMs)}, самое долгое ${seconds(r.maxMs)}.`);
    if (r.failed.length) lines.push(`Не ответили: ${r.failed.join(", ")} — проверьте, есть ли на них питание.`);
    if (r.slow.length) lines.push(`Отвечают медленно (дольше ${seconds(TIMING.slow)}): ${r.slow.join(", ")}.`);
    if (r.retried.length) lines.push(`Ответили со второго раза: ${r.retried.join(", ")}.`);
    lines.push("Свет при проверке не включался и не выключался.");
    return lines.join("\n");
}

export default class BmsSelfCheck {
    // 11-й аргумент Z2M не передаёт (externalExtensions.ts:42) — он только для проверок: сроки, версия, fetch.
    constructor(zigbee, mqtt, state, publishEntityState, eventBus, enableDisableExtension, restartCallback, addExtension, settings, logger, opts = {}) {
        Object.assign(this, {zigbee, mqtt, eventBus, settings, logger});
        this.opts = opts;
        this.timing = {...TIMING, ...opts.timing};
        this.dataDir = opts.dataDir ?? process.env.ZIGBEE2MQTT_DATA ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    }

    async start() {
        const base = this.settings.get().mqtt.base_topic;
        this.runTopic = `${base}/bms/self_check/run`;
        this.eventBus.onMQTTMessage(this, (data) => {
            if (data.topic === this.runTopic) void this.run("по запросу");
        });
        const version = this.opts.version ?? process.env.BMS_ADDON_VERSION;
        if (!version) {
            this.logger.info("BMS: самопроверка после обновления выключена — версия дополнения неизвестна (Z2M запущен не как дополнение); вручную — MQTT bms/self_check/run", NS);
            return;
        }
        this.version = version;
        if (this.load().checkedVersion === version) return;
        this.logger.info(`BMS: новая версия ${version} — самопроверка сети через ${Math.round(this.timing.startDelay / 1000)} с (только чтение, свет не переключается)`, NS);
        this.timer = setTimeout(() => void this.run("после обновления"), this.timing.startDelay);
    }

    async stop() {
        this.stopped = true;
        clearTimeout(this.timer);
        clearTimeout(this.wake);
        this.wakeUp?.();
        this.eventBus.removeListeners(this);
    }

    async run(reason) {
        if (this.running || this.stopped) return undefined;
        this.running = true;
        try {
            const devices = [...this.zigbee.devicesIterator()].filter(isCheckable);
            this.logger.info(`BMS: самопроверка (${reason}) — опрашиваю ${devices.length} устройств по одному`, NS);
            const results = new Map();
            for (const device of devices) {
                if (this.stopped) return undefined;
                results.set(device, await this.probe(device));
            }
            const missed = devices.filter((d) => !results.get(d).ok);
            const retried = [];
            if (missed.length && !this.stopped) {
                await this.sleep(this.timing.retryDelay);
                for (const device of missed) {
                    if (this.stopped) return undefined;
                    const second = await this.probe(device);
                    if (second.ok) {
                        results.set(device, second);
                        retried.push(device.name);
                    }
                }
            }
            const answered = [...results.values()].filter((r) => r.ok);
            const result = {
                version: this.version,
                reason,
                at: new Date().toISOString(),
                total: devices.length,
                ok: answered.length,
                avgMs: answered.length ? Math.round(answered.reduce((s, r) => s + r.ms, 0) / answered.length) : 0,
                maxMs: answered.reduce((m, r) => Math.max(m, r.ms), 0),
                failed: devices.filter((d) => !results.get(d).ok).map((d) => d.name),
                slow: devices.filter((d) => results.get(d).ok && results.get(d).ms > this.timing.slow).map((d) => d.name),
                retried,
                // scenes — есть ли у устройства кластер сцен (из базы, без запроса в эфир): от этого зависит,
                // можно ли включать набор света одной командой сцены, как хаб Tuya.
                devices: devices.map((d) => ({name: d.name, ieee: d.ieeeAddr, scenes: d.zh.endpoints.some((e) => e.supportsInputCluster?.("genScenes")), ...results.get(d)})),
            };
            if (this.stopped) return undefined;
            await this.report(result);
            // Записываем проверенную версию и при сбоях: повтор той же версии ничего нового не скажет,
            // а уведомление со списком не ответивших у владельца уже есть.
            if (this.version) this.save({checkedVersion: this.version, last: result});
            return result;
        } finally {
            this.running = false;
        }
    }

    /** Одно чтение через общую очередь устройства (bms.commandQueue): не обгоняет и не перебивает его команды. */
    async probe(device) {
        await this.sleep(this.timing.pause);
        const endpoint = device.zh.endpoints.find((e) => e.supportsInputCluster?.("genBasic")) ?? device.zh.endpoints[0];
        if (!endpoint) return {ok: false, error: "нет endpoint"};
        const read = () => endpoint.read("genBasic", ["zclVersion"]);
        const queue = this.zigbee[Symbol.for("bms.commandQueue")];
        const started = Date.now();
        try {
            await (queue ? queue.runDevice(device.zh.ieeeAddr, read) : read());
            return {ok: true, ms: Date.now() - started};
        } catch (error) {
            return {ok: false, error: String(error?.message ?? error)};
        }
    }

    async report(result) {
        const text = summaryText(result);
        const level = result.failed.length ? "warning" : "info";
        this.logger[level](`BMS: самопроверка — ${text.replaceAll("\n", " ")}`, NS);
        try {
            await this.mqtt.publish("bms/self_check", JSON.stringify(result), {clientOptions: {retain: true, qos: 1}});
        } catch (error) {
            this.logger.warning(`BMS: самопроверка — итог не опубликован в MQTT (${error.message})`, NS);
        }
        await this.notify(result, text);
    }

    /** Уведомление в Home Assistant с постоянным id: новое заменяет прошлое, а не копится. */
    async notify(result, text) {
        const token = this.opts.token ?? process.env.SUPERVISOR_TOKEN;
        if (!token) return;
        const doFetch = this.opts.fetch ?? globalThis.fetch;
        const title = result.failed.length ? "BMS Zigbee: не все устройства ответили" : "BMS Zigbee: сеть в порядке";
        try {
            const res = await doFetch(this.opts.notifyUrl ?? DEFAULT_NOTIFY_URL, {
                method: "POST",
                headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
                body: JSON.stringify({notification_id: NOTIFICATION_ID, title, message: text}),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (error) {
            this.logger.warning(`BMS: самопроверка — уведомление в Home Assistant не отправлено (${error.message})`, NS);
        }
    }

    sleep(ms) {
        // Остановка Z2M будит ожидание сразу: минутный повтор не должен держать выключение.
        return new Promise((resolve) => {
            this.wakeUp = resolve;
            this.wake = setTimeout(resolve, ms);
        });
    }

    load() {
        try {
            return JSON.parse(fs.readFileSync(path.join(this.dataDir, STATE_FILE), "utf8")) ?? {};
        } catch {
            return {};
        }
    }

    save(data) {
        try {
            const file = path.join(this.dataDir, STATE_FILE);
            fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
            fs.renameSync(`${file}.tmp`, file);
        } catch (error) {
            this.logger.warning(`BMS: самопроверка — не записан ${STATE_FILE} (${error.message})`, NS);
        }
    }
}
