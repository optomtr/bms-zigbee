// BMS: служебные ответы Tuya для всех устройств Tuya — как это делает родной хаб Tuya.
//
// Почему расширение, а не правка описаний: Z2M отвечает на «который час?» и «шлюз на связи?»
// только моделям, где в описании подключён tuyaBase (а у него время по умолчанию "off"),
// и шлёт «магический пакет» только тем, у кого он записан в configure. Остальные устройства
// переспрашивают, засоряют сеть и считают себя «без шлюза». Расширение закрывает разрыв,
// не трогая описания: отвечает только там, где описание само не ответит.
//
// Как Z2M 2.14.2 его загружает: lib/extension/externalExtensions.ts:42 — `new mod(zigbee, mqtt,
// state, publishEntityState, eventBus, enableDisableExtension, restartCallback, addExtension,
// settings, logger)`; события — lib/eventBus.ts (подписка по имени класса, :245).
import zhc from "zigbee-herdsman-converters";
import tuya from "zigbee-herdsman-converters/lib/tuya";
import fz from "zigbee-herdsman-converters/converters/fromZigbee";
import {groupMembership} from "./bms-lib/group-membership.mjs";

const NS = "bms:tuya";
const SERVICE = ["commandMcuSyncTime", "commandMcuGatewayConnectionStatus"];
const REPORTS = ["commandDataResponse", "commandDataReport", "commandActiveStatusReport", "commandActiveStatusReportAlt"];
const noop = () => {};

// Типы точек под именами Tuya («value», а не «number» converters); код и отправка — из converters.
const TYPES = {
    bool: {code: tuya.dataTypes.bool, ok: (v) => typeof v === "boolean", send: tuya.sendDataPointBool},
    value: {code: tuya.dataTypes.number, ok: (v) => Number.isInteger(v) && v >= -0x80000000 && v <= 0xffffffff, send: tuya.sendDataPointValue},
    enum: {code: tuya.dataTypes.enum, ok: (v) => Number.isInteger(v) && v >= 0 && v <= 0xff, send: tuya.sendDataPointEnum},
    // Точка «bitmap» в converters кодируется одним байтом (dpValueFromBitmap), шире не отправить.
    bitmap: {code: tuya.dataTypes.bitmap, ok: (v) => Number.isInteger(v) && v >= 0 && v <= 0xff, send: tuya.sendDataPointBitmap},
    string: {code: tuya.dataTypes.string, ok: (v) => typeof v === "string", send: tuya.sendDataPointStringBuffer},
    // Сырые байты — строкой hex: так же они показываются в dp_<номер>, можно копировать туда-обратно.
    raw: {code: tuya.dataTypes.raw, ok: (v) => typeof v === "string" && /^([0-9a-f]{2})*$/i.test(v), send: (ep, dp, v) => tuya.sendDataPointRaw(ep, dp, Buffer.from(v, "hex"))},
};
const TYPE_NAME = Object.fromEntries(Object.entries(TYPES).map(([name, t]) => [t.code, name]));

// Отвечает сам конвертер tuyaBase из converters: формат времени (UTC + местное, 1970/2000) и статуса
// шлюза не переписываем. Отсчёт по умолчанию — 1970: из 689 вызовов tuyaBase в converters 26.115.1
// отсчёт задан у 106, из них "1970" — 76, "2000" — 30; в описании опции "1970" назван рекомендуемым.
const REPLIER = tuya.modernExtend.tuyaBase({timeStart: "1970"}).fromZigbee.find((c) => [c.type].flat().includes(SERVICE[1]));

// «Устройство Tuya» по производителю: _TZ… (_TZE200_, _TZ3000_…) и старые _TY… (_TYZB01_, _TYST11_…).
// Нужен там, где сообщения от устройства нет (магический пакет, bms_dp). Для служебных ответов и сырых
// точек признак — само сообщение кластера manuSpecificTuya (0xEF00): его шлёт только Tuya, какой бы ни был префикс.
const isTuyaMaker = (device) => device?.zh?.type !== "Coordinator" && /^_T[ZY]/.test(device?.zh?.manufacturerName ?? "");

// Явно известные возможности закреплённой версии converters. Фабрика tuyaBase
// возвращает замыкание без метаданных timeStart; значение по умолчанию опубликовано
// в описании опции. Сравниваем только форму известного обработчика, не исполняя его.
// При смене upstream тесты проверяют этот контракт. Незнакомый обработчик сохраняет
// владение ответом; описания могут явно передать его BMS через meta.bmsTuyaServices.
const TUYA_BASE_HANDLER = String(REPLIER.convert);
export function definitionAnswers(definition, type, options = {}) {
    const ownership = definition?.meta?.bmsTuyaServices?.[type];
    if (ownership === "definition") return true;
    if (ownership === "fallback") return false;
    const own = (definition?.fromZigbee ?? []).filter((c) => c.cluster === "manuSpecificTuya" && [c.type].flat().includes(type));
    for (const converter of own) {
        if (converter === fz.ignore_tuya_set_time) continue;
        if (String(converter.convert) !== TUYA_BASE_HANDLER) return true;
        if (type === "commandMcuGatewayConnectionStatus") return true;
        const defaultTime = definition.options?.find((o) => o.name === "time_start")?.description?.match(/Default for this device: "(1970|2000|off)"/)?.[1];
        const selectedTime = ["1970", "2000", "off"].includes(options.time_start) ? options.time_start : defaultTime;
        // Неизвестная версия метаданных: не добавляем второй ответ поверх своего
        // обработчика устройства. Это явно проверяемый консервативный отказ.
        if (selectedTime === undefined || selectedTime !== "off") return true;
    }
    return false;
}

