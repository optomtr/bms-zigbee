#!/usr/bin/env python3
"""Достаёт из BMS Integration пресеты «категория Tuya -> точки данных» в categories.json.

Почему скрипт, а не ручной перенос: пресеты BMS Integration — около полутора тысяч
описаний сущностей на Python (core/ha_entities/*.py). Переписанные руками, они
разошлись бы с источником уже на второй правке. Скрипт исполняет сами файлы
пресетов и берёт значения у них; номер строки каждой сущности ловится в момент её
создания (а не ищется по тексту), поэтому ссылка «файл:строка» не может быть
ошибочной. Как именно читается main и чем заменён Home Assistant — см. bms_load.py.

Чего скрипт НЕ делает: не придумывает. Если пресет не называет номер точки, тип или
диапазон — в JSON стоит null или поля нет. Исключение — ручные таблицы в
bms_tables.py (номера, особенности, русские названия): каждая запись там несёт
источник и дословную цитату, а скрипт сверяет, что цитата стоит на этой строке
снимка main. Русское название категории — перевод английской подписи из источника
и помечено как перевод.

Запуск:  python3 -I tuya/tools/extract_bms.py            пишет tuya/library/categories.json
         python3 -I tuya/tools/extract_bms.py --check    только сверяет с файлом на диске
         python3 -I tuya/tools/extract_bms.py --names    печатает коды и английские подписи
"""

import argparse
import ast
import json
import os
import re
import sys
from collections import Counter, OrderedDict
from enum import Enum
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from bms_format import CONVENTIONS, dumps  # noqa: E402
from bms_load import Loaded, Sym, module_assign_lines, split_label  # noqa: E402
from bms_tables import (  # noqa: E402
    CATEGORY_RU, ENT_ROOT, FIELD_OF_KEY, INT_ROOT, KNOWN_DP_NUMBERS, NUMERIC_FIELDS,
    OBSERVED_NUMBERS, QUIRKS,
)

TUYA_DIR = Path(__file__).resolve().parent.parent
# Локальная копия BMS Integration (github.com/optomtr/bmsintegration): путь берём из окружения,
# чтобы в репозитории не было путей конкретного компьютера.
DEFAULT_REPO = Path(os.environ.get("BMS_INTEGRATION_REPO", str(Path.home() / "bmsintegration")))


# --------------------------------------------------------------------------- #
# Нормализация значений
# --------------------------------------------------------------------------- #

def norm(v):
    """Любое значение пресета -> то, что ляжет в JSON."""
    if isinstance(v, Sym):
        return "ha:" + str(v)
    if isinstance(v, Enum):
        return v.value
    if isinstance(v, (list, tuple)):
        return [norm(x) for x in v]
    if isinstance(v, dict):
        return {str(norm(k)): norm(x) for k, x in v.items()}
    if isinstance(v, (bool, int, float, str)) or v is None:
        return v
    raise TypeError(f"неизвестный тип в пресете: {type(v).__name__} {v!r}")


def num(v):
    """Число, записанное в пресете строкой ("0.1"), -> число; прочее как есть."""
    if isinstance(v, str):
        try:
            f = float(v)
        except ValueError:
            return v
        return int(f) if f.is_integer() and "." not in v else f
    return v


def split_list(s):
    return [x for x in (p.strip() for p in s.split(",")) if x]


# --------------------------------------------------------------------------- #
# Сущность пресета -> записи точек
# --------------------------------------------------------------------------- #

