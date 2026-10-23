# shellcheck shell=bash
# BMS: поиск координатора SLZB-06M в локальной сети. Подключается из docker-entrypoint.sh командой
# `source`, поэтому работает в той же оболочке: видит функции bashio и живёт под теми же настройками
# (errexit, nounset, pipefail). Всюду, где команда может вернуть ненулевой код «по делу»,
# стоит `if` или `|| …`.
#
# Зачем. Владелец ставит дополнение заранее, а координатор приедет позже: по умолчанию
# serial.port = auto, и вписывать IP не нужно — дополнение само находит SLZB-06M в сети Home
# Assistant и ждёт его, пока он не появится. Явный адрес владельца (tcp://…, mdns://…, /dev/…)
# главнее и работает как у официального дополнения, без поиска.
#
# Утилита ядра (core/, лежит в нашем zigbee-herdsman; в штатном её нет), договор — в README дополнения:
#   coordinatorCli.js probe tcp://IP:порт                      -> {"ok":true,"path","ezspProtocol","stackVersion","eui64"}, код 0; иначе 3
#   coordinatorCli.js discover CIDR… [--port 6638] [--eui64 0x…] -> {"found":[…]}, код 0; никого — 3; ошибка — 2
#
# Порядок (bms_find): есть запись .bms-coordinator — сначала probe по сохранённому адресу, ответил тот же
# eui64 — берём; иначе discover с --eui64 (адрес мог смениться по DHCP: находим ТОТ ЖЕ, чужой не берём).
# Записи нет — discover без фильтра, нашлось несколько — первый. Никого нет — ждём и ищем снова
# (bms_resolve_loop), а не падаем: пока координатор просто не воткнут, дополнение не сломано.

BMS_COORD_CLI=/app/node_modules/zigbee-herdsman/dist/adapter/ember/bms/coordinatorCli.js
# Что нашли и запомнили: JSON {path, eui64, ezspProtocol, stackVersion, found}. Лежит в папке данных,
# как и .bms-channel. Удаление безвредно: при следующем запуске координатор будет искаться заново.
BMS_COORD_NOTE="$ZIGBEE2MQTT_DATA/.bms-coordinator"
BMS_COORD_PORT=6638
# Версии EZSP, с которыми работает адаптер ember из нашего ядра: v13 (EmberZNet 7.4) .. v19. Это
# EZSP_MIN_PROTOCOL_VERSION и EZSP_PROTOCOL_VERSION в zigbee-herdsman (src/adapter/ember/ezsp/consts.ts);
# при обновлении ядра сверить.
BMS_EZSP_MIN=13
BMS_EZSP_MAX=19
# Все сроки — переменными окружения, чтобы проверки не ждали минутами; в работе действуют умолчания.
BMS_DISCOVER_RETRY="${BMS_DISCOVER_RETRY:-30}"     # с между поисками, пока координатора нет
BMS_FW_RETRY="${BMS_FW_RETRY:-60}"                 # с между проверками, пока прошивка старая
BMS_MSG_EVERY="${BMS_MSG_EVERY:-300}"              # не чаще раза в 5 мин одно и то же сообщение в журнале
BMS_PROBE_TIMEOUT="${BMS_PROBE_TIMEOUT:-20}"       # с на опрос одного адреса
BMS_DISCOVER_TIMEOUT="${BMS_DISCOVER_TIMEOUT:-120}" # с на поиск по сетям

