#!/usr/bin/env bash
# Стенд для проверок слоя: настоящий Zigbee2MQTT той версии, что в versions.json, в tuya/.work/.
#
# Почему не просто `npm install zigbee2mqtt`: Z2M ищет свои зависимости в <папка Z2M>/node_modules
# (externalJS.ts:52 — ссылку node_modules для внешних файлов он ведёт туда же). npm поднимает
# зависимости на уровень выше, и такой ссылки не существует. Поэтому раскладываем как в образе
# дополнения (/app + /app/node_modules): копия пакета в .work/z2m-app, а node_modules — ссылка
# на установленное npm-ом дерево.
set -euo pipefail

TUYA="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$TUYA/.work"
VERSION="$(node -p 'require(process.argv[1]).zigbee2mqtt' "$TUYA/../versions.json")"

mkdir -p "$WORK/z2m-npm"
cd "$WORK/z2m-npm"
[ -f package.json ] || echo '{"name":"z2m-stand","private":true}' > package.json
# --ignore-scripts: сборка родных модулей (последовательный порт) стенду не нужна, адаптера нет.
npm install "zigbee2mqtt@$VERSION" --ignore-scripts --no-audit --no-fund >/dev/null

rm -rf "$WORK/z2m-app"
cp -R "$WORK/z2m-npm/node_modules/zigbee2mqtt" "$WORK/z2m-app"
rm -rf "$WORK/z2m-app/node_modules"
ln -s ../z2m-npm/node_modules "$WORK/z2m-app/node_modules"

cd "$WORK/z2m-app"
node -e 'for (const p of ["zigbee2mqtt", "zigbee-herdsman", "zigbee-herdsman-converters", "js-yaml"])
  console.log(`${p} ${require(`./node_modules/${p}/package.json`).version}`)'
