"""Чтение пресетов BMS Integration: снимок ветки main, заглушки HA, разбор исходников.

Отдельный модуль, чтобы extract_bms.py занимался только сборкой JSON. Всё здесь —
«как достать данные, не придумав их»:

* снимок main берём через `git archive` (читает только объекты git: рабочее дерево
  репозитория владельца и его текущая ветка остаются как были);
* файлы пресетов исполняем сами, а не пересказываем, поэтому значения — те же, что
  видит автонастройка интеграции;
* номер строки каждой сущности ловим в момент её создания.
"""

import ast
import importlib
import re
import shutil
import subprocess
import sys
import tarfile
import types
from pathlib import Path

from bms_tables import ENT_ROOT, INT_ROOT

# В репозитории и в его снимке нельзя оставлять __pycache__: репозиторий только
# для чтения, а снимок должен остаться побайтно равным main.
sys.dont_write_bytecode = True

# Что нужно из репозитория: пресеты и то, на что ссылаются цитаты.
ARCHIVE_PATHS = [INT_ROOT, "tests", "docs", "README.md", "CLAUDE.md"]


def export_snapshot(repo: Path, branch: str, dest: Path) -> str:
    """Распаковать ветку в dest. Возвращает полный хеш коммита."""
    sha = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--verify", branch + "^{commit}"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    stamp = dest / ".sha"
    if stamp.exists() and stamp.read_text().strip() == sha:
        return sha
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    proc = subprocess.Popen(
        ["git", "-C", str(repo), "archive", sha, *ARCHIVE_PATHS], stdout=subprocess.PIPE
    )
    with tarfile.open(fileobj=proc.stdout, mode="r|") as tar:
        tar.extractall(dest, filter="data")
    if proc.wait() != 0:
        raise SystemExit("git archive завершился с ошибкой")
    stamp.write_text(sha + "\n")
    return sha


class Sym(str):
    """Имя константы Home Assistant, которой у нас нет: в JSON ляжет как «ha:имя».

    Home Assistant мы не ставим, а значения вроде UnitOfTemperature.CELSIUS — его.
    Подставить «°C» по памяти значило бы придумать, поэтому имя остаётся как в
    источнике.
    """

    def __getattr__(self, attr):
        if attr.startswith("__"):
            raise AttributeError(attr)
        return Sym(f"{self}.{attr}")


class Stub(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        # В HA все CONF_*/ATTR_* — строки в нижнем регистре без префикса
        # ("CONF_ICON" = "icon"). Они нужны настоящими: служат ключами словарей.
        if name.startswith(("CONF_", "ATTR_")):
            return name.split("_", 1)[1].lower()
        short = self.__name__.replace("homeassistant.", "").replace("components.", "")
        return Sym(name if short == "const" else f"{short}.{name}")


def _mk(name, path=None, cls=types.ModuleType):
    mod = cls(name)
    if path is not None:
        mod.__path__ = [str(path)]
    sys.modules[name] = mod
    return mod


def install_fakes(snap: Path):
    """Готовим sys.modules так, чтобы файлы пресетов исполнялись без Home Assistant.

    Родительские пакеты (custom_components.bms_integration, core) — пустые: их
    настоящие __init__ тянут весь Home Assistant, а пресетам нужны только base.py
    и платформенные файлы.
    """
    for comp in ["homeassistant", "homeassistant.const", "homeassistant.components"]:
        _mk(comp, cls=Stub if comp != "homeassistant" else types.ModuleType)
    sys.modules["homeassistant"].__path__ = []
    for comp in ["alarm_control_panel", "binary_sensor", "button", "climate", "cover", "fan",
                 "humidifier", "lock", "number", "remote", "select", "sensor", "siren",
                 "switch", "vacuum", "water_heater", "light"]:
        _mk(f"homeassistant.components.{comp}", cls=Stub)

    pkg = snap / INT_ROOT
    consts = {}
    tree = ast.parse((pkg / "const.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 \
                and isinstance(node.targets[0], ast.Name):
            try:
                consts[node.targets[0].id] = ast.literal_eval(node.value)
            except (ValueError, SyntaxError):
                pass  # не литерал (dataclass, функция) — пресетам не нужен

    _mk("custom_components", snap / "custom_components")
    _mk("custom_components.bms_integration", pkg)
    _mk("custom_components.bms_integration.core", pkg / "core")
    _mk("custom_components.bms_integration.core.ha_entities", pkg / "core/ha_entities")
    const = _mk("custom_components.bms_integration.const", cls=Stub)
    const.__dict__.update(consts)
    # selects.py берёт CONF_OPTIONS из select.py, а тот — из const.py
    select = _mk("custom_components.bms_integration.select", cls=Stub)
    select.CONF_OPTIONS = consts["CONF_OPTIONS"]


def parse_platform_table(snap: Path):
    """DATA_PLATFORMS из ha_entities/__init__.py -> [(платформа HA, модуль, переменная)]."""
    tree = ast.parse((snap / ENT_ROOT / "__init__.py").read_text(encoding="utf-8"))
    var_module = {}
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.level == 1 and node.module \
                and node.module != "base":
            for alias in node.names:
                var_module[alias.asname or alias.name] = node.module
    out = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) \
                and node.targets[0].id == "DATA_PLATFORMS":
            for k, v in zip(node.value.keys, node.value.values):
                # Platform.ALARM_CONTROL_PANEL -> "alarm_control_panel" (так названо в самом HA)
                out.append((k.attr.lower(), var_module[v.id], v.id))
    return out


def category_decls(tree, var):
    """{категория: [(строка, 'key'|'assign', текст присваивания)]} для словаря var."""
    decls = {}
    for node in tree.body:
        targets, value = [], None
        if isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        elif isinstance(node, ast.AnnAssign):
            targets, value = [node.target], node.value
        for t in targets:
            if isinstance(t, ast.Name) and t.id == var and isinstance(value, ast.Dict):
                for k in value.keys:
                    decls.setdefault(k.value, []).append((k.lineno, "key", None))
            elif isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) \
                    and t.value.id == var and isinstance(t.slice, ast.Constant):
                decls.setdefault(t.slice.value, []).append(
                    (node.lineno, "assign", ast.unparse(value)))
    return decls


def module_assign_lines(tree, names):
    """{имя: строка} для присваиваний верхнего уровня."""
    out = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) \
                and node.targets[0].id in names:
            out[node.targets[0].id] = node.lineno
    return out


