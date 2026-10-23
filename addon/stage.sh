#!/usr/bin/env bash
# Подготовка дополнения к сборке: кладёт в bms_zigbee/ то, что делают соседние задачи.
#
# Почему отдельный скрипт: Home Assistant собирает образ из одной папки (bms_zigbee/) и не видит
# core/ и tuya/. Всё нужное должно лежать внутри неё — и в git тоже, потому что HA
# собирает образ из клона репозитория.
#
# Что делает:
#   1. core/dist/zigbee-herdsman-*.tgz  ->  bms_zigbee/vendor/zigbee-herdsman.tgz   (наше ядро)
#   2. tuya/layer/{external_converters,external_extensions}/bms-*
#                                        ->  bms_zigbee/bms-layer/<то же имя>/       (слой Tuya)
#      tuya/layer/bms-models.example.yaml
#                                        ->  bms_zigbee/bms-layer/bms-models.example.yaml (образец для интегратора)
#   3. подтягивает версию Z2M из versions.json в bms_zigbee/config.yaml
#
# Чего нет — пропускает и пишет об этом: сборка без ядра даёт штатный zigbee-herdsman, без слоя — пустой слой.
# Падает только на настоящих ошибках: битый tgz и синтаксическая ошибка в файле слоя.
# Берутся только файлы bms-*: по приставке entrypoint отличает наши файлы от чужих в папке данных.
# Всё остальное в tuya/layer/... (чужое, вспомогательное) пропускается, но с заметной строкой в выводе.
#
# Использование:
#   ./stage.sh           положить всё, что есть
#   ./stage.sh --clean   убрать подложенное (вернуться к «как официальное»)
set -euo pipefail

ADDON_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$ADDON_ROOT/.." && pwd)"
APP_DIR="$ADDON_ROOT/bms_zigbee"
VERSIONS_JSON="$REPO_ROOT/versions.json"
CORE_DIST="$REPO_ROOT/core/dist"
TUYA_DIR="$REPO_ROOT/tuya"
VENDOR_TGZ="$APP_DIR/vendor/zigbee-herdsman.tgz"
LAYER_DIR="$APP_DIR/bms-layer"
KINDS=(external_converters external_extensions)
# Образец файла моделей. Рабочий bms-models.yaml пишет интегратор в папке данных Z2M; ни stage.sh,
# ни дополнение его не создают и не трогают — только образец (docker-entrypoint.sh обновляет его при каждом запуске).
EXAMPLE_NAME=bms-models.example.yaml

log()  { echo "==> $*"; }
note() { echo "    $*"; }
miss() { echo "    НЕТ: $*"; }
die()  { echo "ОШИБКА: $*" >&2; exit 1; }

# --- --clean ------------------------------------------------------------------------------------
case "${1:-}" in
    "") ;;
    --clean)
        rm -f "$VENDOR_TGZ"
        for kind in "${KINDS[@]}"; do
            find "$LAYER_DIR/$kind" -mindepth 1 -maxdepth 1 -name 'bms-*' -exec rm -rf {} + 2>/dev/null || true
        done
        rm -f "$LAYER_DIR/$EXAMPLE_NAME"
        log "Убрано: vendor/zigbee-herdsman.tgz и bms-* из bms-layer/"
        exit 0 ;;
    *) die "неизвестный аргумент '$1' (допустимо только --clean)" ;;
esac

[ -d "$APP_DIR" ] || die "нет папки $APP_DIR"
[ -f "$VERSIONS_JSON" ] || die "нет файла $VERSIONS_JSON"

# JSON читаем через node: он нужен и для проверки слоя ниже, ставить ещё и jq на машину сборщика незачем.
json_get() { node -e 'const v = require(require("path").resolve(process.argv[1]))[process.argv[2]]; if (v === undefined) process.exit(1); console.log(v)' "$1" "$2"; }
command -v node >/dev/null || die "не найден node (нужен для чтения versions.json и проверки слоя)"