# Запись об устройстве от утилиты: path вида tcp://IP:порт и eui64 вида 0x + 16 цифр (так утилита принимает и
# --eui64). Путь потом попадает в окружение Z2M и в configuration.yaml, поэтому из чужого ответа берём только то,
# что похоже на адрес. У прошивки со слишком старым (или новым) протоколом EZSP утилита отвечает ok, но eui64 у
# неё null — дальше VERSION с такой прошивкой не разговаривают. Такую запись пропускаем (иначе владелец не
# увидел бы подсказку про обновление), но запомнить её нельзя: BMS_JQ_SAVED требует настоящий eui64.
BMS_JQ_PATH='(.path | type == "string" and test("^tcp://[0-9]{1,3}(\\.[0-9]{1,3}){3}:[0-9]{1,5}$"))'
BMS_JQ_EUI='(.eui64 | type == "string" and test("^0x[0-9a-fA-F]{16}$"))'
BMS_JQ_VALID="type == \"object\" and $BMS_JQ_PATH and (.eui64 == null or $BMS_JQ_EUI)"
BMS_JQ_SAVED="type == \"object\" and $BMS_JQ_PATH and $BMS_JQ_EUI"

declare -A BMS_MSG_AT=()   # ключ сообщения -> секунда (SECONDS), когда его печатали в последний раз
BMS_NETS=()                # сети для поиска (CIDR)
BMS_NETS_SKIPPED=""        # сети, которые не ищем из-за размера (для журнала)
BMS_FOUND=()               # найденные координаторы (JSON, по одному в элементе)
BMS_REC=""                 # выбранный координатор (JSON)
BMS_WHY=""                 # почему поиск не дал результата: none | apifail | nonets
BMS_API_ERR=""             # что ответил Supervisor, если /network/info не получилось
BMS_SAVED_PATH=""          # из .bms-coordinator
BMS_SAVED_EUI=""
BMS_CLI_RC=0
BMS_CLI_OUT=""
BMS_CLI_ERR=""
BMS_SERIAL_PORT=""         # порт, с которым реально запустится Z2M (пусто — не задан); нужен замеру эфира

# --- Журнал -------------------------------------------------------------------------------------

# Пора ли печатать сообщение с этим ключом: не чаще раза в BMS_MSG_EVERY секунд. Первый раз — сразу.
# Журнал дополнения читает человек, а поиск идёт каждые полминуты: без этого одна и та же строка
# повторялась бы сотни раз в сутки и прятала всё остальное.
bms_due() {
    local key="$1" last="${BMS_MSG_AT[$1]:-}"
    if [[ -n "$last" ]] && (( SECONDS - last < BMS_MSG_EVERY )); then
        return 1
    fi
    BMS_MSG_AT[$key]="$SECONDS"
    return 0
}

# Спать до конца периода $1 секунд, который начался в момент $2 (SECONDS): сам поиск занимает несколько
# секунд, и без этого «раз в 30 с» выходило бы «раз в 36 с». Минимум секунда, чтобы не крутиться вхолостую.
bms_sleep_rest() {
    local left=$(( $1 - (SECONDS - $2) ))
    if (( left < 1 )); then
        left=1
    fi
    sleep "$left"
}

# bms_log_every <ключ> <info|warning> <текст>
bms_log_every() {
    if bms_due "$1"; then
        bashio::log."$2" "$3"
    fi
}

# --- Утилита ядра -------------------------------------------------------------------------------

# Запуск утилиты: код -> BMS_CLI_RC, последняя непустая строка stdout -> BMS_CLI_OUT (как у замера
# эфира: если утилита вдруг напишет что-то выше, результат всё равно найдётся), хвост stderr ->
# BMS_CLI_ERR. Сама всегда возвращает 0: решение — за вызывающим.
bms_cli() {
    local limit="$1" sub="$2" out err_file
    shift
    BMS_CLI_RC=0
    err_file="$(mktemp)"
    out="$(timeout "$limit" node "$BMS_COORD_CLI" "$@" 2>"$err_file")" || BMS_CLI_RC=$?
    BMS_CLI_OUT="$(printf '%s\n' "$out" | grep . | tail -n 1 || true)"
    BMS_CLI_ERR="$(tail -n 3 "$err_file" | tr '\n' ' ' || true)"
    rm -f "$err_file"
    # Код 3 — штатное «никого нет». Всё остальное (в том числе таймаут 124) — сбой самой утилиты.
    if [[ "$BMS_CLI_RC" -ne 0 && "$BMS_CLI_RC" -ne 3 ]]; then
        bms_log_every cli-error warning "BMS: утилита поиска координатора ($sub) завершилась с ошибкой (код $BMS_CLI_RC): ${BMS_CLI_ERR:-нет текста}"
    fi
}