/** Делает ли описание «магический пакет» само (в configure — напрямую, через tuyaBase/tuyaMagicPacket или внутри своей функции). */
export async function definitionSendsMagicPacket(zhDevice) {
    // Нужен исходный вид описания: в готовом (prepareDefinition) все configure слиты в одну функцию.
    const raw = await zhc.findDefinition(zhDevice);
    if (!raw) return false;
    const configures = [raw.configure, ...(raw.extend ?? []).flatMap((e) => e.configure ?? [])].filter(Boolean);
    return configures.some((fn) => fn === tuya.configureMagicPacket || String(fn).includes("configureMagicPacket"));
}

export function checkDpCommand(cmd) {
    if (!cmd || typeof cmd !== "object") return 'ожидается {"dp":N,"type":"bool|value|enum|bitmap|string|raw","value":…}';
    if (!Number.isInteger(cmd.dp) || cmd.dp < 1 || cmd.dp > 255) return "dp — целое число 1…255";
    if (!TYPES[cmd.type]) return `type — одно из: ${Object.keys(TYPES).join(", ")}`;
    if (!TYPES[cmd.type].ok(cmd.value)) return `value ${JSON.stringify(cmd.value)} не подходит к типу ${cmd.type}`;
}

export default class BmsTuyaService {
    constructor(zigbee, mqtt, state, publishEntityState, eventBus, enableDisableExtension, restartCallback, addExtension, settings, logger) {
        this.zigbee = zigbee;
        this.membership = groupMembership(zigbee);
        this.publishEntityState = publishEntityState;
        this.eventBus = eventBus;
        this.settings = settings;
        this.logger = logger;
    }

    async start() {
        this.eventBus.onDeviceMessage(this, (data) => this.onDeviceMessage(data));
        // После интервью известны производитель и описание. deviceJoined не слушаем: он приходит до
        // интервью, производителя ещё нет, а за ним всё равно идёт интервью.
        // «Интервью успешно» приходит один раз на интервью: от zigbee-herdsman после подключения неопрошенного
        // устройства (controller.ts:896) и после повторного интервью по запросу (Z2M model/device.ts:86).
        // Повторное подключение опрошенного устройства его не даёт (controller.ts:902 — интервью не запускается).
        this.eventBus.onDeviceInterview(this, async (data) => {
            if (data.status !== "successful") return;
            this.membership.invalidate(data.device.zh.ieeeAddr);
            await this.sendMagicPacket(data.device);
            await this.clearForeignGroups(data.device);
        });
        // Повторное подключение известного устройства: интервью уже не будет, пакет шлём здесь.
        this.eventBus.onDeviceAnnounce(this, (data) => {
            // После повторного входа не считаем сохранённую в процессе проверку
            // доказательством: устройство могло сбросить свою таблицу групп.
            this.membership.invalidate(data.device.zh.ieeeAddr);
            return data.device.interviewed ? this.sendMagicPacket(data.device) : undefined;
        });
        this.eventBus.onMQTTMessage(this, (data) => this.onMqttMessage(data));
    }

    async stop() {
        this.eventBus.removeListeners(this);
    }

    async onDeviceMessage(data) {
        const {device} = data;
        if (data.cluster !== "manuSpecificTuya") return;
        if (SERVICE.includes(data.type)) {
            await this.answerService(data);
        } else if (REPORTS.includes(data.type) && !device.isSupported) {
            await this.publishRawPoints(data);
        }
    }

    async answerService(data) {
        const {device} = data;
        const options = device.options ?? {};
        // time_start: "off" владелец ставит сам (опция Z2M у устройства) — значит, на время не отвечать никому.
        if (data.type === SERVICE[0] && options.time_start === "off") return;
        if (await definitionAnswers(device.definition, data.type, options)) return;
        const timeStart = ["1970", "2000"].includes(options.time_start) ? options.time_start : "1970";
        await REPLIER.convert(undefined, {...data, device: device.zh}, noop, {time_start: timeStart}, {device: device.zh});
        this.logger.debug(`Ответ ${data.type === SERVICE[0] ? `на запрос времени (${timeStart})` : "о статусе шлюза"} для '${device.name}'`, NS);
    }

