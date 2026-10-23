// Проверки библиотеки точек Tuya. Запуск: npm test  (или node --test "test/*.test.mjs")
//
// Каждая проверка прогнана «в красную»: см. раздел «Что проверено» в README.md и
// мутационные тесты ниже — они ломают копию документа в памяти и требуют, чтобы
// validate() это заметил. Без них пустая или испорченная проверка осталась бы
// зелёной и мы бы об этом не узнали.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {DEFAULT_PATH, isSource, loadLibrary, makeLibrary, validate} from "../library/load.mjs";

const tuyaDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = () => JSON.parse(readFileSync(DEFAULT_PATH, "utf8"));
const clone = (x) => structuredClone(x);

// Первая категория с точкой, у которой есть использование: на ней ломаем копию.
function firstPoint(doc) {
    for (const cat of Object.values(doc.categories)) for (const p of cat.points) if (p.uses.length) return {cat, p};
    throw new Error("в документе нет ни одной точки");
}

test("JSON читается, а набор не пуст", () => {
    const doc = read();
    assert.equal(doc.schema, 1);
    const cats = Object.values(doc.categories);
    // нижняя граница — чтобы пустой или обрезанный файл не прошёл «потому что проверять нечего»
    assert.ok(cats.length >= 50, `категорий слишком мало: ${cats.length}`);
    assert.ok(cats.reduce((a, c) => a + c.points.length, 0) >= 500, "точек слишком мало");
});

test("validate() не находит проблем в настоящем файле", () => {
    assert.deepEqual(validate(read()), []);
});

test("у каждой записи есть источник файл:строка", () => {
    const doc = read();
    let checked = 0;
    const need = (where, s) => {
        for (const x of Array.isArray(s) ? s : [s]) {
            assert.ok(isSource(x), `${where}: плохой источник ${JSON.stringify(x)}`);
            checked++;
        }
    };
    for (const [key, cat] of Object.entries(doc.categories)) {
        for (const d of cat.declared) need(`${key}.declared`, d.source);
        for (const e of cat.entities) need(`${key}.entities`, e.source);
        for (const n of cat.source_notes) need(`${key}.source_notes`, n.source);
        for (const p of cat.points) {
            for (const u of p.uses) {
                need(`${key}.${p.code}.use.source`, u.source);
                need(`${key}.${p.code}.use.category_source`, u.category_source);
            }
            if (p.dp !== null) need(`${key}.${p.code}.dp_source`, p.dp_source);
            if (p.dp_type !== null) need(`${key}.${p.code}.dp_type_source`, p.dp_type_source);
        }
    }
    for (const q of doc.quirks) need(`quirk ${q.id}`, q.sources);
    for (const m of doc.value_maps) need(`value_map ${m.id}`, m.source);
    for (const o of doc.observed_numbers) need(`observed ${o.code}/${o.dp}`, o.sources);
    assert.ok(checked > 3000, `проверено слишком мало источников: ${checked}`);
});

test("коды и номера точек в категории не повторяются", () => {
    const doc = read();
    let withDp = 0;
    for (const [key, cat] of Object.entries(doc.categories)) {
        const codes = new Set();
        const dps = new Map();
        for (const p of cat.points) {
            assert.ok(!codes.has(p.code), `${key}: код ${p.code} повторяется`);
            codes.add(p.code);
            if (p.dp !== null) {
                withDp++;
                assert.ok(!dps.has(p.dp), `${key}: номер ${p.dp} у ${dps.get(p.dp)} и у ${p.code}`);
                dps.set(p.dp, p.code);
            }
        }
    }
    assert.ok(withDp >= 1, "нет ни одной точки с номером: проверка уникальности номеров ничего не проверила");
});

test("номера, которые источник называет прямо", () => {
    const lib = loadLibrary();
    for (const cat of ["dc", "dd", "dj", "hdmipmtbq"]) {
        const p = lib.point(cat, "paint_colour_data");
        assert.equal(p.dp, 61, `${cat}: paint_colour_data`);
        assert.equal(p.dp_type, "Raw");
    }
    // colour_data номером не снабжён: в источнике он зависит от изделия (5 и 24)
    assert.equal(lib.point("dd", "colour_data").dp, null);
});

