#!/usr/bin/env bashio

bashio::log.info "Preparing to start..."
# BMS: до подключения к координатору проверяем реальную композицию образа.
node /opt/bms/verify-build.js || bashio::exit.nok "BMS: состав образа не соответствует паспорту"

# Check if HA supervisor started
# Workaround for:
# - https://github.com/home-assistant/supervisor/issues/3884
# - https://github.com/zigbee2mqtt/hassio-zigbee2mqtt/issues/387
bashio::config.require 'data_path'

# BMS: раньше здесь запуск останавливался, пока в serial.port стояла заглушка IP_SLZB («впишите IP»).
# Теперь по умолчанию serial.port = auto: дополнение само ищет координатор SLZB-06M в сети и ждёт его
# появления (rootfs/opt/bms/coordinator.sh, вызывается ниже, после export_config 'serial').

# Socat
if bashio::config.true 'socat.enabled'; then
    bashio::log.info "Socat enabled"
    SOCAT_MASTER=$(bashio::config 'socat.master')
    SOCAT_SLAVE=$(bashio::config 'socat.slave')

    # Validate input
    if [[ -z "$SOCAT_MASTER" ]]; then
    bashio::exit.nok "Socat is enabled but not started because no master address specified"
    fi
    if [[ -z "$SOCAT_SLAVE" ]]; then
    bashio::exit.nok "Socat is enabled but not started because no slave address specified"
    fi
    bashio::log.info "Starting socat"

    DATA_PATH=$(bashio::config 'data_path')
    SOCAT_OPTIONS=$(bashio::config 'socat.options')

    # Socat start configuration
    bashio::log.blue "Socat startup parameters:"
    bashio::log.blue "Options:     $SOCAT_OPTIONS"
    bashio::log.blue "Master:      $SOCAT_MASTER"
    bashio::log.blue "Slave:       $SOCAT_SLAVE"

    bashio::log.info "Starting socat process ..."
    exec socat $SOCAT_OPTIONS $SOCAT_MASTER $SOCAT_SLAVE &

    bashio::log.debug "Modifying process for logging if required"
    if bashio::config.true 'socat.log'; then
        bashio::log.debug "Socat loggin enabled, setting file path to $DATA_PATH/socat.log"
        exec &>"$DATA_PATH/socat.log" 2>&1
    else
    bashio::log.debug "No logging required"
    fi
else
    bashio::log.info "Socat not enabled"
fi

export ZIGBEE2MQTT_DATA="$(bashio::config 'data_path')"
mkdir -p "$ZIGBEE2MQTT_DATA" || bashio::exit.nok "Could not create $ZIGBEE2MQTT_DATA"

# BMS: слой Tuya. Z2M берёт внешние конвертеры и расширения из <данные>/external_converters и
# <данные>/external_extensions, только из самой папки (вложенные папки он не читает) и только
# файлы .js/.cjs/.mjs (lib/extension/externalJS.ts: getFiles). Свои файлы мы называем bms-*:
# на каждом запуске удаляем прежние bms-* и кладём заново из образа — так обновление
# дополнения обновляет слой, а убранный из образа файл исчезает и из папки данных.
# Файлы без приставки bms- (чужие, например положенные владельцем или через интерфейс Z2M)
# и служебную ссылку node_modules, которую создаёт сам Z2M, не трогаем.
# Подпапки bms-* (общий код для наших файлов, импорт по относительному пути) копируются целиком.
BMS_LAYER_SRC=/opt/bms-layer
for bms_kind in external_converters external_extensions; do
    bms_dst="$ZIGBEE2MQTT_DATA/$bms_kind"
    if [[ -d "$bms_dst" ]]; then
        find "$bms_dst" -mindepth 1 -maxdepth 1 -name 'bms-*' -exec rm -rf {} + \
            || bashio::exit.nok "BMS: не удалось очистить старые файлы слоя в $bms_dst"
    fi
    if compgen -G "$BMS_LAYER_SRC/$bms_kind/bms-*" > /dev/null; then
        mkdir -p "$bms_dst" && cp -R "$BMS_LAYER_SRC/$bms_kind"/bms-* "$bms_dst"/ \
            || bashio::exit.nok "BMS: не удалось скопировать слой Tuya в $bms_dst"
        bashio::log.info "BMS: слой Tuya, $bms_kind: $(cd "$BMS_LAYER_SRC/$bms_kind" && echo bms-*)"
    else
        bashio::log.info "BMS: слой Tuya, $bms_kind: в образе файлов слоя нет"
    fi
done

