ARG BUILD_FROM
FROM $BUILD_FROM as base

ENV LANG C.UTF-8
ARG BUILD_VERSION

RUN apk add --no-cache socat tini nodejs eudev && \
    # Validation to confirm that curl is installed in the base image.
    curl --version || (echo "curl missing" && exit 1)

# Dependencies and build
FROM base as dependencies_and_build

# BMS: ARG из стадии base в эту стадию наследует только BuildKit (так собирает CI официального
# дополнения). Классический сборщик Docker его теряет, и ниже вместо версии Z2M получалась
# пустая строка («Installing Stable version », tar: invalid magic). Повторное объявление
# безвредно для BuildKit и чинит классический сборщик.
ARG BUILD_VERSION

# BMS: каталог vendor/ есть всегда (в нём .gitkeep), чтобы COPY не падал; наше ядро
# zigbee-herdsman.tgz лежит там только если его положил stage.sh. Нет файла — собираем
# штатный zigbee-herdsman, как официальное дополнение.
COPY vendor /vendor

RUN apk add --no-cache --virtual .buildtools npm make gcc g++ linux-headers udev git python3 && \
    if [ "${BUILD_VERSION}" = "edge" ]; \
    then \
        echo "Installing Edge version" && \
        git clone -b dev --single-branch --depth 1 \
        https://github.com/Koenkk/zigbee2mqtt.git /app && \
        mkdir /app/dist && \
        jq -n --arg commit $(eval cd /app;git rev-parse --short HEAD) '$commit' > /app/dist/.hash ; \
    else \
        echo "Installing Stable version ${BUILD_VERSION%-*}" && \
        curl -sL -o "/app.tar.gz" \
        "https://github.com/Koenkk/zigbee2mqtt/archive/${BUILD_VERSION%-*}.tar.gz" && \
        tar xzvf "/app.tar.gz"  && rm "/app.tar.gz" && \
        mv -v "zigbee2mqtt-${BUILD_VERSION%-*}" app && \
        mkdir /app/dist && \
        jq -n --arg commit ${BUILD_VERSION%-*} '$commit' > /app/dist/.hash ; \
    fi; \
    echo "Installed Zigbee2MQTT @ version $(cat /app/dist/.hash)" && \
    cd /app && \
    npm install -g $(jq -r '.packageManager' package.json) && \
    # BMS: если в vendor/ лежит наше ядро — подменяем им zigbee-herdsman целиком (и тот, что
    # просит сам Z2M, и тот, что просит zigbee-herdsman-converters, иначе в образе окажутся две
    # копии). Z2M ставится через pnpm, поэтому «overrides» пишем в pnpm-workspace.yaml.
    # Подмена меняет lock-файл, а --frozen-lockfile на это справедливо ругается: в этом случае
    # ставим без «замороженного» режима — pnpm берёт из lock-файла всё, что не затронуто подменой.
    FROZEN="--frozen-lockfile" && \
    if [ -f /vendor/zigbee-herdsman.tgz ]; then \
        echo "BMS: zigbee-herdsman подменён нашим ядром $(tar -xOzf /vendor/zigbee-herdsman.tgz package/package.json | jq -r '.name + " " + .version')" && \
        printf '\noverrides:\n  zigbee-herdsman: file:/vendor/zigbee-herdsman.tgz\n' >> pnpm-workspace.yaml && \
        FROZEN="--no-frozen-lockfile" ; \
    else \
        echo "BMS: vendor/zigbee-herdsman.tgz нет — штатный zigbee-herdsman, как в официальном дополнении" ; \
    fi && \
    pnpm install $FROZEN --unsafe-perm && \
    pnpm run build && \
    rm -rf node_modules && \
    pnpm install $FROZEN --no-optional --unsafe-perm --prod && \
    echo "BMS: установлен zigbee-herdsman $(jq -r .version node_modules/zigbee-herdsman/package.json)" && \
    # force serialport to rebuild on current platform instead of using prebuilds
    rm -rf `find ./node_modules/.pnpm/ -wholename "*/@serialport/bindings-cpp/prebuilds" -type d` && \
    pnpm rebuild @serialport/bindings-cpp

# Release
FROM base as release

WORKDIR /app

COPY rootfs /
# BMS: наш слой Tuya (файлы bms-*). Лежит в образе отдельно, а в папку данных Z2M его
# при каждом запуске копирует docker-entrypoint.sh: папка данных живёт на диске Home Assistant,
# а обновление дополнения должно обновлять и слой.
COPY bms-layer /opt/bms-layer
COPY --from=dependencies_and_build /app/node_modules ./node_modules
COPY --from=dependencies_and_build /app/dist ./dist
COPY --from=dependencies_and_build /app/package.json /app/LICENSE /app/index.js ./

ENV NODE_ENV production

HEALTHCHECK --interval=1m --timeout=3s --start-period=30s --start-interval=3s \
  CMD curl -f http://localhost:8099/

ENTRYPOINT [ "/sbin/tini", "--", "/docker-entrypoint.sh"]