bms_valid_rec() {
    jq -e "$BMS_JQ_VALID" <<<"$1" >/dev/null 2>&1
}

# Запись -> одной строкой для журнала.
bms_describe() {
    jq -r '"\(.path) (EUI64 \(.eui64 // "не определён"), EmberZNet \(.stackVersion // "?"), EZSP v\(.ezspProtocol // "?"))"' <<<"$1"
}

# eui64 в нижнем регистре: утилита и запись могут отличаться регистром букв — это один и тот же адрес.
bms_eui() {
    jq -r '(.eui64 // "") | ascii_downcase' <<<"$1"
}

# probe одного адреса. 0 — отозвался (запись в BMS_REC), 1 — нет.
bms_probe() {
    BMS_REC=""
    bms_cli "$BMS_PROBE_TIMEOUT" probe "$1"
    if [[ "$BMS_CLI_RC" -eq 0 ]] && jq -e '.ok == true' <<<"$BMS_CLI_OUT" >/dev/null 2>&1 && bms_valid_rec "$BMS_CLI_OUT"; then
        BMS_REC="$BMS_CLI_OUT"
        return 0
    fi
    return 1
}

# discover по сетям BMS_NETS, при непустом аргументе — только координатор с этим eui64.
# 0 — нашёлся хотя бы один (BMS_FOUND), 1 — нет.
bms_discover() {
    local eui="${1:-}" args
    BMS_FOUND=()
    args=(discover "${BMS_NETS[@]}" --port "$BMS_COORD_PORT")
    if [[ -n "$eui" ]]; then
        args+=(--eui64 "$eui")
    fi
    bms_cli "$BMS_DISCOVER_TIMEOUT" "${args[@]}"
    if [[ "$BMS_CLI_RC" -eq 0 ]]; then
        mapfile -t BMS_FOUND < <(jq -c ".found[]? | select($BMS_JQ_VALID)" <<<"$BMS_CLI_OUT" 2>/dev/null || true)
    fi
    (( ${#BMS_FOUND[@]} > 0 ))
}

# --- Сети Home Assistant ------------------------------------------------------------------------

# Сети для поиска -> BMS_NETS. Спрашиваем Supervisor (GET /network/info): для этого дополнению нужен
# только `hassio_api: true` в config.yaml, роль по умолчанию (`hassio_role: default`) пускает на любой
# `/…/info` (supervisor/api/middleware/security.py, ROLE_DEFAULT: `/.+/info`) — подробности в README.
# Берём IPv4-адреса включённых интерфейсов вместе с маской и превращаем «адрес хоста/маска» в адрес
# сети (192.168.1.5/24 -> 192.168.1.0/24), чтобы не зависеть от того, как утилита читает «хвост» адреса.
# Сети больше 1024 адресов (маска короче /22) не ищем — их утилита всё равно пропустила бы, а владельцу
# нужно сказать об этом прямо. Петлю (127/8) и link-local (169.254/16) не берём: там координатора нет.
# Код 1 — Home Assistant не ответил.
bms_networks() {
    local info plan log_file
    BMS_NETS=()
    BMS_NETS_SKIPPED=""
    # Сообщения об ошибке bashio по умолчанию идут прямо в журнал, а запрос повторяется каждые 30 с.
    # Уводим их во временный файл (LOG_FD — куда пишет bashio::log) и печатаем сами, не чаще раза в 5 минут.
    log_file="$(mktemp)"
    if ! info="$(LOG_FD=3 bashio::api.supervisor GET /network/info false 3>"$log_file")"; then
        # Из строки bashio берём только текст: цвет и «[время] ERROR:» нам не нужны, время напечатает сам журнал.
        BMS_API_ERR="$(sed -E 's/\x1b\[[0-9;]*m//g; s/^\[[0-9:]+\] [A-Z]+: //' "$log_file" | tail -n 2 | tr '\n' ' ')"
        BMS_API_ERR="${BMS_API_ERR% }"
        rm -f "$log_file"
        return 1
    fi
    rm -f "$log_file"
    if ! plan="$(jq -c '
        def ip2n: split(".") | map(tonumber) | .[0] * 16777216 + .[1] * 65536 + .[2] * 256 + .[3];
        def n2ip: [(. / 16777216 | floor) % 256, (. / 65536 | floor) % 256, (. / 256 | floor) % 256, . % 256]
                  | map(tostring) | join(".");
        [ .interfaces[]?
          | select(.enabled == true)
          | .ipv4.address[]?
          | select(type == "string" and test("^[0-9]{1,3}(\\.[0-9]{1,3}){3}/[0-9]{1,2}$"))
          | split("/") | {ip: .[0], p: (.[1] | tonumber)}
          | select(.p >= 8 and .p <= 30)
          | select((.ip | (startswith("127.") or startswith("169.254."))) | not)
          | pow(2; 32 - .p) as $size
          | {p, cidr: "\((((.ip | ip2n) / $size | floor) * $size) | n2ip)/\(.p)"} ]
        | {scan: ([.[] | select(.p >= 22) | .cidr] | unique), skipped: ([.[] | select(.p < 22) | .cidr] | unique)}
    ' <<<"$info" 2>/dev/null)"; then
        BMS_API_ERR="ответ Supervisor не разобрать"
        return 1
    fi
    mapfile -t BMS_NETS < <(jq -r '.scan[]' <<<"$plan")
    BMS_NETS_SKIPPED="$(jq -r '.skipped | join(", ")' <<<"$plan")"
    return 0
}

# --- Запись о найденном координаторе ------------------------------------------------------------

# .bms-coordinator -> BMS_SAVED_PATH / BMS_SAVED_EUI (пусто, если записи нет или она битая).
bms_note_read() {
    BMS_SAVED_PATH=""
    BMS_SAVED_EUI=""
    if [[ ! -f "$BMS_COORD_NOTE" ]]; then
        return 0
    fi
    if jq -e "$BMS_JQ_SAVED" "$BMS_COORD_NOTE" >/dev/null 2>&1; then
        BMS_SAVED_PATH="$(jq -r '.path' "$BMS_COORD_NOTE")"
        BMS_SAVED_EUI="$(bms_eui "$(cat "$BMS_COORD_NOTE")")"
    else
        bashio::log.warning "BMS: файл $BMS_COORD_NOTE повреждён — игнорирую его и ищу координатор заново."
    fi
}

# Записать выбранный координатор. Пишем только когда что-то изменилось (адрес или eui64): на каждом
# запуске перезаписывать файл на SD-карте мини-компьютера незачем. Пишем через временный файл и mv,
# чтобы обрыв питания не оставил половину файла. Не вышло — не страшно: просто найдём заново.
bms_note_write() {
    local rec="$1" tmp
    if ! jq -e "$BMS_JQ_SAVED" <<<"$rec" >/dev/null 2>&1; then
        return 0   # без eui64 запоминать нечего (сюда такая запись и не попадает: см. bms_firmware_problem)
    fi
    if [[ "$(jq -r '.path' <<<"$rec")" == "$BMS_SAVED_PATH" && "$(bms_eui "$rec")" == "$BMS_SAVED_EUI" ]]; then
        return 0
    fi
    if tmp="$(mktemp "$BMS_COORD_NOTE.XXXXXX")" \
        && chmod 644 "$tmp" \
        && jq -c --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{path, eui64, ezspProtocol, stackVersion, found: $t}' <<<"$rec" >"$tmp" \
        && mv "$tmp" "$BMS_COORD_NOTE"; then
        BMS_SAVED_PATH="$(jq -r '.path' <<<"$rec")"
        BMS_SAVED_EUI="$(bms_eui "$rec")"
    else
        rm -f "${tmp:-}"
        bashio::log.warning "BMS: не удалось записать $BMS_COORD_NOTE — в следующий раз координатор будет искаться заново."
    fi
}

# --- Прошивка -----------------------------------------------------------------------------------

# Подходит ли прошивка найденного координатора. Адаптер ember из Z2M работает с EZSP v13..v19; на старой
# прошивке он падает невнятной ошибкой, а человеку надо сказать, что делать. Печатает old | new, если
# не подходит, и ничего, если подходит (или версия протокола не известна — тогда не мешаем: пусть решает Z2M).
bms_firmware_problem() {
    local ezsp
    ezsp="$(jq -r '.ezspProtocol // empty' <<<"$1")"
    if [[ ! "$ezsp" =~ ^[0-9]+$ ]]; then
        return 0
    fi
    if (( ezsp < BMS_EZSP_MIN )); then
        echo old
    elif (( ezsp > BMS_EZSP_MAX )); then
        echo new
    fi
}

# Сообщение о неподходящей прошивке (не чаще раза в BMS_MSG_EVERY секунд). $1 — запись, $2 — old | new.
# Адрес веб-интерфейса координатора — тот же IP, что и у порта 6638: туда и надо идти в браузере.
bms_say_firmware() {
    local host
    host="$(jq -r '.path' <<<"$1")"
    host="${host#tcp://}"
    host="${host%%:*}"
    if [[ "$2" == old ]]; then
        bms_log_every firmware warning "BMS: прошивка координатора $(bms_describe "$1") устарела (нужна EZSP v$BMS_EZSP_MIN — EmberZNet 7.4 или новее). Откройте в браузере http://$host -> обновление прошивки Zigbee -> EmberZNet 7.4 или новее. Zigbee2MQTT пока не запускаю; проверяю прошивку раз в $BMS_FW_RETRY с — после обновления запуск пойдёт сам."
    else
        bms_log_every firmware warning "BMS: прошивка координатора $(bms_describe "$1") новее, чем умеет это дополнение (поддерживается EZSP от v$BMS_EZSP_MIN до v$BMS_EZSP_MAX). Откройте в браузере http://$host -> обновление прошивки Zigbee -> установите EmberZNet 7.4. Zigbee2MQTT пока не запускаю; проверяю прошивку раз в $BMS_FW_RETRY с — после смены запуск пойдёт сам."
    fi
}

# --- Поиск --------------------------------------------------------------------------------------

# Один проход поиска. 0 — координатор выбран (BMS_REC). 1 — нет, причина в BMS_WHY.
bms_find() {
    local first list rec
    BMS_REC=""
    BMS_WHY=none

    # Сначала прежнее место: для этого сети не нужны, а проверка занимает секунду.
    if [[ -n "$BMS_SAVED_PATH" ]] && bms_probe "$BMS_SAVED_PATH"; then
        if [[ "$(bms_eui "$BMS_REC")" == "$BMS_SAVED_EUI" ]]; then
            bms_log_every same-place info "BMS: координатор на прежнем месте: $(bms_describe "$BMS_REC")."
            return 0
        fi
        # По старому адресу теперь отвечает другое устройство (адрес достался чужому по DHCP).
        BMS_REC=""
    fi

    if ! bms_networks; then
        BMS_WHY=apifail
        return 1
    fi
    if (( ${#BMS_NETS[@]} == 0 )); then
        BMS_WHY=nonets
        return 1
    fi
    if [[ -n "$BMS_NETS_SKIPPED" ]]; then
        bms_log_every nets-skipped warning "BMS: сети $BMS_NETS_SKIPPED слишком большие (больше 1024 адресов) — в них координатор не ищу. Если он там, впишите его адрес вручную: Настройки -> serial -> port, например tcp://192.168.1.50:6638."
    fi

    if [[ -n "$BMS_SAVED_EUI" ]]; then
        # Только тот координатор, с которым уже работали. Чужой не берём: к нему прилипла бы сеть Zigbee.
        if bms_discover "$BMS_SAVED_EUI"; then
            BMS_REC="${BMS_FOUND[0]}"
            bms_log_every moved info "BMS: координатор сменил адрес: был $BMS_SAVED_PATH, теперь $(bms_describe "$BMS_REC")."
            return 0
        fi
        return 1
    fi

    if bms_discover ""; then
        first="${BMS_FOUND[0]}"
        if (( ${#BMS_FOUND[@]} > 1 )); then
            list="$(for rec in "${BMS_FOUND[@]}"; do printf '%s; ' "$(bms_describe "$rec")"; done)"
            bms_log_every several warning "BMS: в сети найдено несколько координаторов: ${list}беру первый. Нужен другой — впишите его адрес вручную: Настройки -> serial -> port."
        fi
        BMS_REC="$first"
        return 0
    fi
    return 1
}

# Сообщение «координатора нет» (не чаще раза в BMS_MSG_EVERY секунд) по результату bms_find.
bms_say_waiting() {
    local text hint rec
    case "$BMS_WHY" in
        apifail)
            bms_log_every apifail warning "BMS: не удалось узнать у Home Assistant, в каких сетях искать координатор (запрос к Supervisor /network/info${BMS_API_ERR:+: $BMS_API_ERR}). Повторю через $BMS_DISCOVER_RETRY с."
            ;;
        nonets)
            bms_log_every nonets warning "BMS: у Home Assistant нет включённой сети IPv4 подходящего размера, поэтому искать координатор негде${BMS_NETS_SKIPPED:+ (слишком большие сети: $BMS_NETS_SKIPPED)}. Проверьте сетевое подключение Home Assistant или впишите адрес вручную: Настройки -> serial -> port."
            ;;
        *)
            text="Жду координатор SLZB-06M в локальной сети… Подключите его кабелем к той же сети, что и Home Assistant."
            if [[ -n "$BMS_SAVED_EUI" ]]; then
                if bms_due waiting; then
                    bashio::log.info "BMS: $text Ищу именно тот координатор, с которым уже работали (EUI64 $BMS_SAVED_EUI, был по адресу $BMS_SAVED_PATH), чужие не беру. Поиск повторяется каждые $BMS_DISCOVER_RETRY с, запуск пойдёт сам."
                    # Раз в 5 минут заодно смотрим, нет ли в сети другого координатора: если владелец
                    # заменил SLZB-06M новым, без этой подсказки он не поймёт, почему дополнение ждёт.
                    if bms_discover ""; then
                        hint="$(for rec in "${BMS_FOUND[@]}"; do printf '%s; ' "$(bms_describe "$rec")"; done)"
                        bashio::log.warning "BMS: в сети есть другой координатор: ${hint%; }. Это не тот, с которым уже работали, поэтому я его не беру. Если вы заменили координатор на новый — удалите файл $BMS_COORD_NOTE и перезапустите дополнение."
                    fi
                fi
            else
                bms_log_every waiting info "BMS: $text Поиск повторяется каждые $BMS_DISCOVER_RETRY с, запуск пойдёт сам."
            fi
            ;;
    esac
}

# Ищем, пока не найдём координатор с подходящей прошивкой. Если прошивка не подходит, Z2M не запускаем:
# ждём и перепроверяем раз в минуту, после обновления запуск пойдёт сам. Пока прошивка не принята,
# в .bms-coordinator ничего не пишем. Итог — BMS_REC.
bms_resolve_loop() {
    local problem started
    while true; do
        started="$SECONDS"
        if bms_find; then
            problem="$(bms_firmware_problem "$BMS_REC")"
            if [[ -z "$problem" ]]; then
                return 0
            fi
            bms_say_firmware "$BMS_REC" "$problem"
            bms_sleep_rest "$BMS_FW_RETRY" "$started"
            continue
        fi
        bms_say_waiting
        bms_sleep_rest "$BMS_DISCOVER_RETRY" "$started"
    done
}

# Явный tcp:// владельца: поиска нет, адрес берётся как есть. Но если утилита ядра есть, прошивку
# проверяем так же: владельцу полезнее русская подсказка, чем ошибка ember. Не ответил (занят другой
# программой — к SLZB-06M подключается только одна, или выключен) — не мешаем: пусть Z2M сам
# скажет, что не так.
bms_check_explicit() {
    local port="$1" problem
    if [[ ! -f "$BMS_COORD_CLI" ]]; then
        return 0
    fi
    while true; do
        if ! bms_probe "$port"; then
            bashio::log.warning "BMS: координатор $port не ответил на проверку прошивки (выключен, нет сети или занят другой программой) — запускаю Zigbee2MQTT как есть."
            return 0
        fi
        problem="$(bms_firmware_problem "$BMS_REC")"
        if [[ -z "$problem" ]]; then
            bashio::log.info "BMS: координатор $(bms_describe "$BMS_REC") — прошивка подходит."
            return 0
        fi
        bms_say_firmware "$BMS_REC" "$problem"
        sleep "$BMS_FW_RETRY"
    done
}

# --- Точка входа --------------------------------------------------------------------------------

# Метка .bms-serial: последний serial.port, который ДОПОЛНЕНИЕ передало Z2M (найденный в режиме auto
# или явный из настроек). Нужна, чтобы отличить адрес в configuration.yaml, который записал Z2M по нашей
# просьбе, от адреса, который туда вписал сам владелец (см. bms_coordinator_setup). Как и .bms-channel,
# лежит в папке данных; удаление безвредно (тогда адрес в файле будет считаться выбором владельца).
BMS_SERIAL_NOTE="$ZIGBEE2MQTT_DATA/.bms-serial"

bms_serial_note_write() {
    local port="$1" old=""
    if [[ -f "$BMS_SERIAL_NOTE" ]]; then
        read -r old < "$BMS_SERIAL_NOTE" || true
    fi
    if [[ "$old" != "$port" ]] && ! printf '%s\n' "$port" > "$BMS_SERIAL_NOTE"; then
        bashio::log.warning "BMS: не удалось записать $BMS_SERIAL_NOTE."
    fi
}

# Решает, какой serial.port получит Z2M, и при режиме auto подставляет найденный адрес в окружение
# (ZIGBEE2MQTT_CONFIG_SERIAL_PORT — так же, как официальное дополнение передаёт настройку serial).
# Итог — BMS_SERIAL_PORT. Вызывать ПОСЛЕ export_config 'serial' (он выставил auto) и ДО выбора канала.
#
# Про configuration.yaml. Z2M записывает значения из ZIGBEE2MQTT_CONFIG_* в configuration.yaml на
# КАЖДОМ запуске (lib/util/onboarding.ts: settings.write(); lib/util/settings.ts: applyEnvironmentVariables)
# и дальше читает файл, а не окружение. Поэтому найденный адрес остаётся в файле, а адрес из настроек
# дополнения всегда главнее того, что в файле. Для явного адреса это то же, что у официального дополнения.
# Для auto это опасно: «auto» стоит по умолчанию, владелец его не выбирал, а в configuration.yaml у него
# может быть свой координатор (перенёс готовую установку, вписал адрес в интерфейсе Z2M) — найденное
# поверх тихо затёрло бы его выбор. Поэтому: если в файле стоит адрес, которого не писали мы (не auto,
# не заглушка, не тот, что в .bms-serial и .bms-coordinator), это выбор владельца: поиск не запускаем,
# окружение не выставляем. Адрес, который писали мы, перезаписывается спокойно — так и обновляется IP.
bms_coordinator_setup() {
    local opt="" adapter="" file_port="" last_port=""
    BMS_SERIAL_PORT=""

    if bashio::config.has_value 'serial.port'; then
        opt="$(bashio::config 'serial.port')"
        opt="${opt//[[:space:]]/}"
    fi

    if [[ -z "$opt" ]]; then
        return 0   # порт не задан вовсе: как у официального дополнения, Z2M берёт его из configuration.yaml
    fi

    # 'IP_SLZB' — прежняя заглушка по умолчанию: у тех, кто поставил дополнение до режима auto, она
    # так и стоит в настройках (Supervisor при обновлении настройки не меняет). Считаем её за auto.
    if [[ "${opt,,}" != auto && "$opt" != *IP_SLZB* ]]; then
        BMS_SERIAL_PORT="$opt"
        bms_serial_note_write "$opt"
        if [[ "$opt" == tcp://* ]]; then
            bms_check_explicit "$opt"
        fi
        return 0
    fi
    if [[ "$opt" == *IP_SLZB* ]]; then
        bashio::log.info "BMS: в настройках осталась прежняя заглушка IP_SLZB — работаю в режиме auto (координатор ищу сам)."
    fi

    if bashio::config.has_value 'serial.adapter'; then
        adapter="$(bashio::config 'serial.adapter')"
        if [[ "$adapter" != ember ]]; then
            bashio::exit.nok "Режим serial.port = auto умеет искать только SLZB-06M (адаптер ember), а выбран адаптер '$adapter'. Впишите адрес координатора вручную: Настройки -> serial -> port."
        fi
    fi

    bms_note_read
    if [[ -f "$BMS_SERIAL_NOTE" ]]; then
        read -r last_port < "$BMS_SERIAL_NOTE" || true
    fi
    if file_port="$($BMS_SEED get-serial-port)"; then
        if [[ -n "$file_port" && "${file_port,,}" != auto && "$file_port" != *IP_SLZB* \
            && "$file_port" != "$last_port" && "$file_port" != "$BMS_SAVED_PATH" ]]; then
            bashio::log.info "BMS: в configuration.yaml указан координатор $file_port — это выбор владельца, использую его и сам не ищу. Чтобы вернуть автопоиск, уберите строку port из раздела serial в configuration.yaml."
            unset ZIGBEE2MQTT_CONFIG_SERIAL_PORT ZIGBEE2MQTT_CONFIG_SERIAL_ADAPTER
            BMS_SERIAL_PORT="$file_port"
            return 0
        fi
    else
        bashio::log.warning "BMS: не удалось прочитать serial.port из configuration.yaml — считаю, что своего адреса там нет."
    fi

    if [[ ! -f "$BMS_COORD_CLI" ]]; then
        bashio::exit.nok "Режим serial.port = auto работает только с нашим Zigbee-ядром, а в образе стоит штатное (нет $BMS_COORD_CLI). Впишите адрес координатора вручную: Настройки -> serial -> port, например tcp://192.168.1.50:6638, сохраните и запустите дополнение снова."
    fi

    bashio::log.info "BMS: serial.port = auto — нахожу координатор SLZB-06M сам, вписывать адрес не нужно."
    bms_resolve_loop
    bms_note_write "$BMS_REC"
    BMS_SERIAL_PORT="$(jq -r '.path' <<<"$BMS_REC")"
    bms_serial_note_write "$BMS_SERIAL_PORT"
    export ZIGBEE2MQTT_CONFIG_SERIAL_PORT="$BMS_SERIAL_PORT"
    if [[ -z "$adapter" ]]; then
        export ZIGBEE2MQTT_CONFIG_SERIAL_ADAPTER=ember
    fi
    bashio::log.info "BMS: Zigbee2MQTT получит координатор $(bms_describe "$BMS_REC")."
}
