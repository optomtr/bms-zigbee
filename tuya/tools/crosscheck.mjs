#!/usr/bin/env node
// Строит library/crosscheck.md: сверка библиотеки (categories.json) с моделями
// zigbee-herdsman-converters по списку из crosscheck_spec.json.
//
// Что делает сам скрипт, а что человек: соответствие «свойство Z2M <-> код библиотеки»
// (поле lib в спеке) — суждение человека. Всё остальное считает скрипт: номер точки и
// строку берёт из разбора tuya.ts (scan_converters.mjs), значения и масштаб — из
// конвертеров и из библиотеки, а цитаты в спеке проверяет по исходникам. Любая
// неувязка (нет такого номера у модели, нет такого кода в библиотеке, цитата не на
// своей строке) — ошибка, а не молчаливая строка в отчёте.
//
// Запуск (из каталога tuya):
//   node tools/crosscheck.mjs --src .work/converters-src/zigbee-herdsman-converters-26.115.1 \
//        --scan .work/scan.json --bms .work/bms-main --out library/crosscheck.md
import {readFileSync, writeFileSync} from "node:fs";
import {basename, join} from "node:path";
import {parseArgs} from "node:util";
import {fileURLToPath} from "node:url";
import {dirname} from "node:path";
import {proseHead, proseTail} from "./crosscheck_prose.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const {values: args} = parseArgs({
    options: {
        src: {type: "string"},
        scan: {type: "string"},
        bms: {type: "string"},
        lib: {type: "string", default: join(here, "../library/categories.json")},
        spec: {type: "string", default: join(here, "crosscheck_spec.json")},
        out: {type: "string"},
    },
});
for (const k of ["src", "scan", "bms", "out"]) if (!args[k]) throw new Error(`нужен --${k}`);

const lib = JSON.parse(readFileSync(args.lib, "utf8"));
const spec = JSON.parse(readFileSync(args.spec, "utf8"));
const scan = JSON.parse(readFileSync(args.scan, "utf8"));
const versions = JSON.parse(readFileSync(join(here, "../../versions.json"), "utf8"));

const lineCache = new Map();
function lineAt(root, file, line) {
    const key = join(root, file);
    if (!lineCache.has(key)) lineCache.set(key, readFileSync(key, "utf8").split("\n"));
    return lineCache.get(key)[line - 1] ?? "";
}
function mustQuote(root, file, line, quote, who) {
    if (!lineAt(root, file, line).includes(quote)) throw new Error(`${who}: цитата ${JSON.stringify(quote)} не на ${file}:${line}`);
}
const F = spec.files;
const ref = (file, line) => `${F[file] ?? file}:${line}`;

// ---------- библиотека ----------
function libPoint(cat, code) {
    const c = lib.categories[cat];
    if (!c) throw new Error(`нет категории ${cat}`);
    const p = c.points.find((x) => x.code === code);
    if (!p) throw new Error(`в категории ${cat} нет кода ${code}`);
    return p;
}
const srcShort = (s) => basename(s.split(":")[0]) + ":" + s.split(":")[1];

