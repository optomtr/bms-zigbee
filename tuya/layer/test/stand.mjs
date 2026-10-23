// Общее для проверок слоя: стенд Z2M (tools/stand.sh), папка данных как у дополнения, подставные устройства.
import fs from "node:fs";
import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

export const LAYER = path.resolve(fileURLToPath(import.meta.url), "../..");
export const WORK = path.resolve(LAYER, "../.work");
export const Z2M = path.join(WORK, "z2m-app");
if (!fs.existsSync(path.join(Z2M, "dist/controller.js"))) {
    throw new Error(`Нет стенда Z2M в ${Z2M}: запустите tuya/layer/tools/stand.sh`);
}
// converters берём из стенда: тот же экземпляр модулей, что получат наши файлы через ссылку node_modules.
export const requireZ2M = createRequire(path.join(Z2M, "package.json"));
export const zhc = requireZ2M("zigbee-herdsman-converters");
export const tuya = requireZ2M("zigbee-herdsman-converters/lib/tuya");

/**
 * Папка данных как у дополнения: в external_* — только bms-* верхнего уровня (так копирует entrypoint).
 * withNodeModules — положить ссылку node_modules самим (без Z2M); при запуске настоящего Z2M её делает он.
 */
const dataDirs = [];
// Папки данных убираем по выходу; BMS_KEEP=1 — оставить, чтобы посмотреть, что положил Z2M.
process.on("exit", () => process.env.BMS_KEEP || dataDirs.forEach((d) => fs.rmSync(d, {recursive: true, force: true})));

export function makeDataDir({yaml, withNodeModules = true} = {}) {
    const dir = fs.mkdtempSync(path.join(WORK, "test-data-"));
    dataDirs.push(dir);
    for (const kind of ["external_converters", "external_extensions"]) {
        fs.mkdirSync(path.join(dir, kind));
        for (const name of fs.readdirSync(path.join(LAYER, kind)).filter((n) => n.startsWith("bms-"))) {
            fs.cpSync(path.join(LAYER, kind, name), path.join(dir, kind, name), {recursive: true});
        }
        if (withNodeModules) fs.symlinkSync(path.join(Z2M, "node_modules"), path.join(dir, kind, "node_modules"), "dir");
    }
    if (yaml !== undefined) fs.writeFileSync(path.join(dir, "bms-models.yaml"), yaml);
    return dir;
}

export const importLayer = (dir, kind, name) => import(pathToFileURL(path.join(dir, kind, name)).href);

/** Журнал converters в память: туда пишет bms-models.mjs (и converters при ошибках отправки). */
export function captureZhcLog() {
    const lines = [];
    const at = (level) => (msg, ns) => lines.push({level, ns, msg: typeof msg === "function" ? msg() : msg});
    zhc.setLogger({debug: at("debug"), info: at("info"), warning: at("warning"), error: at("error")});
    return lines;
}

// Имена классов важны: converters различают сущности по constructor.name (utils.isDevice / isEndpoint).
export class Endpoint {
    constructor(device, ID = 1) {
        this.ID = ID;
        this.deviceIeeeAddress = device.ieeeAddr;
        this.sent = [];
        this.reads = [];
    }
    async command(cluster, command, payload) {
        this.sent.push({cluster, command, payload});
    }
    async read(cluster, attributes) {
        this.reads.push({cluster, attributes});
        return {};
    }
    getInputClusters() {
        return [];
    }
    getOutputClusters() {
        return [];
    }
}

export class Device {
    constructor({ieeeAddr, manufacturerName, modelID = "TS0601", type = "EndDevice"}) {
        Object.assign(this, {ieeeAddr, manufacturerName, modelID, type, interviewState: "SUCCESSFUL", meta: {}, customClusters: {}});
        this.endpoints = [new Endpoint(this)];
    }
    getEndpoint(ID) {
        return this.endpoints.find((e) => e.ID === ID);
    }
    addCustomCluster() {}
    save() {}
}

let ieee = 0;
/** Устройство так, как его видит расширение Z2M (lib/model/device.ts): zh, definition, options, isSupported. */
export async function z2mDevice(manufacturerName, {modelID = "TS0601", options = {}, definition} = {}) {
    const zh = new Device({ieeeAddr: `0x00000000000000${(++ieee).toString(16).padStart(2, "0")}`, manufacturerName, modelID});
    const def = definition === undefined ? await zhc.findByDevice(zh, true) : definition;
    return {
        zh,
        definition: def,
        options,
        name: `dev${ieee}`,
        isSupported: Boolean(def && !def.generated),
        interviewed: true,
        isDevice: () => true,
    };
}

/** Шина событий с подпиской как у Z2M (lib/eventBus.ts) — только то, что берёт расширение. */
export function fakeBus() {
    const h = {};
    const on = (event) => (key, cb) => {
        h[event] = cb;
    };
    return {
        h,
        onDeviceMessage: on("deviceMessage"),
        onDeviceInterview: on("deviceInterview"),
        onDeviceAnnounce: on("deviceAnnounce"),
        onMQTTMessage: on("mqttMessage"),
        removeListeners: () => {
            for (const k of Object.keys(h)) delete h[k];
        },
    };
}

export function fakeLogger() {
    const lines = [];
    const at = (level) => (msg) => lines.push({level, msg});
    return {lines, debug: at("debug"), info: at("info"), warning: at("warning"), error: at("error")};
}

/** Пачка точек Tuya так, как её разбирает zigbee-herdsman (LIST_TUYA_DATAPOINT_VALUES): data — Buffer. */
export const dpv = (dp, datatype, bytes) => ({dp, datatype, data: Buffer.from(bytes)});
