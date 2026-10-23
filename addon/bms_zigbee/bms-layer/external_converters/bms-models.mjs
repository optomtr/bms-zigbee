// BMS: описания моделей Tuya из файла bms-models.yaml в папке данных Z2M.
//
// Почему файл, а не код: номер точки данных задаёт модель (tuya/library/crosscheck.md), и интегратор
// на объекте узнаёт номера сам — по dp_<номер>, которые показывает расширение bms-tuya-service.
// Вписать их в YAML и перезапустить Z2M проще и безопаснее, чем писать конвертер на JavaScript.
//
// Описание строится только из готовых кирпичей converters 26.115.1: tuya.modernExtend.tuyaBase,
// dpOnOff / dpBinary / dpNumeric / dpEnumLookup и tuya.getHandlersForDP (на нём они все и сделаны).
// Z2M берёт default-экспорт: объект описания или массив (lib/extension/externalConverters.ts:45).
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import {load} from "js-yaml";
import exposes from "zigbee-herdsman-converters/lib/exposes";
import zhcLogger from "zigbee-herdsman-converters/lib/logger";
import tuya from "zigbee-herdsman-converters/lib/tuya";
import utils from "zigbee-herdsman-converters/lib/utils";

const NS = "bms:models";
// Z2M грузит внешние конвертеры из <данные>/external_converters (externalJS.ts:40, :235 — копия
// рядом с исходным файлом), а <данные> = $ZIGBEE2MQTT_DATA или <Z2M>/data (lib/util/data.ts:4).
// Поэтому папка данных — на уровень выше этого файла, без повторения логики выбора.
const YAML_URL = new URL("../bms-models.yaml", import.meta.url);
// Логгер converters Z2M подменяет своим (controller.ts: zhcSetLogger), поэтому строки попадают в журнал Z2M.
const log = (level, message) => zhcLogger.logger[level](message, NS);

const TYPES = {
    raw: tuya.dataTypes.raw,
    bool: tuya.dataTypes.bool,
    value: tuya.dataTypes.number,
    string: tuya.dataTypes.string,
    enum: tuya.dataTypes.enum,
    bitmap: tuya.dataTypes.bitmap,
};
const COMMON_KEYS = ["dp", "kind", "type", "read_only", "description"];
const MODEL_KEYS = ["fingerprint", "model", "vendor", "description", "points"];
// Какие поля у какого вида точки; лишнее поле — скорее всего опечатка, лучше сказать сразу.
const KIND_KEYS = {
    switch: ["endpoint", "on", "off"],
    binary: ["name", "endpoint", "on", "off"],
    numeric: ["name", "endpoint", "unit", "scale", "min", "max", "step"],
    enum: ["name", "endpoint", "values"],
    cover_control: ["values"],
    cover_position: ["invert", "open_raw", "closed_raw"],
};
const DEFAULT_TYPE = {switch: "bool", binary: "bool", numeric: "value", enum: "enum", cover_control: "enum", cover_position: "value"};

// modern-extend converters раскрывают аргументы поверх своих умолчаний: явный undefined затёр бы умолчание.
const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

function checkPoint(p) {
    if (!p || typeof p !== "object") throw new Error("точка — не объект");
    if (!Number.isInteger(p.dp) || p.dp < 1 || p.dp > 255) throw new Error(`dp ${JSON.stringify(p.dp)}: нужно целое 1…255`);
    const where = `точка dp ${p.dp}`;
    if (!KIND_KEYS[p.kind]) throw new Error(`${where}: kind — одно из ${Object.keys(KIND_KEYS).join(", ")}`);
    for (const key of Object.keys(p)) {
        if (!COMMON_KEYS.includes(key) && !KIND_KEYS[p.kind].includes(key)) throw new Error(`${where}: поле «${key}» не бывает у kind ${p.kind}`);
    }
    if (p.type !== undefined && TYPES[p.type] === undefined) throw new Error(`${where}: type — одно из ${Object.keys(TYPES).join(", ")}`);
    if (KIND_KEYS[p.kind].includes("name") && !(typeof p.name === "string" && /^[a-z0-9_]+$/.test(p.name))) {
        throw new Error(`${where}: нужно name из латиницы, цифр и _ (имя свойства в Z2M)`);
    }
    const values = p.values;
    if (p.kind === "enum" && values === undefined) throw new Error(`${where}: у enum нужны values {подпись: число}`);
    if (values !== undefined && !(values && typeof values === "object" && Object.values(values).every(Number.isInteger))) {
        throw new Error(`${where}: values — {подпись: целое число}`);
    }
    if (p.scale !== undefined && !(typeof p.scale === "number" && p.scale > 0)) throw new Error(`${where}: scale — делитель больше 0`);
    if (p.invert !== undefined && (p.open_raw !== undefined || p.closed_raw !== undefined)) {
        throw new Error(`${where}: либо invert, либо open_raw/closed_raw`);
    }
    const [open, closed] = [p.open_raw ?? 100, p.closed_raw ?? 0];
    if (!Number.isInteger(open) || !Number.isInteger(closed) || open === closed) throw new Error(`${where}: open_raw и closed_raw — разные целые числа`);
}