# BMS: образец файла моделей Tuya. Рабочий файл bms-models.yaml ведёт интегратор в этой же папке
# данных (его читает конвертер bms-models.mjs: ../bms-models.yaml от external_converters/).
# Его мы НЕ создаём, не читаем и не трогаем никогда — иначе обновление дополнения затёрло бы
# модели, которые человек завёл руками. Обновляется только образец (bms-models.example.yaml):
# так при каждом запуске у интегратора под рукой справка, соответствующая установленной версии.
if [[ -f "$BMS_LAYER_SRC/bms-models.example.yaml" ]]; then
    cp "$BMS_LAYER_SRC/bms-models.example.yaml" "$ZIGBEE2MQTT_DATA/bms-models.example.yaml" \
        || bashio::exit.nok "BMS: не удалось скопировать bms-models.example.yaml в $ZIGBEE2MQTT_DATA"
    bashio::log.info "BMS: слой Tuya: образец bms-models.example.yaml обновлён (рабочий bms-models.yaml не трогаю)"
else
    # Образца нет в образе — убираем и старую копию, как и устаревшие bms-* выше.
    rm -f "$ZIGBEE2MQTT_DATA/bms-models.example.yaml"
fi

if bashio::config.has_value 'watchdog'; then
    export Z2M_WATCHDOG="$(bashio::config 'watchdog')"
    bashio::log.info "Enabled Zigbee2MQTT watchdog with value '$Z2M_WATCHDOG'"
fi

# BMS: загрузчик публикует degraded, если обязательный файл не импортировался/не запустился.
export BMS_FRONTEND_PATH=/opt/bms-ui
export BMS_REQUIRED_EXTENSIONS="$(node -p 'require("/opt/bms-build-manifest.json").required_extensions.join(",")')"
# BMS: версия сборки — по ней bms-self-check.mjs понимает «это обновление» и проверяет сеть один раз.
export BMS_ADDON_VERSION="$(node -p 'require("/opt/bms-build-manifest.json").build_version')"
export NODE_PATH=/app/node_modules
export ZIGBEE2MQTT_CONFIG_FRONTEND_ENABLED='true'
export ZIGBEE2MQTT_CONFIG_FRONTEND_PORT='8099'
export ZIGBEE2MQTT_CONFIG_HOMEASSISTANT_ENABLED='true'
# BMS: без этого Z2M при первом запуске пишет в configuration.yaml enable_external_js: false
# (lib/util/settings.ts: writeMinimalDefaults) и наш слой Tuya молча не загружается.
export ZIGBEE2MQTT_CONFIG_ADVANCED_ENABLE_EXTERNAL_JS='true'
export Z2M_ONBOARD_URL='http://0.0.0.0:8099'

if bashio::config.true 'force_onboarding'; then
    export Z2M_ONBOARD_FORCE_RUN="1"
    bashio::log.info "Forcing onboard to run"
fi

if bashio::config.true 'disable_tuya_default_response'; then
    bashio::log.info "Disabling TuYa default responses"
    export DISABLE_TUYA_DEFAULT_RESPONSE="true"
fi

# Expose addon configuration through environment variables.
function export_config() {
    local key=${1}
    local subkey

    if bashio::config.is_empty "${key}"; then
        return
    fi

    for subkey in $(bashio::jq "$(bashio::config "${key}")" 'keys[]'); do
        export "ZIGBEE2MQTT_CONFIG_$(bashio::string.upper "${key}")_$(bashio::string.upper "${subkey}")=$(bashio::config "${key}.${subkey}")"
    done
}

export_config 'mqtt'
export_config 'serial'

export TZ="$(bashio::supervisor.timezone)"

if (bashio::config.is_empty 'mqtt' || ! (bashio::config.has_value 'mqtt.server' || bashio::config.has_value 'mqtt.user' || bashio::config.has_value 'mqtt.password')) && bashio::var.has_value "$(bashio::services 'mqtt')"; then
    if bashio::var.true "$(bashio::services 'mqtt' 'ssl')"; then
        export ZIGBEE2MQTT_CONFIG_MQTT_SERVER="mqtts://$(bashio::services 'mqtt' 'host'):$(bashio::services 'mqtt' 'port')"
    else
        export ZIGBEE2MQTT_CONFIG_MQTT_SERVER="mqtt://$(bashio::services 'mqtt' 'host'):$(bashio::services 'mqtt' 'port')"
    fi
    export ZIGBEE2MQTT_CONFIG_MQTT_USER="$(bashio::services 'mqtt' 'username')"
    export ZIGBEE2MQTT_CONFIG_MQTT_PASSWORD="$(bashio::services 'mqtt' 'password')"
fi

