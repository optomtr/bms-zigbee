#!/usr/bin/env bash
# Сборка нашего ядра: zigbee-herdsman закреплённой версии + наши патчи -> tgz.
#
# Почему так: Z2M закрыт для внешних дополнений, поэтому правка Zigbee-ядра
# возможна только в своей копии. Чтобы копия не «уплывала» от upstream, мы не
# храним форк, а каждый раз берём чистый тег и накладываем маленькие патчи
# из patches/. Новая версия = сменить номер в versions.json и пересобрать.
#
# Использование:
#   ./build.sh            полная сборка: клон -> патчи -> сборка -> тесты -> tgz
#   ./build.sh --prepare  только клон и патчи (чтобы писать новый патч, см. README)
#
# Переменные окружения (нужны для проверок, обычно не трогать):
#   PATCHES_DIR   откуда брать *.patch   (по умолчанию core/patches)
#   DIST_DIR      куда класть tgz        (по умолчанию core/dist)
#   TEST_WORKERS  число воркеров vitest  (по умолчанию 2)
set -euo pipefail

CORE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSIONS_JSON="$CORE_DIR/../versions.json"
UPSTREAM_DIR="$CORE_DIR/upstream"
PATCHES_DIR="${PATCHES_DIR:-$CORE_DIR/patches}"
DIST_DIR="${DIST_DIR:-$CORE_DIR/dist}"
UPSTREAM_REPO="https://github.com/Koenkk/zigbee-herdsman.git"

# Часть upstream-тестов зависит от реального времени (setTimeout, 5-секундный таймаут
# по умолчанию), а «Controller start» сам занимает ~4,9 с из этих 5. Пока машина
# занята чем-то ещё, они случайно краснеют, хотя код исправен (замерено: на чистом
# теге падали то «Controller start», то «Device OTA > throttles»). Поэтому:
#  - 2 воркера вместо всех ядер — меньше борьбы за процессор;
#  - таймаут теста 30 с;
#  - до двух повторов упавшего теста: настоящая поломка (в том числе от нашего
#    патча) красна все три раза, случайный сбой по времени — нет.
TEST_WORKERS="${TEST_WORKERS:-2}"
TEST_ARGS=(--maxWorkers="$TEST_WORKERS" --testTimeout=30000 --retry=2)

PREPARE_ONLY=0
case "${1:-}" in
    "") ;;
    --prepare) PREPARE_ONLY=1 ;;
    *) echo "Неизвестный аргумент: $1 (допустимо только --prepare)" >&2; exit 2 ;;
esac

log() { echo; echo "==> $*"; }
die() { echo; echo "ОШИБКА: $*" >&2; exit 1; }

# Читаем поле из JSON через node: node всё равно нужен для сборки, jq ставить не заставляем.
# path.resolve — чтобы относительный путь не воспринимался как имя модуля.
json_get() { node -e 'const v = require(require("path").resolve(process.argv[1]))[process.argv[2]]; if (v === undefined) process.exit(1); console.log(v)' "$1" "$2"; }

# --- 1. Какую версию собираем --------------------------------------------------