def add_entity(L, c, ent, plat, decl_file, cat_line, warnings, seen_src):
    ent_file, ent_line = ent._src
    src = f"{L.relpath(ent_file)}:{ent_line}"
    cat_src = f"{decl_file}:{cat_line}"
    # Две разные сущности на одной строке — значит, они созданы в цикле или функции, и
    # «источник» перестал бы быть однозначным. Лучше узнать об этом сразу.
    if seen_src.setdefault(src, id(ent)) != id(ent):
        warnings.append(f"{src}: на одной строке создано несколько сущностей")

    roles = {}
    for role, val in ent.localtuya_conf.items():
        codes = norm(val if isinstance(val, tuple) else (val,))
        if not all(isinstance(x, str) for x in codes):
            warnings.append(f"{src}: роль {role} не из кодов: {codes!r}")
            continue
        roles[role] = codes

    data = ent.data
    name = data.get("friendly_name") or None
    entity_level = {
        "entity_name": name,
        "icon": data.get("icon") or None,
        # "None" — умолчание самого пресета, значит «категории нет»
        "entity_category": None if data.get("entity_category") == "None"
        else norm(data.get("entity_category")),
        "device_class": norm(data.get("device_class")),
        "state_class": norm(data.get("state_class")),
    }

    ent_rec = OrderedDict(source=src, platform=plat, name=name, roles=roles)
    if (src, plat) not in c["_entity_keys"]:
        c["_entity_keys"].add((src, plat))
        c["entities"].append(ent_rec)

    # Настройки сущности: привязанные к роли (CLOUD_VALUE) и плоские.
    role_facts = {r: {} for r in roles}
    role_cloud = {r: {} for r in roles}
    role_scaled = {r: [] for r in roles}
    role_config = {r: {} for r in roles}
    id_config = {}
    unit = None

    for key, val in ent.entity_configs.items():
        field = FIELD_OF_KEY.get(key)
        # 'modes': в пылесосе строка через запятую, в водонагревателе словарь
        if key == "modes":
            field = "enum_list" if isinstance(getattr(val, "default_value", val), str) else "enum_map"
        if isinstance(val, L.CLOUD_VALUE):
            default = norm(val.default_value)
            if val.dp_config not in roles:
                # Пресет задал запасное значение для роли, которой у этой сущности нет
                # (например яркость у «подсветки выключателя» без точки яркости). Относить
                # его к точке id было бы неправдой, поэтому оно остаётся в config как есть.
                id_config[key] = {"default": default, "cloud": val.value_key,
                                  "unbound_role": val.dp_config}
                continue
            target = val.dp_config
            if field is None:
                role_config[target][key] = {"default": default, "cloud": val.value_key}
                continue
            if field in NUMERIC_FIELDS:
                default = num(default)
            if field == "enum_list" and isinstance(default, str):
                default = split_list(default)
            role_facts[target][field] = default
            role_cloud[target][field] = val.value_key
            if val.scale:
                role_scaled[target].append(field)
        elif field == "unit":
            unit = norm(val)
        else:
            id_config[key] = norm(val)

    for role, codes in roles.items():
        for pos, code in enumerate(codes):
            point = c["points"].setdefault(code, {"code": code, "uses": []})
            use = OrderedDict(platform=plat, role=role)
            if len(codes) > 1:
                use["alternatives"] = codes
                use["priority"] = pos + 1
            if role == "id":
                for k, v in entity_level.items():
                    if v is not None:
                        use[k] = v
                if unit is not None:
                    use["unit"] = unit
                if ent.contains_any:
                    use["match_contains_any"] = list(ent.contains_any)
            elif name:
                use["entity_name"] = name
            use.update(role_facts[role])
            if role_cloud[role]:
                use["from_cloud"] = role_cloud[role]
            if role_scaled[role]:
                use["cloud_scaled"] = role_scaled[role]
            cfg = dict(role_config[role])
            if role == "id":
                cfg.update(id_config)
            if cfg:
                use["config"] = cfg
            use["source"] = src
            use["category_source"] = cat_src
            point["uses"].append(use)