# BMS: адрес координатора ------------------------------------------------------------------------
# serial.port = auto -> ищем SLZB-06M в сетях Home Assistant, ждём его, проверяем прошивку; найденный
# адрес уходит Z2M через окружение (ZIGBEE2MQTT_CONFIG_SERIAL_PORT), как у официального дополнения.
# Явный адрес владельца работает как есть. Блок стоит ПОСЛЕ export_config 'serial': он переопределяет
# выставленное там «auto». Итог — BMS_SERIAL_PORT (его же берёт замер эфира ниже). Подробности — в coordinator.sh.
BMS_SEED="node /opt/bms/seed-config.js"
# shellcheck source=opt/bms/coordinator.sh
source /opt/bms/coordinator.sh
bms_coordinator_setup

# BMS: настройки новой установки и выбор канала -------------------------------------------------
# Хотим, чтобы владелец ничего не вписывал, а всё работало как у шлюза Tuya: мощность,
# проверка «живо ли» и самый тихий канал. Сами значения и почему они такие — в seed-config.js;
# здесь только решение, когда их записывать. Блок стоит ПОСЛЕ export_config выше: seed-config.js
# использует тот же Z2M-код, что при первом запуске, и этот код берёт serial/mqtt из окружения —
# иначе в новый configuration.yaml не попал бы адрес координатора.
BMS_CONF="$ZIGBEE2MQTT_DATA/configuration.yaml"
# Что выбрали мы: «<канал> scanned» (замерили) или «<канал> fallback» (замер не вышел, взяли запасной).
# Нужна, чтобы отличить наш канал в configuration.yaml от канала, который вписал владелец.
BMS_CHANNEL_NOTE="$ZIGBEE2MQTT_DATA/.bms-channel"
# Утилита замера эфира лежит в нашем ядре (core/); в штатном zigbee-herdsman её нет.
BMS_SCAN_CLI=/app/node_modules/zigbee-herdsman/dist/adapter/ember/bms/energyScanCli.js
# Запасной канал: 15 лежит между Wi-Fi 1 (занимает Zigbee 11–14) и Wi-Fi 6 (16–19).
# Z2M по умолчанию берёт 11 — это как раз под Wi-Fi 1, самым частым каналом роутеров.
BMS_FALLBACK_CHANNEL=15
# Секунд на замер; зависший замер не должен держать запуск дополнения вечно.
# Переменной окружения можно сократить срок — это нужно только проверкам.
BMS_SCAN_TIMEOUT="${BMS_SCAN_TIMEOUT:-180}"

bms_channel=""        # канал, который запишем в этот запуск (пусто — не трогаем)
bms_kind=""           # scanned | fallback
bms_conf_channel=""   # канал, который уже стоит в configuration.yaml

# Замер эфира -> bms_channel / bms_kind. Всегда что-то выбирает: при любой неудаче — запасной канал.
bms_scan_channel() {
    local port out rc=0 err_file line best
    bms_channel="$BMS_FALLBACK_CHANNEL"
    bms_kind=fallback

    # Адрес берём из bms_coordinator_setup (в режиме auto — найденный), а не из настроек дополнения:
    # там может стоять «auto», а замеру нужен настоящий tcp://IP:порт.
    if [[ -z "$BMS_SERIAL_PORT" ]]; then
        bashio::log.warning "BMS: адрес координатора не задан, замерить эфир нельзя — ставлю запасной канал $bms_channel (между Wi-Fi 1 и 6)."
        return 0
    fi
    if bashio::config.has_value 'serial.adapter' && [[ "$(bashio::config 'serial.adapter')" != "ember" ]]; then
        bashio::log.warning "BMS: замер эфира умеет только адаптер ember (SLZB-06M), а выбран '$(bashio::config 'serial.adapter')' — ставлю запасной канал $bms_channel (между Wi-Fi 1 и 6)."
        return 0
    fi
    if [[ ! -f "$BMS_SCAN_CLI" ]]; then
        bashio::log.warning "BMS: в образе нет утилиты замера эфира ($BMS_SCAN_CLI) — стоит штатное ядро? Ставлю запасной канал $bms_channel (между Wi-Fi 1 и 6)."
        return 0
    fi

    port="$BMS_SERIAL_PORT"
    bashio::log.info "BMS: первый запуск — измеряю загрузку эфира, как это делает шлюз Tuya (обычно несколько секунд)..."
    err_file="$(mktemp)"
    out="$(timeout "$BMS_SCAN_TIMEOUT" node "$BMS_SCAN_CLI" "$port" 2>"$err_file")" || rc=$?
    if [[ "$rc" -ne 0 ]]; then
        if [[ "$rc" -eq 124 || "$rc" -eq 143 ]]; then
            bashio::log.warning "BMS: замер эфира не закончился за $BMS_SCAN_TIMEOUT с — ставлю запасной канал $bms_channel (между Wi-Fi 1 и 6)."
        else
            bashio::log.warning "BMS: замер эфира не удался (код $rc): $(tail -n 3 "$err_file" | tr '\n' ' ')— ставлю запасной канал $bms_channel (между Wi-Fi 1 и 6)."
        fi
        rm -f "$err_file"
        return 0
    fi
    rm -f "$err_file"

    # Договор с ядром: одна строка JSON {"results":[{"channel":11,"rssi":-85},...],"best":15}.
    # Берём последнюю непустую строку: если ядро вдруг напишет что-то ещё выше, результат всё равно найдём.
    line="$(printf '%s\n' "$out" | grep . | tail -n 1 || true)"
    best="$(jq -er '.best | select(type == "number" and . >= 11 and . <= 26 and . == floor)' <<<"$line" 2>/dev/null)" || best=""
    if [[ -z "$best" ]]; then
        bashio::log.warning "BMS: замер эфира вернул непонятный ответ ('${line:0:200}') — ставлю запасной канал $bms_channel (между Wi-Fi 1 и 6)."
        return 0
    fi
    bms_channel="$best"
    bms_kind=scanned
    bashio::log.info "BMS: уровень шума по каналам (канал:дБм, меньше — тише): $(jq -r '(.results // []) | map("\(.channel):\(.rssi)") | join(" ")' <<<"$line" 2>/dev/null || echo 'нет данных')"
    bashio::log.info "BMS: выбран самый тихий канал $bms_channel."
}