    async publishRawPoints(data) {
        const zh = data.device.zh;
        // Разбор точек — конвертером converters (tuya.fz.datapoints); на каждую точку пишем «тип + значение».
        const show = (datatype) => (v) => ({type: TYPE_NAME[datatype] ?? datatype, value: v !== null && typeof v === "object" ? Buffer.from(v).toString("hex") : v});
        const model = {meta: {tuyaDatapoints: (data.data.dpValues ?? []).map((d) => [d.dp, `dp_${d.dp}`, {from: show(d.datatype)}])}};
        const payload = tuya.fz.datapoints.convert(model, {...data, device: zh}, noop, {}, {device: zh});
        if (payload && Object.keys(payload).length > 0) await this.publishEntityState(data.device, payload);
    }

    async onMqttMessage({topic, message}) {
        const base = `${this.settings.get().mqtt.base_topic}/`;
        if (!topic.startsWith(base) || !topic.endsWith("/set") || !message.includes("bms_dp")) return;
        let cmd;
        try {
            cmd = JSON.parse(message).bms_dp;
        } catch {
            return;
        }
        if (cmd === undefined) return;
        const name = topic.slice(base.length, -"/set".length);
        const device = this.zigbee.resolveEntity(name);
        if (!device?.isDevice?.() || !isTuyaMaker(device)) {
            this.logger.error(`bms_dp: '${name}' — не устройство Tuya (_TZ…/_TY…)`, NS);
            return;
        }
        if (device.isSupported) {
            this.logger.error(`bms_dp: у '${name}' есть описание модели — управляйте его свойствами; bms_dp только для неописанных`, NS);
            return;
        }
        const problem = checkDpCommand(cmd);
        if (problem) {
            this.logger.error(`bms_dp для '${name}': ${problem}`, NS);
            return;
        }
        try {
            await TYPES[cmd.type].send(device.zh.endpoints[0], cmd.dp, cmd.value);
            this.logger.info(`bms_dp → '${name}': dp ${cmd.dp} (${cmd.type}) = ${JSON.stringify(cmd.value)}`, NS);
        } catch (error) {
            this.logger.error(`bms_dp → '${name}': не отправлено (${error.message})`, NS);
        }
    }

    async sendMagicPacket(device) {
        if (!isTuyaMaker(device) || (await definitionSendsMagicPacket(device.zh))) return;
        try {
            await tuya.configureMagicPacket(device.zh, this.zigbee.firstCoordinatorEndpoint());
            this.logger.debug(`Магический пакет Tuya отправлен '${device.name}'`, NS);
        } catch (error) {
            // Спящее устройство может не ответить на чтение — это не авария, при следующем объявлении повторим.
            this.logger.warning(`Магический пакет Tuya для '${device.name}' не прошёл (${error.message})`, NS);
        }
    }

    /**
     * Хаб Tuya оставляет на устройстве свои записи в таблице групп, и с ними genGroups.add от Z2M таймаутит
     * (живая сеть: 2 из 18 TS0502B, перенесённых с хаба; помог remove_all). Чистим таблицу после интервью,
     * но только если по базе Z2M устройство не входит ни в одну группу: настроенные владельцем группы не трогаем.
     */
    async clearForeignGroups(device) {
        if (!isTuyaMaker(device)) return;
        return this.membership.withDeviceLock(device.zh.ieeeAddr, () => this.clearForeignGroupsLocked(device));
    }

    async clearForeignGroupsLocked(device) {
        const endpoints = device.zh.endpoints;
        const has = (clusters, name) => clusters.some((c) => c.name === name);
        // Пульт и кнопка сцен сами шлют вкл/выкл (клиентский genOnOff): их группы — в таблице привязок, а не в членстве.
        if (endpoints.some((e) => has(e.getOutputClusters(), "genOnOff"))) return;
        // Членство — как его видит Z2M: группы базы zigbee-herdsman и их участники (lib/zigbee.ts:400, model/group.ts:32).
        for (const _group of this.zigbee.groupsIterator((g) => g.members.some((e) => e.deviceIeeeAddress === device.zh.ieeeAddr))) {
            this.logger.debug(`BMS: '${device.name}' уже в группе Z2M — таблицу групп не трогаем`, NS);
            return;
        }
        // Только серверный genGroups: у endpoint без него таблицы групп нет.
        const targets = endpoints.filter((e) => has(e.getInputClusters(), "genGroups"));
        const cleared = [];
        for (const endpoint of targets) {
            try {
                // Блокировка всего устройства охватывает ВСЕ endpoint, иначе add
                // второго канала мог вклиниться между двумя removeAll.
                this.membership.invalidate(device.zh.ieeeAddr, endpoint.ID);
                await endpoint.command("genGroups", "removeAll", {}, {disableDefaultResponse: true});
                const actual = await this.membership.verify(endpoint);
                if (actual.size > 0) throw new Error("устройство сохранило группы после removeAll");
                cleared.push(endpoint.ID);
            } catch (error) {
                this.logger.warning(`BMS: таблицу групп на '${device.name}' (endpoint ${endpoint.ID}) очистить не удалось: ${error.message}`, NS);
            }
        }
        if (cleared.length > 0) {
            this.logger.info(`BMS: очищена таблица групп на '${device.name}' (endpoint ${cleared.join(", ")}) — старые записи хаба Tuya, в группах Z2M устройства нет`, NS);
        }
    }
}