def build_categories(L):
    categories, warnings, seen_src = {}, [], {}
    for pl in L.platforms:
        for cat, entities in pl["table"].items():
            if cat not in pl["decls"]:
                warnings.append(f"{pl['file']}: категория {cat} без найденного объявления")
                continue
            cat_line, kind, expr = pl["decls"][cat][0]
            c = categories.setdefault(cat, {
                "category": cat, "declared": [], "labels": [], "points": OrderedDict(),
                "entities": [], "_entity_keys": set(),
            })
            decl = OrderedDict(platform=pl["platform"], source=f"{pl['file']}:{cat_line}")
            if kind == "assign":
                decl["alias_of"] = expr
            c["declared"].append(decl)
            i = cat_line - 2
            while i >= 0 and pl["lines"][i].strip().startswith("#"):
                c["labels"].append((pl["file"], i + 1, pl["lines"][i].strip().lstrip("#").strip()))
                i -= 1
            for ent in entities:
                add_entity(L, c, ent, pl["platform"], pl["file"], cat_line, warnings, seen_src)
    return categories, warnings


# --------------------------------------------------------------------------- #
# Подписи, номера, итоговая запись категории
# --------------------------------------------------------------------------- #

def read_labels(c):
    """Подписи категории из комментариев над её объявлениями -> (имя, ссылки, заметки)."""
    by_file = {}
    for f, ln, text in c["labels"]:
        by_file.setdefault(f, []).append((ln, text))
    blocks = []
    for f, items in by_file.items():
        items.sort()
        cur = []
        for ln, text in items:
            if cur and ln != cur[-1][0] + 1:
                blocks.append((f, cur))
                cur = []
            cur.append((ln, text))
        if cur:
            blocks.append((f, cur))
    names, urls, notes = [], [], []
    for f, blk in blocks:
        texts = [(text, f"{f}:{ln}") for ln, text in blk]
        first = next(((t, s) for t, s in texts if t and not t.startswith("http")), None)
        if first:
            clean, extras = split_label(first[0])
            names.append((clean, first[1]))
            notes.extend({"text": e, "source": first[1]} for e in extras)
        for t, s in texts:
            if t.startswith("http"):
                urls.append((t, s))
            elif t and (t, s) != first:
                notes.append({"text": t, "source": s})
    return names, urls, notes


def finalize(L, categories):
    out, problems = OrderedDict(), []
    for cat in sorted(categories):
        c = categories[cat]
        names, urls, notes = read_labels(c)
        name_en = name_src = None
        if names:
            best = Counter(n[0] for n in names).most_common(1)[0][0]
            name_en, name_src = next(n for n in names if n[0] == best)
        e = OrderedDict()
        e["category"] = cat
        e["name_en"] = name_en
        e["name_en_source"] = name_src
        variants = sorted({n[0] for n in names if n[0] != name_en})
        if variants:
            e["name_en_variants"] = variants
        e["name_ru"] = CATEGORY_RU.get(cat)
        e["name_ru_note"] = "перевод name_en; в источнике русских названий нет"
        e["tuya_doc"] = urls[0][0] if urls else None
        e["tuya_doc_source"] = urls[0][1] if urls else None
        e["source_notes"] = sorted(notes, key=lambda n: n["source"])
        e["declared"] = c["declared"]
        e["entities"] = sorted(c["entities"], key=lambda r: (r["platform"], r["source"]))
        pts = []
        for code in sorted(c["points"]):
            p = c["points"][code]
            p["uses"].sort(key=lambda u: (u["platform"], u["source"], u["role"]))
            pts.append(OrderedDict([
                ("code", code), ("dp", None), ("dp_source", None), ("dp_type", None),
                ("uses", p["uses"]),
            ]))
        e["points"] = pts
        out[cat] = e

    # Известные номера. dp_scope объясняет, где именно источник их называет.
    for kn in KNOWN_DP_NUMBERS:
        for cat in out.values():
            for p in cat["points"]:
                if p["code"] == kn["code"]:
                    p["dp"] = kn["dp"]
                    p["dp_scope"] = kn["scope"]
                    p["dp_source"] = [f"{b['file']}:{b['line']}" for b in kn["basis"]]
    # dp_type: только там, где источник называет тип прямо (base.py:225 — «двоичный HSV в base64»)
    for cat in out.values():
        for p in cat["points"]:
            if p["code"] == "paint_colour_data":
                p["dp_type"] = "Raw"
                p["dp_type_source"] = f"{ENT_ROOT}/base.py:225"
    return out, problems