// Положение шторы. В Z2M 0 = закрыта, 100 = открыта. Мотор бывает «наоборот» и не доходит до края
// шкалы (библиотека, особенность cover_position_inverted: закрытая 100, открытая 7), поэтому
// калибруются оба края. Значения за краем прижимаем к 0…100, чтобы Home Assistant не видел 108 %.
function coverPosition(p, type) {
    const [closed, open] = p.invert ? [100, 0] : [p.closed_raw ?? 0, p.open_raw ?? 100];
    const converter = {
        from: (v) => Math.min(100, Math.max(0, utils.mapNumberRange(v, closed, open, 0, 100))),
        to: (v) => utils.mapNumberRange(v, 0, 100, closed, open),
    };
    const [fromZigbee, toZigbee] = tuya.getHandlersForDP("position", p.dp, type, converter, p.read_only);
    return {fromZigbee, toZigbee, isModernExtend: true};
}

function pointExtend(p) {
    const type = TYPES[p.type ?? DEFAULT_TYPE[p.kind]];
    const base = {dp: p.dp, type, readOnly: p.read_only, endpoint: p.endpoint, description: p.description};
    switch (p.kind) {
        case "switch":
            return tuya.modernExtend.dpOnOff(defined({...base, valueOn: ["ON", p.on ?? true], valueOff: ["OFF", p.off ?? false]}));
        case "binary":
            return tuya.modernExtend.dpBinary(defined({...base, name: p.name, valueOn: [true, p.on ?? true], valueOff: [false, p.off ?? false]}));
        case "numeric": {
            const {unit, scale, min: valueMin, max: valueMax, step: valueStep} = p;
            return tuya.modernExtend.dpNumeric(defined({...base, name: p.name, unit, scale, valueMin, valueMax, valueStep}));
        }
        case "enum":
            return tuya.modernExtend.dpEnumLookup(defined({...base, name: p.name, lookup: p.values}));
        case "cover_control": {
            // Значок шторы один на модель (ниже), свой expose у команды не нужен — как dpLight в converters.
            const ext = tuya.modernExtend.dpEnumLookup(defined({...base, name: "state", lookup: p.values ?? {OPEN: 0, STOP: 1, CLOSE: 2}}));
            return {...ext, exposes: []};
        }
        case "cover_position":
            return coverPosition(p, type);
    }
}

// Ключ, под которым Z2M примет команду; две записываемые точки с одним ключом — вторая была бы недоступна.
const setKey = (p) => {
    const name = {switch: "state", cover_control: "state", cover_position: "position"}[p.kind] ?? p.name;
    return p.endpoint ? `${name}_${p.endpoint}` : name;
};