# Решение: нужен ли замер. Замер — только на самом первом запуске, потому что у созданной сети
# канал менять нельзя (устройства пришлось бы подключать заново).
bms_decide_channel() {
    local note_channel="" note_kind=""

    if [[ -e "$ZIGBEE2MQTT_DATA/database.db" || -e "$ZIGBEE2MQTT_DATA/coordinator_backup.json" ]]; then
        bashio::log.info "BMS: сеть Zigbee уже создана — канал не меняю."
        return 0
    fi
    if ! bms_conf_channel="$($BMS_SEED get-channel)"; then
        bashio::log.warning "BMS: не удалось прочитать configuration.yaml — канал не трогаю."
        return 0
    fi
    if [[ -f "$BMS_CHANNEL_NOTE" ]]; then
        read -r note_channel note_kind < "$BMS_CHANNEL_NOTE" || true
    fi

    if [[ -n "$bms_conf_channel" ]]; then
        if [[ "$bms_conf_channel" != "$note_channel" ]]; then
            # Канал есть, а нашей записи о нём нет (или канал потом поменяли руками или в мастере).
            bashio::log.info "BMS: канал $bms_conf_channel задан в configuration.yaml — не меняю."
            return 0
        fi
        if [[ "$note_kind" == "scanned" ]]; then
            # Прошлый запуск замерил, но сеть создать не успел (например, не открыли мастер) — замер не повторяем.
            bashio::log.info "BMS: канал $bms_conf_channel уже выбран замером при прошлом запуске."
            return 0
        fi
        # Остался запасной канал и сеть так и не создана: прошлый замер не вышел (скорее всего неверный
        # IP или координатор занят другой программой). Сеть ещё не существует, менять канал можно.
        bashio::log.info "BMS: сети ещё нет, а канал $bms_conf_channel был запасным — пробую замерить эфир ещё раз."
    fi
    bms_scan_channel
}

bms_new_install=false
[[ -f "$BMS_CONF" ]] || bms_new_install=true
bms_decide_channel

if $bms_new_install; then
    # Нового configuration.yaml нет: записываем то, что Z2M пишет сам, плюс наши умолчания.
    # Существующий файл ниже не трогаем (кроме канала при повторном замере).
    bashio::log.info "BMS: новая установка — записываю настройки по умолчанию (мощность 13 dBm, проверка «живо ли» включена${bms_channel:+, канал $bms_channel})."
    $BMS_SEED new $bms_channel || bashio::exit.nok "BMS: не удалось создать configuration.yaml. Запуск остановлен, чтобы сеть не создалась с неверными настройками."
elif [[ -n "$bms_channel" && "$bms_channel" != "$bms_conf_channel" ]]; then
    bashio::log.info "BMS: записываю канал $bms_channel в configuration.yaml."
    $BMS_SEED set-channel "$bms_channel" || bashio::exit.nok "BMS: не удалось записать канал в configuration.yaml. Запуск остановлен, чтобы сеть не создалась на неверном канале."
fi
if [[ -n "$bms_channel" ]]; then
    printf '%s %s\n' "$bms_channel" "$bms_kind" > "$BMS_CHANNEL_NOTE"
fi

bashio::log.info "Starting Zigbee2MQTT..."
cd /app
exec node index.js