function libValueSets(cat, codes, kind) {
    const out = []; // {label, set:Set<string>, numeric:boolean}
    for (const code of codes) {
        for (const u of libPoint(cat, code).uses) {
            let vals = null;
            if (kind === "hvac_mode" && u.role === "hvac_mode_dp" && u.value_map) vals = Object.values(u.value_map).map(String);
            else if (kind === "hvac_action" && u.role === "hvac_action_dp" && u.value_map) vals = Object.values(u.value_map).map(String);
            else if (kind === "state_on" && u.config?.state_on !== undefined) vals = [String(u.config.state_on)];
            else if (kind === "enum" && u.enum_map) vals = Object.keys(u.enum_map);
            else if (kind === "enum" && u.enum_list) vals = u.enum_list;
            if (vals) out.push({label: `${code} ${srcShort(u.source)}`, set: new Set(vals.map((v) => v.toLowerCase())), raw: vals});
        }
    }
    // одинаковые наборы из разных мест сворачиваем
    const seen = new Set();
    return out.filter((v) => {
        const k = [...v.set].sort().join("|");
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

function libField(cat, codes, field) {
    const res = [];
    for (const code of codes) {
        const v = libPoint(cat, code).uses.find((u) => u[field] !== undefined);
        if (v) res.push({code, value: v[field], src: srcShort(v.source)});
    }
    return res;
}

// ---------- converters ----------
function z2mValuesFromConv(conv) {
    const m = /lookup\(\s*\{([\s\S]*?)\}\s*\)/.exec(conv);
    if (!m) return null;
    const out = {};
    for (const p of m[1].matchAll(/(\w+)\s*:\s*(?:tuya\.)?(?:new\s+)?(?:enum|Enum)?\(?\s*(\d+|true|false)\s*\)?/g)) out[p[1]] = p[2];
    return Object.keys(out).length ? out : null;
}
function z2mFactor(conv) {
    let m = /divideBy\(?(\d+)\)?/.exec(conv);
    if (m) return 1 / Number(m[1]);
    if (/\bvalueConverter\.raw\b|\braw\b/.test(conv)) return 1;
    return null;
}

const defByModel = new Map(scan.definitions.map((d) => [d.model, d]));
const rowsOut = [];
const tally = {meaning: {}, number: {}, values: {}, scale: {}};
const bump = (t, k) => (tally[t][k] = (tally[t][k] ?? 0) + 1);

for (const m of spec.models) {
    const def = defByModel.get(m.model);
    if (!def) throw new Error(`нет модели ${m.model}`);
    const nMf = new Set([...def.fingerprints.map((f) => f.manufacturerName), ...def.whitelabel.flatMap((w) => w.manufacturerNames)]).size;
    const block = {m, def, nMf, rows: []};
    for (const r of m.rows) {
        const who = `${m.model}/${r.z2m}#${r.dp}`;
        // --- сторона Z2M
        let z;
        if (r.legacy) {
            mustQuote(args.src, F[r.legacy.file], r.legacy.line, r.legacy.quote, who);
            z = {ref: ref(r.legacy.file, r.legacy.line), conv: r.legacy.conv};
        } else {
            const dp = def.datapoints.find((p) => p.dp === r.dp && p.name === r.z2m);
            if (!dp) throw new Error(`${who}: у модели нет точки ${r.dp}/${r.z2m}`);
            z = {ref: `${F.tuya}:${dp.line}`, conv: dp.conv};
        }
        for (const c of r.checks ?? []) mustQuote(c.root === "bms" ? args.bms : args.src, c.file, c.line, c.quote, `${who} (ссылка в примечании)`);
        // --- сторона библиотеки
        const libCells = r.lib.map((c) => {
            const p = libPoint(m.category, c);
            return `${c} (${[...new Set(p.uses.map((u) => u.platform))].join("/")}, ${srcShort(p.uses[0].source)})`;
        });
        const meaning = r.lib.length ? "совпало" : "нет пары";
        bump("meaning", meaning);
        // --- номер
        let number = "в библиотеке номера нет";
        const libDp = r.lib.map((c) => libPoint(m.category, c).dp).find((d) => d !== null && d !== undefined);
        if (libDp !== undefined) number = libDp === r.dp ? `совпало (${libDp})` : `не совпало (библиотека ${libDp}, модель ${r.dp})`;
        if (r.claim) {
            mustQuote(args.bms, r.claim.source.split(":")[0], Number(r.claim.source.split(":")[1]), r.claim.quote, who);
            const ok = r.claim.dp === r.dp;
            number = `справочник BMS «${r.claim.what}» ${ok ? "совпал" : `не совпал (у модели DP ${r.dp})`}`;
            bump("number", ok ? "справочник совпал" : "справочник не совпал");
        } else if (libDp !== undefined) {
            bump("number", libDp === r.dp ? "библиотека совпала" : "библиотека не совпала");
        } else {
            bump("number", "нечем сравнить");
        }
        // --- значения
        let values = "";
        if (r.enum || r.enumRaw) {
            let zv;
            if (r.enum && typeof r.enum === "object") {
                mustQuote(args.src, F[r.enum.file], r.enum.line, r.enum.quote, who);
                zv = r.enum.values;
            } else {
                zv = z2mValuesFromConv(z.conv);
                if (!zv) throw new Error(`${who}: не разобрал значения из ${z.conv}`);
            }
            const zset = new Set(Object.keys(zv).map((v) => v.toLowerCase()));
            const zText = Object.entries(zv).map(([k, v]) => `${k}=${v}`).join(", ");
            const vs = r.libValues ? libValueSets(m.category, r.lib, r.libValues) : [];
            if (!vs.length) {
                values = `Z2M: ${zText}; в библиотеке списка значений нет`;
                bump("values", "нечем сравнить");
            } else {
                const eq = vs.find((v) => v.set.size === zset.size && [...v.set].every((x) => zset.has(x)));
                const lt = vs.map((v) => `${v.label}: ${v.raw.join("/")}`).join("; ");
                let verdict = r.valuesJudgement;
                if (eq && !verdict) verdict = "имена совпали";
                // Автоматика видит только имена. Расхождение имён без оценки человека — ошибка:
                // иначе «не совпало» молча смешало бы разный смысл и просто другие слова.
                if (!verdict) throw new Error(`${who}: имена значений разные, нужна valuesJudgement в спеке`);
                values = `Z2M: ${zText}; библиотека: ${lt} - **${verdict}**${r.valuesWhy ? ` (${r.valuesWhy})` : ""}`;
                bump("values", verdict);
            }
        }
        // --- масштаб
        let scale = "";
        if (r.scale) {
            const zf = r.scale.z2mRange ?? z2mFactor(z.conv);
            const fields = libField(m.category, r.lib, r.scale.libField);
            if (zf === null || !fields.length) {
                scale = "нечем сравнить";
                bump("scale", "нечем сравнить");
            } else {
                const parts = fields.map((f) => `${f.code}.${r.scale.libField} = ${f.value} (${f.src})`);
                const okAll = fields.every((f) => Math.abs(Number(f.value) - zf) < 1e-9);
                const okAny = fields.some((f) => Math.abs(Number(f.value) - zf) < 1e-9);
                const word = okAll ? "совпало" : okAny ? "частично" : "не совпало";
                scale = `${r.scale.z2mRange ? "диапазон" : "множитель"} Z2M ${zf}; ${parts.join("; ")} - ${word}`;
                bump("scale", word);
            }
        }
        block.rows.push({r, z, libCells, meaning, number, values, scale});
    }
    rowsOut.push(block);
}

// ---------- разброс номеров в converters ----------
const withDp = scan.definitions.filter((d) => d.datapoints.length);
function spread(name) {
    const per = new Map(); // dp -> Set(model)
    for (const d of withDp) for (const p of d.datapoints) if (p.name === name) {
        if (!per.has(p.dp)) per.set(p.dp, new Set());
        per.get(p.dp).add(d.model);
    }
    const total = new Set([...per.values()].flatMap((s) => [...s])).size;
    const top = [...per.entries()].sort((a, b) => b[1].size - a[1].size);
    return {total, kinds: per.size, top: top.slice(0, 4).map(([dp, s]) => `${dp} (${s.size})`).join(", "), share: top.length ? Math.round((100 * top[0][1].size) / total) : 0, topDp: top[0]?.[0]};
}
const spreadNames = ["battery", "state_l1", "position", "temperature", "humidity", "current_heating_setpoint", "local_temperature", "child_lock"];
const spreadRows = spreadNames.map((n) => ({n, ...spread(n)}));
function meaningsOfDp(dp) {
    const per = new Map();
    for (const d of withDp) for (const p of d.datapoints) if (p.dp === dp && p.name) per.set(p.name, (per.get(p.name) ?? new Set()).add(d.model));
    const top = [...per.entries()].sort((a, b) => b[1].size - a[1].size);
    return {kinds: per.size, top: top.slice(0, 6).map(([n, s]) => `${n} (${s.size})`).join(", ")};
}
const dpMeanings = [1, 2, 3, 4, 5].map((dp) => ({dp, ...meaningsOfDp(dp)}));

function convKind(conv) {
    if (/divideBy\(?10\b/.test(conv)) return "divideBy10";
    if (/divideBy\(?100\b/.test(conv)) return "divideBy100";
    if (/divideBy\(?1000\b/.test(conv)) return "divideBy1000";
    if (/\braw\b/.test(conv)) return "raw";
    return "другой";
}
const scaleStats = ["current_heating_setpoint", "local_temperature", "temperature", "humidity"].map((n) => {
    const models = new Map();
    for (const d of withDp) {
        const p = d.datapoints.find((x) => x.name === n);
        if (p) models.set(d.model, convKind(p.conv));
    }
    const cnt = {};
    for (const k of models.values()) cnt[k] = (cnt[k] ?? 0) + 1;
    return {n, total: models.size, cnt};
});

// ---------- отпечатки: восемь знаков ----------
const printsAll = scan.definitions.flatMap((d) => d.fingerprints.map((f) => ({...f, model: d.model})))
    .concat(scan.definitions.flatMap((d) => d.whitelabel.flatMap((w) => w.manufacturerNames.map((n) => ({modelID: "", manufacturerName: n, model: d.model, line: d.modelLine})))));
const sufMap = new Map();
for (const f of printsAll) {
    const m = /^(_T[A-Z0-9]+)_([a-z0-9]{8})$/.exec(f.manufacturerName);
    if (!m) continue;
    const key = m[2];
    if (!sufMap.has(key)) sufMap.set(key, {prefixes: new Set(), models: new Set()});
    sufMap.get(key).prefixes.add(m[1]);
    sufMap.get(key).models.add(f.model);
}
const sufTotal = sufMap.size;
const sufMulti = [...sufMap.entries()].filter(([, v]) => v.prefixes.size > 1);
const sufMultiModels = sufMulti.filter(([, v]) => v.models.size > 1).length;
const suffixStats = {sufTotal, multi: sufMulti.length, multiModels: sufMultiModels, example: sufMulti[0], cross: sufMulti.find(([, v]) => v.models.size > 1)};

const ctx = {versions, lib, args, rowsOut, tally, spreadRows, dpMeanings, scaleStats, suffixStats, scan, withDp, srcShort, F};
const md = proseHead(ctx) + renderTables(rowsOut) + proseTail(ctx);
writeFileSync(args.out, md);
console.log(`записано ${args.out}: моделей ${rowsOut.length}, строк ${rowsOut.reduce((a, b) => a + b.rows.length, 0)}`);
console.log(JSON.stringify(tally));

function renderTables(blocks) {
    let out = "";
    let group = "";
    for (const b of blocks) {
        if (b.m.group !== group) {
            group = b.m.group;
            out += `\n## ${group}\n`;
        }
        const cat = lib.categories[b.m.category];
        out += `\n### ${b.m.model} ↔ категория \`${b.m.category}\` (${cat.name_ru})\n\n`;
        out += `${b.m.why}. Определение: \`${F.tuya}:${b.def.modelLine}\`; производителей в отпечатках: ${b.nMf}.\n\n`;
        out += "| Z2M | DP | Строка / конвертер | Библиотека | Смысл | Номер | Значения | Масштаб |\n|---|---|---|---|---|---|---|---|\n";
        for (const x of b.rows) {
            const note = x.r.note ? `<br><sub>${x.r.note}</sub>` : "";
            out += `| ${x.r.z2m} | ${x.r.dp} | \`${x.z.ref}\`<br>\`${x.z.conv.replace(/\|/g, "\\|").slice(0, 90)}\` | ${x.libCells.length ? x.libCells.join("<br>") : "—"} | ${x.meaning} | ${x.number} | ${x.values || "—"} | ${x.scale || "—"}${note} |\n`;
        }
    }
    return out;
}