# --- 1. Версия Z2M --------------------------------------------------------------------------------
# Версия дополнения = <Z2M>-bms.<номер>. Dockerfile берёт часть до «-» как версию Z2M для скачивания,
# поэтому Z2M-часть обязана совпадать с versions.json, а «Единственный источник версий» — он.
log "Версия Zigbee2MQTT"
Z2M_VERSION="$(json_get "$VERSIONS_JSON" zigbee2mqtt)" || die "в versions.json нет поля zigbee2mqtt"
[[ "$Z2M_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "версия Z2M '$Z2M_VERSION' в versions.json не вида X.Y.Z"
CUR_VERSION="$(sed -n 's/^version: *//p' "$APP_DIR/config.yaml" | tr -d "\"' ")"
[[ "$CUR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-bms\.([0-9]+)$ ]] || die "version в config.yaml ('$CUR_VERSION') не вида X.Y.Z-bms.N"
BMS_BUILD="${BASH_REMATCH[1]}"
NEW_VERSION="$Z2M_VERSION-bms.$BMS_BUILD"
if [ "$CUR_VERSION" = "$NEW_VERSION" ]; then
    note "config.yaml: $CUR_VERSION — совпадает с versions.json"
else
    # Меняем только Z2M-часть; номер нашей сборки (bms.N) человек поднимает сам, когда выпускает.
    sed -i.bak "s/^version: .*/version: $NEW_VERSION/" "$APP_DIR/config.yaml" && rm -f "$APP_DIR/config.yaml.bak"
    note "config.yaml: $CUR_VERSION -> $NEW_VERSION (Z2M из versions.json). Номер сборки bms.$BMS_BUILD при выпуске поднимите сами."
fi

# --- 2. Ядро --------------------------------------------------------------------------------------
log "Ядро zigbee-herdsman (core/dist -> vendor/)"
CORE_TGZ=""
if [ -d "$CORE_DIST" ]; then
    # Берём самый свежий tgz: после пересборки ядра старые могут лежать рядом.
    CORE_TGZ="$(ls -t "$CORE_DIST"/zigbee-herdsman-*.tgz 2>/dev/null | head -n 1 || true)"
fi
if [ -z "$CORE_TGZ" ]; then
    miss "в $CORE_DIST нет zigbee-herdsman-*.tgz — ядро не подменяется, соберётся штатный zigbee-herdsman"
    if [ -f "$VENDOR_TGZ" ]; then
        note "ВНИМАНИЕ: в vendor/ остался прежний zigbee-herdsman.tgz — он и будет использован. Убрать: ./stage.sh --clean"
    fi
else
    [ "$(ls "$CORE_DIST"/zigbee-herdsman-*.tgz | wc -l)" -le 1 ] || note "в core/dist несколько tgz, взят самый свежий: $(basename "$CORE_TGZ")"
    # Проверка, что это именно собранный пакет herdsman: Dockerfile ставит его как есть и не собирает.
    TGZ_LIST="$(tar -tzf "$CORE_TGZ" 2>/dev/null)" || die "$CORE_TGZ не читается как tgz"
    grep -qx 'package/package.json' <<<"$TGZ_LIST" || die "в $CORE_TGZ нет package/package.json"
    grep -q '^package/dist/' <<<"$TGZ_LIST" || die "в $CORE_TGZ нет package/dist/ — это не собранный пакет (нужен результат npm pack после сборки)"
    PKG_NAME="$(tar -xOzf "$CORE_TGZ" package/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log(p.name+" "+p.version)})')"
    [ "${PKG_NAME%% *}" = "zigbee-herdsman" ] || die "в $CORE_TGZ пакет '${PKG_NAME%% *}', а нужен zigbee-herdsman"
    cp "$CORE_TGZ" "$VENDOR_TGZ"
    note "положено: $(basename "$CORE_TGZ") -> vendor/zigbee-herdsman.tgz (версия ${PKG_NAME#* }, sha256 $(shasum -a 256 "$VENDOR_TGZ" | cut -c1-16)…)"
    BASE_HERDSMAN="$(json_get "$VERSIONS_JSON" zigbee-herdsman || true)"
    case "${PKG_NAME#* }" in
        "$BASE_HERDSMAN"|"$BASE_HERDSMAN"-*) ;;
        *) note "ВНИМАНИЕ: версия ядра ${PKG_NAME#* } не из линии $BASE_HERDSMAN (versions.json)" ;;
    esac
fi

# --- 3. Слой Tuya ---------------------------------------------------------------------------------
log "Слой Tuya (tuya/layer -> bms-layer/)"
LAYER_TOTAL=0
for kind in "${KINDS[@]}"; do
    src="$TUYA_DIR/layer/$kind"
    dst="$LAYER_DIR/$kind"
    mkdir -p "$dst"
    # Сначала убираем прежние bms-* (в том числе убранные из источника), потом кладём заново.
    find "$dst" -mindepth 1 -maxdepth 1 -name 'bms-*' -exec rm -rf {} +
    if [ ! -d "$src" ]; then
        miss "нет папки tuya/layer/$kind — $kind в слое пуст"
        continue
    fi
    count=0
    # Только верхний уровень источника: Z2M вложенные папки сам не читает (общий код лежит в bms-lib/).
    while IFS= read -r -d '' entry; do
        name="$(basename "$entry")"
        # Z2M при ошибке в файле переименует его в .invalid и молча пойдёт дальше — ловим до сборки.
        # В папках (bms-lib/ и т.п.) проверяем все файлы JS внутри.
        while IFS= read -r -d '' js; do
            node --check "$js" 2>/dev/null || { node --check "$js" || true; die "$js: синтаксическая ошибка"; }
        done < <(find "$entry" -type f \( -name '*.js' -o -name '*.cjs' -o -name '*.mjs' \) -print0)
        if [ -f "$entry" ]; then
            case "$name" in
                *.js|*.cjs|*.mjs) ;;
                *) note "ВНИМАНИЕ: $kind/$name — Z2M читает только .js/.cjs/.mjs, этот файл он проигнорирует" ;;
            esac
        fi
        cp -R "$entry" "$dst/"
        count=$((count + 1))
    done < <(find "$src" -mindepth 1 -maxdepth 1 -name 'bms-*' -print0 | sort -z)
    note "$kind: $count шт. из ${src#$REPO_ROOT/}"
    LAYER_TOTAL=$((LAYER_TOTAL + count))
    # Файлы без приставки bms- не везём: по приставке entrypoint отличает наши файлы от чужих в папке
    # данных владельца и не должен ни затирать, ни удалять чужое. Но молча терять файл нельзя.
    while IFS= read -r -d '' other; do
        note "ВНИМАНИЕ: ПРОПУЩЕНО $kind/$(basename "$other") — имя без приставки bms-, в дополнение не попадёт"
    done < <(find "$src" -mindepth 1 -maxdepth 1 -not -name 'bms-*' -not -name '.*' -print0 | sort -z)
done
# Образец bms-models.yaml лежит в корне tuya/layer. Нет его — дополнение соберётся и без него.
if [ -f "$TUYA_DIR/layer/$EXAMPLE_NAME" ]; then
    cp "$TUYA_DIR/layer/$EXAMPLE_NAME" "$LAYER_DIR/$EXAMPLE_NAME"
    note "$EXAMPLE_NAME: положен (образец для интегратора; рабочий bms-models.yaml дополнение не создаёт)"
else
    rm -f "$LAYER_DIR/$EXAMPLE_NAME"
    miss "tuya/layer/$EXAMPLE_NAME — образца для интегратора в образе не будет"
fi
[ "$LAYER_TOTAL" -gt 0 ] || note "слой Tuya пуст — образ соберётся без наших конвертеров и расширений"

echo
log "Готово. Дальше: образ собирает Home Assistant при установке (см. README.md), локально — docker build из bms_zigbee/."