[ -f "$VERSIONS_JSON" ] || die "нет файла $VERSIONS_JSON"
BASE_VERSION="$(json_get "$VERSIONS_JSON" zigbee-herdsman)" || die "в versions.json нет поля zigbee-herdsman"
[[ "$BASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "версия '$BASE_VERSION' в versions.json не вида X.Y.Z"

# Номер нашей ревизии растёт при каждом изменении набора патчей (см. README).
# Он попадает в версию пакета, и по журналу Z2M видно, какое именно ядро стоит.
[ -f "$CORE_DIR/BMS_REVISION" ] || die "нет файла core/BMS_REVISION"
BMS_REVISION="$(tr -d '[:space:]' < "$CORE_DIR/BMS_REVISION")"
[[ "$BMS_REVISION" =~ ^[0-9]+$ ]] || die "в core/BMS_REVISION должно быть целое число, а там '$BMS_REVISION'"

OUR_VERSION="$BASE_VERSION-bms.$BMS_REVISION"
[ -d "$PATCHES_DIR" ] || die "нет папки с патчами: $PATCHES_DIR"
# Пути делаем абсолютными сразу: дальше скрипт переходит в upstream/, и относительный путь поехал бы.
PATCHES_DIR="$(cd "$PATCHES_DIR" && pwd)"
mkdir -p "$DIST_DIR"
DIST_DIR="$(cd "$DIST_DIR" && pwd)"

log "Собираем zigbee-herdsman $OUR_VERSION (основа: upstream v$BASE_VERSION)"

# --- 2. Чистые исходники upstream ----------------------------------------------

# Каждый раз с нуля: так патчи всегда ложатся на нетронутый тег, и результат
# не зависит от того, что осталось в папке после прошлой сборки.
rm -rf "$UPSTREAM_DIR"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$BASE_VERSION" "$UPSTREAM_REPO" "$UPSTREAM_DIR" \
    || die "не удалось получить тег v$BASE_VERSION из $UPSTREAM_REPO"

# Страховка от тега, под которым лежит не та версия.
UPSTREAM_PKG_VERSION="$(json_get "$UPSTREAM_DIR/package.json" version)"
[ "$UPSTREAM_PKG_VERSION" = "$BASE_VERSION" ] \
    || die "тег v$BASE_VERSION содержит пакет версии $UPSTREAM_PKG_VERSION"
echo "Тег v$BASE_VERSION = коммит $(git -C "$UPSTREAM_DIR" rev-parse HEAD)"

# --- 3. Патчи -------------------------------------------------------------------

# Порядок — по имени файла (0001-..., 0002-...); glob в bash сортирует сам.
shopt -s nullglob
PATCH_FILES=("$PATCHES_DIR"/*.patch)
shopt -u nullglob
APPLIED_NAMES=()

for patch in ${PATCH_FILES[@]+"${PATCH_FILES[@]}"}; do
    name="$(basename "$patch")"
    # git apply, а не patch: он строгий (без «нечётких» совпадений) и атомарный —
    # если upstream тронул это место, патч не ляжет вовсе, а не ляжет криво.
    if ! git -C "$UPSTREAM_DIR" apply --whitespace=nowarn "$patch"; then
        die "ПАТЧ НЕ ЛЁГ: $name
Вероятно, в upstream v$BASE_VERSION изменился код, на который рассчитан патч.
Что делать: см. «Как перейти на новую версию» в core/README.md."
    fi
    # Коммит после каждого патча нужен, чтобы при разработке следующего патча
    # `git diff` в upstream/ показывал только его, а не сумму всех.
    git -C "$UPSTREAM_DIR" add -A
    git -C "$UPSTREAM_DIR" -c user.name=bms -c user.email=bms@localhost -c commit.gpgsign=false \
        commit --quiet -m "bms: $name"
    echo "Патч наложен: $name"
    APPLIED_NAMES+=("$name")
done
[ "${#APPLIED_NAMES[@]}" -gt 0 ] || echo "Патчей нет: собираем чистый upstream (только с нашей версией)."

if [ "$PREPARE_ONLY" -eq 1 ]; then
    log "Готово (--prepare): исходники в $UPSTREAM_DIR, патчи наложены, сборки нет."
    exit 0
fi

# --- 4. Зависимости и проверка стиля --------------------------------------------

cd "$UPSTREAM_DIR"

# pnpm не ставим глобально: берём ту версию, что upstream закрепил у себя
# в packageManager, — тогда lock-файл читается так же, как у авторов.
PNPM_SPEC="$(json_get package.json packageManager)" || die "в package.json upstream нет packageManager"
[[ "$PNPM_SPEC" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "ожидался packageManager вида pnpm@X.Y.Z, а там '$PNPM_SPEC'"
pnpm() { npx --yes "$PNPM_SPEC" "$@"; }

log "Зависимости ($PNPM_SPEC, строго по lock-файлу)"
pnpm install --frozen-lockfile

# Тот же biome, что гоняет CI upstream (секунда). Патч в стиле upstream легче
# переносится на новый выпуск и не ловит лишних конфликтов форматирования.
# Идёт до правки package.json: версию и поле bms biome мог бы счесть «не по формату».
log "Проверка стиля (biome, как в CI upstream)"
pnpm run check

# --- 5. Версия пакета, сборка, тесты --------------------------------------------

# Версию меняем ДО сборки и упаковки: именно её Z2M печатает в журнале.
# Заодно кладём в пакет поле bms со списком патчей — видно, что внутри, без разбора diff'ов.
node -e '
const fs = require("fs");
const [file, version, base, revision, ...patches] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.version = version;
pkg.bms = {base, revision: Number(revision), patches};
fs.writeFileSync(file, JSON.stringify(pkg, null, 4) + "\n");
' "$UPSTREAM_DIR/package.json" "$OUR_VERSION" "$BASE_VERSION" "$BMS_REVISION" ${APPLIED_NAMES[@]+"${APPLIED_NAMES[@]}"}

log "Сборка (tsc)"
pnpm run build

log "Тесты драйвера ember (сюда придётся наша правка)"
pnpm run test "${TEST_ARGS[@]}" test/adapter/ember

log "Весь набор тестов"
pnpm run test "${TEST_ARGS[@]}"

# --- 6. tgz ---------------------------------------------------------------------

log "Упаковка"
TGZ="$DIST_DIR/zigbee-herdsman-$OUR_VERSION.tgz"
rm -f "$TGZ"
# prepack у upstream сам делает clean + build, так что в tgz попадает свежая сборка.
pnpm pack --pack-destination "$DIST_DIR"
[ -f "$TGZ" ] || die "после pack не появился файл $TGZ"

# Проверяем сам архив, а не только то, что мы думаем, что в него положили.
PACKED_VERSION="$(tar -xzOf "$TGZ" package/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
[ "$PACKED_VERSION" = "$OUR_VERSION" ] || die "в tgz версия $PACKED_VERSION, ожидалась $OUR_VERSION"
tar -tzf "$TGZ" | grep -qx 'package/dist/index.js' || die "в tgz нет package/dist/index.js"
# Контракт с дополнением: оно зовёт энергоскан по этому пути внутри пакета (патч 0003, см. README).
tar -tzf "$TGZ" | grep -qx 'package/dist/adapter/ember/bms/energyScanCli.js' \
    || die "в tgz нет package/dist/adapter/ember/bms/energyScanCli.js (контракт энергоскана с дополнением)"

if command -v shasum >/dev/null 2>&1; then SHA="$(shasum -a 256 "$TGZ")"; else SHA="$(sha256sum "$TGZ")"; fi
log "Готово: $TGZ"
echo "версия пакета: $PACKED_VERSION"
echo "sha256: ${SHA%% *}"