test("доступ по коду без учёта регистра и по типу сущности", () => {
    const lib = loadLibrary();
    assert.equal(lib.point("cl", "PERCENT_CONTROL")?.code, "percent_control");
    assert.ok(lib.uses("cl", "percent_control", "cover").length >= 1);
    assert.equal(lib.uses("cl", "percent_control", "sensor").length, 0);
    assert.equal(lib.point("cl", "нет_такого"), undefined);
    assert.equal(lib.category("zzz"), undefined);
    assert.ok(lib.quirks("cl", "percent_control").some((q) => q.id === "cover_position_inverted"));
    assert.ok(!lib.quirks("kg", "switch_1").some((q) => q.id === "cover_position_inverted"));
});

test("isSource различает хорошие и плохие ссылки", () => {
    for (const ok of ["README.md:631", "custom_components/bms_integration/light.py:54", "docs/СПРАВОЧНИК.md:43", "tests/test_paint_colour.py:100"]) {
        assert.ok(isSource(ok), ok);
    }
    for (const bad of ["light.py:54", "README.md:0", "README.md", "custom_components/a.py", "custom_components/a.py:x", "", null, undefined, 5]) {
        assert.ok(!isSource(bad), String(bad));
    }
});

// ---- мутационные проверки: каждая поломка обязана быть замечена ----

function expectProblem(mutate, needle) {
    const doc = clone(read());
    mutate(doc);
    const problems = validate(doc);
    assert.ok(problems.some((p) => p.includes(needle)), `ожидалась проблема с «${needle}», получено: ${JSON.stringify(problems.slice(0, 3))}`);
}

test("validate() замечает использование без источника", () => {
    expectProblem((d) => { delete firstPoint(d).p.uses[0].source; }, "источник");
});
test("validate() замечает источник неверного вида", () => {
    expectProblem((d) => { firstPoint(d).p.uses[0].source = "light.py:54"; }, "источник");
});
test("validate() замечает повтор номера в категории", () => {
    expectProblem((d) => {
        const {cat} = firstPoint(d);
        const [a, b] = cat.points;
        for (const x of [a, b]) { x.dp = 7; x.dp_source = ["README.md:1"]; }
    }, "уже занят");
});
test("validate() замечает повтор кода в категории", () => {
    expectProblem((d) => { const {cat, p} = firstPoint(d); cat.points.push(clone(p)); }, "повторяется");
});
test("validate() замечает номер без источника", () => {
    expectProblem((d) => { const {p} = firstPoint(d); p.dp = 9; p.dp_source = null; }, "источник");
});
test("validate() замечает номер вне диапазона точек Tuya", () => {
    expectProblem((d) => { const {p} = firstPoint(d); p.dp = 300; p.dp_source = ["README.md:1"]; }, "вне 1..255");
});
test("validate() замечает ссылку на несуществующую сущность", () => {
    expectProblem((d) => { firstPoint(d).p.uses[0].source = "custom_components/x.py:1"; }, "нет в entities");
});
test("validate() замечает категорию без русского названия", () => {
    expectProblem((d) => { delete firstPoint(d).cat.name_ru; }, "name_ru");
});
test("validate() замечает особенность без источника", () => {
    expectProblem((d) => { d.quirks[0].sources = []; }, "quirks");
});
test("validate() замечает неполный хеш коммита", () => {
    expectProblem((d) => { d.source.commit = "abc"; }, "хеш");
});

test("loadLibrary() отказывается читать битый и негодный файлы", (t) => {
    const base = join(tuyaDir, ".work");
    mkdirSync(base, {recursive: true});
    const dir = mkdtempSync(join(base, "t-"));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ не json");
    assert.throws(() => loadLibrary(broken), /не удалось прочитать/);

    const doc = clone(read());
    delete firstPoint(doc).p.uses[0].source;
    const invalid = join(dir, "invalid.json");
    writeFileSync(invalid, JSON.stringify(doc));
    assert.throws(() => loadLibrary(invalid), /проблем/);

    assert.throws(() => loadLibrary(join(dir, "нет-такого.json")), /не удалось прочитать/);
    assert.ok(makeLibrary(read()).categoryCodes().length >= 50);
});
