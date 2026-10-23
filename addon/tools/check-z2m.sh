#!/usr/bin/env bash
# BMS: проверяем сохранённые патчи на чистом закреплённом исходнике, не локальную .work-сборку.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$ROOT/addon/.work"
CHECK_DIR="$(mktemp -d "$ROOT/addon/.work/check-z2m-XXXXXX")"
trap 'rm -rf "$CHECK_DIR"' EXIT
Z2M_VERSION="$(node -p 'require(process.argv[1]).zigbee2mqtt' "$ROOT/versions.json")"
git clone --depth 1 --branch "$Z2M_VERSION" https://github.com/Koenkk/zigbee2mqtt.git "$CHECK_DIR"
for patch_file in "$ROOT"/addon/bms_zigbee/z2m-patches/*.patch; do
    git -C "$CHECK_DIR" apply --check "$patch_file"
    git -C "$CHECK_DIR" apply "$patch_file"
done
cd "$CHECK_DIR"
PNPM_SPEC="$(node -p 'require("./package.json").packageManager')"
CORE_BASE="$(node -p 'require(process.argv[1])["zigbee-herdsman"]' "$ROOT/versions.json")"
CORE_REV="$(tr -d '[:space:]' < "$ROOT/core/BMS_REVISION")"
CORE_ARCHIVE="$ROOT/core/dist/zigbee-herdsman-$CORE_BASE-bms.$CORE_REV.tgz"
test -s "$CORE_ARCHIVE"
printf '\noverrides:\n  zigbee-herdsman: "file:%s"\n' "$CORE_ARCHIVE" >> pnpm-workspace.yaml
npx --yes "$PNPM_SPEC" install --no-frozen-lockfile
npx --yes "$PNPM_SPEC" run check
npx --yes "$PNPM_SPEC" run build
npx --yes "$PNPM_SPEC" exec vitest run --config test/vitest.config.mts --maxWorkers=2 --testTimeout=30000
BMS_TEST_Z2M="$CHECK_DIR" node --test "$ROOT"/tuya/layer/test/*.test.mjs