def value_maps(L):
    """Таблицы «значение точки -> состояние HA» из файлов пресетов, со строками."""
    wanted = {"climates": ["MAP_CLIMATE_MODES", "MAP_CLIMATE_ACTIONS"],
              "alarm_control_panels": ["MAP_ALARM_STATES"]}
    meaning = {
        "MAP_CLIMATE_MODES": "значение точки режима (из облачного range) -> режим климата HA",
        "MAP_CLIMATE_ACTIONS": "значение точки действия (из облачного range) -> действие климата HA",
        "MAP_ALARM_STATES": "значение точки режима охраны -> состояние охранной панели HA",
    }
    out = []
    for pl in L.platforms:
        mod = pl["file"].rsplit("/", 1)[1][:-3]
        if mod not in wanted:
            continue
        tree = ast.parse("\n".join(pl["lines"]))
        lines = module_assign_lines(tree, wanted[mod])
        for name in wanted[mod]:
            out.append(OrderedDict([
                ("id", name), ("meaning", meaning[name]),
                ("map", norm(getattr(pl["module"], name))),
                ("source", f"{pl['file']}:{lines[name]}"),
            ]))
    return out


def verify_entity_sources(L, categories, problems):
    """Независимая проверка номеров строк: на указанной строке стоит `LocalTuyaEntity(`, а
    коды сущности читаются в её описании.

    Номера строк ловятся на лету из кадра вызова. Если у новой версии Python или у файла
    с фабрикой сущностей кадр укажет не туда, этот прогон скажет об этом, а не отдаст
    в библиотеку ссылку, которая ведёт мимо. Коды ищем тремя способами, потому что пресеты
    пишут их по-разному: DPCode.ИМЯ прямо в описании; через общую константу модуля
    (FAN_SPEED_DP = (DPCode.A, DPCode.B)); вычисляемой строкой f"{DPCode.A}_tilt".
    """
    seen = set()
    consts_cache = {}
    for c in categories.values():
        for e in c["entities"]:
            if e["source"] in seen:
                continue
            seen.add(e["source"])
            file, _, ln = e["source"].rpartition(":")
            text = (L.snap / file).read_text(encoding="utf-8")
            lines = text.splitlines()
            ln = int(ln)
            if "LocalTuyaEntity(" not in lines[ln - 1]:
                problems.append(f"{e['source']}: на строке нет LocalTuyaEntity(")
                continue
            if file not in consts_cache:
                consts_cache[file] = {
                    n.targets[0].id: ast.get_source_segment(text, n.value) or ""
                    for n in ast.parse(text).body
                    if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name)
                }
            window = "\n".join(lines[ln - 1: ln + 40])
            for ident in set(re.findall(r"\b[A-Z][A-Z0-9_]{2,}\b", window)):
                window += "\n" + consts_cache[file].get(ident, "")
            for role, codes in e["roles"].items():
                for code in codes:
                    names = L.dpcode_names(code)
                    if names:
                        found = any(f"DPCode.{n}" in window for n in names)
                    else:  # код вычислен в пресете, не член DPCode
                        found = code.rsplit("_", 1)[-1] in window
                    if not found:
                        problems.append(f"{e['source']}: код {code} роли {role} не найден в описании сущности")