export function buildDefinition(m, seenFingerprints = new Set()) {
    if (!m || typeof m !== "object") throw new Error("модель — не объект");
    for (const key of Object.keys(m)) if (!MODEL_KEYS.includes(key)) throw new Error(`поле «${key}» не бывает у модели`);
    const fingerprint = m.fingerprint;
    const fpOk = (f) => f && typeof f.modelID === "string" && typeof f.manufacturerName === "string" && Object.keys(f).length === 2;
    if (!Array.isArray(fingerprint) || fingerprint.length === 0 || !fingerprint.every(fpOk)) {
        throw new Error("fingerprint — список {modelID, manufacturerName}");
    }
    const fpKeys = fingerprint.map((f) => `${f.modelID}/${f.manufacturerName}`);
    for (const key of fpKeys) if (seenFingerprints.has(key)) throw new Error(`отпечаток ${key} уже описан выше`);
    if (!Array.isArray(m.points) || m.points.length === 0) throw new Error("points — непустой список точек");
    m.points.forEach(checkPoint);
    const writable = new Set();
    for (const p of m.points.filter((x) => !x.read_only)) {
        if (writable.has(setKey(p))) throw new Error(`две записываемые точки отвечают за «${setKey(p)}»`);
        writable.add(setKey(p));
    }

    // tuyaBase — тот же «шлюз», что у описаний converters: магический пакет, версия MCU, ответы на
    // время (1970, как у bms-tuya-service) и статус шлюза. Описание работает и без расширения.
    const extend = [tuya.modernExtend.tuyaBase({timeStart: "1970"}), ...m.points.map(pointExtend)];
    const cover = m.points.filter((p) => p.kind.startsWith("cover_"));
    if (cover.length > 0) {
        const canSet = (kind) => cover.some((p) => p.kind === kind && !p.read_only);
        // Положение по умолчанию ещё и «get», которого у Tuya нет — как в converters, оставляем state+set.
        const expose = exposes.presets.cover_position().setAccess("position", canSet("cover_position") ? exposes.access.STATE_SET : exposes.access.STATE);
        // setAccess бросает исключение, если доступ не меняется, поэтому state трогаем, только когда команды нет.
        if (!canSet("cover_control")) expose.setAccess("state", exposes.access.STATE);
        extend.push({exposes: [expose], isModernExtend: true});
    }
    const definition = {
        fingerprint: fingerprint.map((f) => ({modelID: f.modelID, manufacturerName: f.manufacturerName})),
        model: String(m.model ?? `${fingerprint[0].modelID}_${fingerprint[0].manufacturerName}`),
        vendor: String(m.vendor ?? "Tuya"),
        description: String(m.description ?? "Описание из bms-models.yaml"),
        extend,
    };
    // Многоканальное реле TS0601: все каналы — точки одной конечной точки 1, различаются именами (l1, l2…),
    // как в converters (meta.multiEndpoint + endpoint → 1).
    const endpoints = [...new Set(m.points.map((p) => p.endpoint).filter(Boolean))];
    if (endpoints.length > 0) {
        definition.meta = {multiEndpoint: true};
        definition.endpoint = () => Object.fromEntries(endpoints.map((e) => [e, 1]));
    }
    // Отпечатки считаем занятыми только у принятой модели: исправленный дубль ниже не должен отсекаться.
    for (const key of fpKeys) seenFingerprints.add(key);
    return definition;
}

export function loadDefinitions(url = YAML_URL) {
    let text;
    try {
        text = fs.readFileSync(url, "utf8");
    } catch (error) {
        log(error.code === "ENOENT" ? "info" : "error", `${fileURLToPath(url)}: ${error.code === "ENOENT" ? "файла нет — своих описаний нет" : error.message}`);
        return [];
    }
    let models;
    try {
        models = load(text) ?? [];
    } catch (error) {
        log("error", `bms-models.yaml не читается, описания не добавлены: ${error.message}`);
        return [];
    }
    if (!Array.isArray(models)) {
        log("error", "bms-models.yaml: ожидается список моделей (строки, начинающиеся с «- fingerprint:»)");
        return [];
    }
    const seen = new Set();
    const definitions = [];
    models.forEach((m, i) => {
        try {
            const definition = buildDefinition(m, seen);
            definitions.push(definition);
            log("info", `bms-models.yaml: модель ${definition.model}, точек: ${m.points.length}`);
        } catch (error) {
            // Одна ошибка не должна гасить остальные модели: пропускаем только эту.
            log("error", `bms-models.yaml, модель №${i + 1}${m?.model ? ` (${m.model})` : ""}: ${error.message} — пропущена`);
        }
    });
    return definitions;
}

// Ошибка здесь не бросается наружу: иначе Z2M переименует файл в .invalid (externalJS.ts:219)
// и до перезапуска дополнения не загрузит ни одной модели.
export default loadDefinitions();
