#!/usr/bin/env node
// Читает src/devices/tuya.ts из zigbee-herdsman-converters и выписывает по каждому
// определению: модель, отпечатки (modelID + manufacturerName), точки данных
// (номер, имя в Z2M, текст конвертера) — каждая со строкой файла.
//
// Почему разбор текста, а не импорт собранного пакета: чтобы собрать dist/, нужен
// zigbee-herdsman со всеми его зависимостями, а нам нужны именно СТРОКИ исходника
// (в отчёте сверки на них ссылаемся). Структура файла регулярна: элементы массива
// definitions лежат на отступе в 4 пробела, точки данных — строки вида
// [номер, "имя", конвертер]. Если разбор что-то не поймёт, оно попадёт в warnings,
// а не потеряется молча.
//
// Запуск: node tools/scan_converters.mjs <корень converters> > scan.json
import {readFileSync} from "node:fs";
import {join} from "node:path";

const root = process.argv[2];
if (!root) {
    console.error("укажи корень zigbee-herdsman-converters");
    process.exit(2);
}
const file = "src/devices/tuya.ts";
const text = readFileSync(join(root, file), "utf8");

// Позиция -> номер строки (1-based), чтобы не считать \n на каждый вызов.
const lineStarts = [0];
for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
function lineOf(pos) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= pos) lo = mid;
        else hi = mid - 1;
    }
    return lo + 1;
}

// Находит конец скобочной группы, начинающейся в pos (text[pos] — открывающая скобка),
// пропуская строки и комментарии, в которых скобки не считаются.
function matchClose(pos) {
    const open = text[pos];
    const pairs = {"[": "]", "{": "}", "(": ")"};
    const stack = [pairs[open]];
    let i = pos + 1;
    while (i < text.length && stack.length) {
        const c = text[i];
        const n = text[i + 1];
        if (c === "/" && n === "/") {
            while (i < text.length && text[i] !== "\n") i++;
        } else if (c === "/" && n === "*") {
            i = text.indexOf("*/", i + 2) + 2;
        } else if (c === '"' || c === "'" || c === "`") {
            i++;
            while (i < text.length && text[i] !== c) {
                if (text[i] === "\\") i++;
                i++;
            }
            i++;
        } else if (pairs[c]) {
            stack.push(pairs[c]);
            i++;
        } else if (c === stack[stack.length - 1]) {
            stack.pop();
            i++;
        } else {
            i++;
        }
    }
    return i; // позиция сразу за закрывающей скобкой
}

const warnings = [];
const arrayStart = text.indexOf("export const definitions");
if (arrayStart < 0) throw new Error("не нашёл export const definitions");
const arrOpen = text.indexOf("[", text.indexOf("=", arrayStart));
const arrClose = matchClose(arrOpen);

// Элементы массива: объекты верхнего уровня.
const defs = [];
for (let i = arrOpen + 1; i < arrClose; i++) {
    const c = text[i];
    if (c === "{") {
        const end = matchClose(i);
        defs.push({start: i, end});
        i = end - 1;
    } else if (c === "/" && text[i + 1] === "/") {
        while (i < arrClose && text[i] !== "\n") i++;
    }
}

function strings(s) {
    return [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

function parseDatapoints(seg, segOffset) {
    const out = [];
    const m = /tuyaDatapoints\s*:\s*\[/.exec(seg);
    if (!m) return out;
    const open = segOffset + m.index + m[0].length - 1;
    const close = matchClose(open);
    for (let i = open + 1; i < close - 1; i++) {
        const c = text[i];
        if (c === "[") {
            const end = matchClose(i);
            const body = text.slice(i + 1, end - 1);
            // имя бывает null: точка принимается устройством, но Z2M её не публикует
            const head = /^\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*(?:"([^"]*)"|null)\s*,?([\s\S]*)$/.exec(body);
            if (head) {
                out.push({
                    dp: Number(head[1]),
                    name: head[2] ?? null,
                    conv: head[3].replace(/\s+/g, " ").trim().slice(0, 240),
                    line: lineOf(i),
                });
            } else {
                warnings.push(`${file}:${lineOf(i)}: не разобрал точку: ${body.slice(0, 60).replace(/\s+/g, " ")}`);
            }
            i = end - 1;
        } else if (c === "/" && text[i + 1] === "/") {
            while (i < close && text[i] !== "\n") i++;
        }
    }
    return out;
}

const result = [];
for (const d of defs) {
    const seg = text.slice(d.start, d.end);
    const model = /\bmodel:\s*"([^"]+)"/.exec(seg);
    if (!model) continue; // вспомогательные объекты внутри массива
    const prints = [];
    // tuya.fingerprint("TS0601", ["_TZE200_a", "_TZE200_b"])
    for (const m of seg.matchAll(/tuya\.fingerprint\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*\[/g)) {
        const open = d.start + m.index + m[0].length - 1;
        const close = matchClose(open);
        const body = text.slice(open, close);
        for (const name of strings(body)) prints.push({modelID: m[1], manufacturerName: name, line: lineOf(open + body.indexOf(`"${name}"`))});
    }
    // {modelID: "TS0601", manufacturerName: "_TZE200_x"}
    for (const m of seg.matchAll(/modelID:\s*"([^"]+)"\s*,\s*manufacturerName:\s*"([^"]+)"/g)) {
        prints.push({modelID: m[1], manufacturerName: m[2], line: lineOf(d.start + m.index)});
    }
    // tuya.whitelabel("Вендор", "Модель", "Описание", ["_TZE200_x"])
    const white = [];
    for (const m of seg.matchAll(/tuya\.whitelabel\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*\[/g)) {
        const open = d.start + m.index + m[0].length - 1;
        const body = text.slice(open, matchClose(open));
        white.push({vendor: m[1], model: m[2], manufacturerNames: strings(body)});
    }
    result.push({
        model: model[1],
        modelLine: lineOf(d.start + model.index),
        startLine: lineOf(d.start),
        endLine: lineOf(d.end),
        description: (/\bdescription:\s*"([^"]*)"/.exec(seg) || [])[1] || null,
        fingerprints: prints,
        whitelabel: white,
        legacyFromZigbee: [...seg.matchAll(/legacy\.fromZigbee\.(\w+)/g)].map((m) => m[1]),
        legacyToZigbee: [...seg.matchAll(/legacy\.toZigbee\.(\w+)/g)].map((m) => m[1]),
        datapoints: parseDatapoints(seg, d.start),
    });
}

console.log(JSON.stringify({file, definitions: result, warnings}, null, 1));