def verify_quotes(L, table, problems, who):
    """Цитата должна стоять на заявленной строке снимка main."""
    for rec in table:
        for b in rec["basis"]:
            try:
                line = L.line_of(b["file"], b["line"])
            except (IndexError, FileNotFoundError):
                line = ""
            if b["quote"] not in line:
                problems.append(f"{who}[{rec.get('code') or rec.get('id')}]: цитата не найдена "
                                f"на {b['file']}:{b['line']}: {b['quote']!r}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=str(DEFAULT_REPO))
    ap.add_argument("--branch", default="main")
    ap.add_argument("--out", default=str(TUYA_DIR / "library" / "categories.json"))
    ap.add_argument("--names", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    L = Loaded(Path(args.repo), args.branch, TUYA_DIR / ".work")
    categories, warnings = build_categories(L)
    out_cats, problems = finalize(L, categories)

    if args.names:
        for cat, e in out_cats.items():
            print(f"{cat}\t{e['name_en']}\t{e.get('name_en_variants', '')}")
        return

    verify_entity_sources(L, categories, problems)
    verify_quotes(L, KNOWN_DP_NUMBERS, problems, "KNOWN_DP_NUMBERS")
    verify_quotes(L, OBSERVED_NUMBERS, problems, "OBSERVED_NUMBERS")
    verify_quotes(L, QUIRKS, problems, "QUIRKS")
    if "двоичный HSV в" not in L.line_of(f"{ENT_ROOT}/base.py", 225):
        problems.append("dp_type paint_colour_data: цитата не найдена на base.py:225")
    missing = [c for c, e in out_cats.items() if not e["name_ru"]]
    if missing:
        problems.append("нет русского названия: " + ", ".join(missing))
    for w in warnings:
        print("предупреждение:", w, file=sys.stderr)
    for p in problems:
        print("ОШИБКА:", p, file=sys.stderr)
    if problems:
        raise SystemExit(1)

    doc = OrderedDict()
    doc["schema"] = 1
    doc["about"] = ("Библиотека точек данных Tuya по категориям. Источник — пресеты автонастройки "
                    "BMS Integration (форк LocalTuya), ветка main. Пресеты хранят КОДЫ точек; "
                    "номер известен лишь там, где поле dp не null.")
    doc["source"] = OrderedDict([
        ("repo", "BMS Integration (home-assistant, форк LocalTuya)"),
        ("branch", args.branch),
        ("commit", L.sha),
        ("root", INT_ROOT + "/"),
        ("paths_are_relative_to", "корень репозитория BMS Integration"),
        ("extractor", "tuya/tools/extract_bms.py"),
    ])
    doc["conventions"] = CONVENTIONS
    doc["observed_numbers"] = [OrderedDict([
        ("code", o["code"]), ("dp", o["dp"]), ("scope", o["scope"]),
        ("sources", [f"{b['file']}:{b['line']}" for b in o["basis"]]),
    ]) for o in OBSERVED_NUMBERS]
    doc["value_maps"] = value_maps(L)
    doc["quirks"] = [OrderedDict([
        ("id", q["id"]), ("title", q["title"]), ("text", q["text"]),
        ("applies_to", q["applies_to"]),
        ("sources", [f"{b['file']}:{b['line']}" for b in q["basis"]]),
    ]) for q in QUIRKS]
    doc["categories"] = out_cats

    text = dumps(doc) + "\n"
    out = Path(args.out)
    if args.check:
        same = out.exists() and out.read_text(encoding="utf-8") == text
        print("совпадает" if same else "ОТЛИЧАЕТСЯ", out)
        raise SystemExit(0 if same else 1)
    json.loads(text)  # страховка: то, что записали, обязано быть валидным JSON
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    n_pts = sum(len(c["points"]) for c in out_cats.values())
    n_uses = sum(len(p["uses"]) for c in out_cats.values() for p in c["points"])
    print(f"категорий: {len(out_cats)}, точек: {n_pts}, использований: {n_uses}, коммит {L.sha[:10]}")
    print("записано:", out)


if __name__ == "__main__":
    main()