def comments_above(lines, lineno):
    """Блок комментариев прямо над строкой lineno: [(строка, текст)] сверху вниз."""
    out = []
    i = lineno - 2
    while i >= 0 and lines[i].strip().startswith("#"):
        out.append((i + 1, lines[i].strip().lstrip("#").strip()))
        i -= 1
    return list(reversed(out))


def split_label(text):
    """Подпись категории -> (чистое имя, [хвосты]).

    После имени в источнике бывают приписки: «(duplicate of `kg`)» и хвост через
    «  #». Это пометки автора, а не часть названия, но терять их нельзя.
    """
    extras = []
    if "  #" in text:
        text, tail = text.split("  #", 1)
        extras.append("# " + tail.strip())
    m = re.search(r"\s*\(duplicate of [^)]*\)", text)
    if m:
        extras.append(m.group(0).strip())
        text = text.replace(m.group(0), "")
    return text.strip(), extras


class Loaded:
    """Всё, что нужно сборщику: хеш, снимок, платформы с таблицами и классом CLOUD_VALUE."""

    def __init__(self, repo: Path, branch: str, work: Path):
        self.snap = work / "bms-main"
        self.sha = export_snapshot(repo, branch, self.snap)
        install_fakes(self.snap)
        base = importlib.import_module("custom_components.bms_integration.core.ha_entities.base")
        self.CLOUD_VALUE = base.CLOUD_VALUE
        self.DPCode = base.DPCode

        # Номер строки берём из кадра вызывающего: это строка `LocalTuyaEntity(` самого
        # описания. Класс патчим до импорта платформ; остальной код не меняется.
        original_init = base.LocalTuyaEntity.__init__

        def init(this, *a, **k):
            f = sys._getframe(1)
            this._src = (f.f_code.co_filename, f.f_lineno)
            original_init(this, *a, **k)

        base.LocalTuyaEntity.__init__ = init

        self.platforms = []
        for plat, modname, var in parse_platform_table(self.snap):
            mod = importlib.import_module(
                f"custom_components.bms_integration.core.ha_entities.{modname}")
            file_rel = f"{ENT_ROOT}/{modname}.py"
            text = (self.snap / file_rel).read_text(encoding="utf-8")
            self.platforms.append({
                "platform": plat, "module": mod, "var": var, "file": file_rel,
                "lines": text.splitlines(),
                "decls": category_decls(ast.parse(text), var),
                "table": getattr(mod, var),
            })

    def relpath(self, p: str) -> str:
        return str(Path(p).resolve().relative_to(self.snap.resolve()))

    def dpcode_names(self, value: str) -> set:
        """Имена членов DPCode с этим значением (у DPCode бывают синонимы одного кода)."""
        return {m.name for m in self.DPCode if m.value == value}

    def line_of(self, file_rel: str, lineno: int) -> str:
        return (self.snap / file_rel).read_text(encoding="utf-8").splitlines()[lineno - 1]
