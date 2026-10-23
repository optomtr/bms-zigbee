// Загрузчик библиотеки точек Tuya (categories.json). Без зависимостей, Node 22.
//
// Зачем отдельная проверка validate(), а не просто JSON.parse: файл собирается
// скриптом из чужого репозитория и правится руками в двух ручных таблицах. Любая
// ошибка в нём молча превратилась бы в неверную настройку устройства, поэтому
// загрузчик отказывается отдавать данные, в которых у записи нет источника, номера
// точек повторяются или ссылка записи указывает в никуда.
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

export const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), "categories.json");

// «файл:строка» в репозитории BMS Integration; пути только из тех каталогов, которые
// извлекатель кладёт в снимок (extract_bms.py, ARCHIVE_PATHS).
const SOURCE_RE = /^(?:(?:custom_components|tests|docs)\/[^\s:]+|README\.md|CLAUDE\.md):[1-9]\d*$/;

export function isSource(s) {
    return typeof s === "string" && SOURCE_RE.test(s);
}

const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/**
 * Проверяет документ и возвращает список проблем (пустой список — документ годен).
 * Не бросает исключений: тесты хотят видеть, ЧТО именно сломано.
 */
export function validate(doc) {
    const problems = [];
    const bad = (where, what) => problems.push(`${where}: ${what}`);
    const needSource = (where, s) => {
        const list = asList(s);
        if (list.length === 0) bad(where, "нет источника");
        for (const x of list) if (!isSource(x)) bad(where, `некорректный источник ${JSON.stringify(x)}`);
    };

    if (doc?.schema !== 1) bad("schema", `ожидалась 1, получено ${JSON.stringify(doc?.schema)}`);
    if (!doc?.source?.commit || !/^[0-9a-f]{40}$/.test(doc.source.commit)) bad("source.commit", "нет полного хеша коммита");
    if (!doc || typeof doc.categories !== "object" || doc.categories === null) {
        bad("categories", "нет раздела");
        return problems;
    }

    for (const [key, cat] of Object.entries(doc.categories)) {
        const c = `categories.${key}`;
        if (cat.category !== key) bad(c, `поле category=${cat.category} не равно ключу`);
        if (!cat.name_ru || typeof cat.name_ru !== "string") bad(c, "нет name_ru");
        if (!Array.isArray(cat.declared) || cat.declared.length === 0) bad(c, "нет declared");
        for (const d of cat.declared ?? []) needSource(`${c}.declared`, d.source);
        if (cat.name_en !== null && cat.name_en !== undefined) needSource(`${c}.name_en_source`, cat.name_en_source);
        if (cat.tuya_doc) needSource(`${c}.tuya_doc_source`, cat.tuya_doc_source);
        for (const n of cat.source_notes ?? []) needSource(`${c}.source_notes`, n.source);

        // Сущности: на них ссылаются использования точек.
        const entityRoles = new Map(); // "platform|source" -> roles
        for (const e of cat.entities ?? []) {
            needSource(`${c}.entities`, e.source);
            entityRoles.set(`${e.platform}|${e.source}`, e.roles ?? {});
        }

        const codes = new Set();
        const dps = new Map();
        for (const p of cat.points ?? []) {
            const w = `${c}.points[${p.code}]`;
            if (typeof p.code !== "string" || p.code === "") bad(c, "точка без кода");
            if (codes.has(p.code)) bad(w, "код точки повторяется в категории");
            codes.add(p.code);

            if (p.dp !== null && p.dp !== undefined) {
                if (!Number.isInteger(p.dp) || p.dp < 1 || p.dp > 255) bad(w, `номер ${p.dp} вне 1..255`);
                if (dps.has(p.dp)) bad(w, `номер ${p.dp} уже занят точкой ${dps.get(p.dp)}`);
                dps.set(p.dp, p.code);
                needSource(`${w}.dp_source`, p.dp_source);
            } else if (p.dp_source) {
                bad(w, "dp_source есть, а номера нет");
            }
            if (p.dp_type !== null && p.dp_type !== undefined) needSource(`${w}.dp_type_source`, p.dp_type_source);

            if (!Array.isArray(p.uses) || p.uses.length === 0) bad(w, "точка без использований: откуда она тогда взялась");
            for (const u of p.uses ?? []) {
                const uw = `${w}.uses`;
                needSource(`${uw}.source`, u.source);
                needSource(`${uw}.category_source`, u.category_source);
                const roles = entityRoles.get(`${u.platform}|${u.source}`);
                if (!roles) bad(uw, `сущности ${u.platform}|${u.source} нет в entities категории`);
                else if (!(roles[u.role] ?? []).includes(p.code)) bad(uw, `роль ${u.role} сущности ${u.source} не содержит код ${p.code}`);
                if (u.alternatives && !u.alternatives.includes(p.code)) bad(uw, "alternatives не содержит собственный код");
            }
        }
        // Обратная связь: каждый код из ролей сущности обязан быть точкой категории.
        for (const e of cat.entities ?? []) {
            for (const [role, list] of Object.entries(e.roles ?? {})) {
                for (const code of list) if (!codes.has(code)) bad(`${c}.entities[${e.source}]`, `код ${code} роли ${role} не оформлен точкой`);
            }
        }
    }

    for (const q of doc.quirks ?? []) {
        if (!q.id || !q.text) bad("quirks", "особенность без id или текста");
        needSource(`quirks[${q.id}]`, q.sources);
    }
    for (const o of doc.observed_numbers ?? []) needSource(`observed_numbers[${o.code}/${o.dp}]`, o.sources);
    for (const m of doc.value_maps ?? []) needSource(`value_maps[${m.id}]`, m.source);
    return problems;
}

/** Читает файл, проверяет и возвращает «библиотеку» с короткими методами доступа. */
export function loadLibrary(path = DEFAULT_PATH) {
    let doc;
    try {
        doc = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
        throw new Error(`библиотека точек Tuya: не удалось прочитать ${path}: ${err.message}`);
    }
    const problems = validate(doc);
    if (problems.length) {
        throw new Error(`библиотека точек Tuya: ${problems.length} проблем(ы), первые:\n  ` + problems.slice(0, 10).join("\n  "));
    }
    return makeLibrary(doc);
}

export function makeLibrary(doc) {
    const categories = doc.categories;
    return {
        doc,
        /** коды категорий Tuya, известные библиотеке */
        categoryCodes: () => Object.keys(categories),
        /** запись категории или undefined */
        category: (code) => categories[code],
        /** точка категории по коду (регистр не важен: так сопоставляет и сама автонастройка BMS) */
        point(categoryCode, pointCode) {
            const want = String(pointCode).toLowerCase();
            return categories[categoryCode]?.points.find((p) => p.code.toLowerCase() === want);
        },
        /** все использования точки в сущностях HA заданного типа */
        uses(categoryCode, pointCode, platform) {
            const p = this.point(categoryCode, pointCode);
            return (p?.uses ?? []).filter((u) => !platform || u.platform === platform);
        },
        /** особенности, относящиеся к категории и/или коду (без ограничений в applies_to — общие) */
        quirks(categoryCode, pointCode) {
            return (doc.quirks ?? []).filter((q) => {
                const a = q.applies_to ?? {};
                const cats = a.categories ?? [];
                const codes = a.codes ?? [];
                // пустой список в applies_to значит «без ограничения по этому признаку»
                const catOk = !cats.length || !categoryCode || cats.includes(categoryCode);
                const codeOk = !codes.length || !pointCode || codes.includes(pointCode);
                return catOk && codeOk;
            });
        },
    };
}
