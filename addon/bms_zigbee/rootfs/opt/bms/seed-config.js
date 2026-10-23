// BMS: правки configuration.yaml, которые делает docker-entrypoint.sh до запуска Zigbee2MQTT.
//
// Почему не переменные окружения ZIGBEE2MQTT_CONFIG_*, как у остальных настроек дополнения:
// Z2M накладывает их на configuration.yaml при КАЖДОЙ записи (lib/util/settings.ts: write ->
// applyEnvironmentVariables). Значение из окружения тогда перебивает всё, что владелец потом
// поменяет в интерфейсе или в файле, — а нам нужно «значение по умолчанию», а не «приказ».
// Здесь же настройки записываются один раз, дальше configuration.yaml принадлежит владельцу.
//
// Используется только то, что Z2M делает сам (его собственные функции из образа), поэтому
// формат файла и «GENERATE» для сетевого ключа остаются как у обычной новой установки.
// Версия Z2M в образе закреплена (versions.json), при обновлении — проверить, см. README.md.
//
// Команды:
//   get-channel        напечатать advanced.channel из configuration.yaml (пусто, если файла или ключа нет)
//   get-serial-port    напечатать serial.port из configuration.yaml (пусто, если файла или ключа нет)
//   new [канал]        создать configuration.yaml для НОВОЙ установки: как Z2M при первом запуске
//                      + наши настройки по умолчанию + (если дан) канал; без мастера настройки
//   set-channel канал  записать канал в уже существующий configuration.yaml
'use strict';
const fs = require('node:fs');

const Z2M = '/app/dist/util';
const settings = require(`${Z2M}/settings`);
const data = require(`${Z2M}/data`).default;

const CONFIG = data.joinPath('configuration.yaml');

function parseChannel(text) {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 11 || n > 26) {
        throw new Error(`канал '${text}' не из диапазона 11–26`);
    }
    return n;
}

function main() {
    const [cmd, arg] = process.argv.slice(2);
    switch (cmd) {
        case 'get-channel': {
            if (fs.existsSync(CONFIG)) {
                const channel = settings.getPersistedSettings().advanced?.channel;
                if (channel !== undefined && channel !== null) {
                    console.log(String(channel));
                }
            }
            return;
        }
        case 'get-serial-port': {
            // Нужен режиму auto, чтобы не затереть адрес, который владелец вписал в файл сам
            // (docker-entrypoint.sh / coordinator.sh). Читаем только файл: окружение на этот ответ
            // влиять не должно, поэтому на всякий случай убираем из него serial.port, который выставил entrypoint.
            delete process.env.ZIGBEE2MQTT_CONFIG_SERIAL_PORT;
            if (fs.existsSync(CONFIG)) {
                const port = settings.getPersistedSettings().serial?.port;
                if (port !== undefined && port !== null) {
                    console.log(String(port));
                }
            }
            return;
        }
        case 'new': {
            if (fs.existsSync(CONFIG)) {
                throw new Error('configuration.yaml уже есть — «новую» установку поверх него не создаём');
            }
            const channel = arg === undefined ? undefined : parseChannel(arg);

            // Тот же файл, что Z2M пишет сам при первом запуске (в него уже попали serial, mqtt,
            // frontend и enable_external_js из окружения, которое выставил entrypoint).
            settings.writeMinimalDefaults();

            // Мощность передатчика. У штатного шлюза Tuya обычная мощность — 13 dBm; Z2M без этой
            // настройки оставляет мощность по умолчанию самого чипа. Больше — не значит лучше:
            // сильный координатор «перекрикивает» устройства, которые его не слышат в ответ.
            settings.set(['advanced', 'transmit_power'], 13);

            // Проверка «живо ли». Шлюз Tuya постоянно опрашивает устройства; в Z2M это availability.
            //  - active (устройства от сети, они же маршрутизаторы): если от устройства 10 минут
            //    ничего не было, Z2M само его опрашивает, и только после неудачи помечает «не в сети».
            //    10 мин — значение по умолчанию Z2M (schema: availability.active.timeout, минимум 1);
            //    чаще нет смысла: опросы нагружают эфир, а выключенную розетку мы заметим и так.
            //  - passive (на батарейках, сами не отвечают): 1500 мин = 25 часов. Датчики на батарейках
            //    могут молчать сутки; меньший срок давал бы ложное «не в сети». Это тоже значение по
            //    умолчанию Z2M (schema: availability.passive.timeout).
            // Значения записаны явно, хотя совпадают с умолчаниями Z2M: так видно, что это наш выбор,
            // и он не изменится сам, если в новой версии Z2M поменяют умолчания.
            settings.set(['availability'], {enabled: true, active: {timeout: 10}, passive: {timeout: 1500}});

            if (channel !== undefined) {
                settings.set(['advanced', 'channel'], channel);
            }

            // Мастер быстрой настройки НЕ включаем. Z2M показывает его по отсутствию configuration.yaml
            // (lib/util/onboarding.ts: onboard), но в нём спрашивают ровно то, что дополнение уже знает
            // из своих настроек (адрес координатора, MQTT), плюс канал, который мы подобрали замером.
            // Лишний экран на английском для владельца — это лишний шаг, а цель «вписал IP и работает».
            // Сетевой ключ и PAN ID Z2M сам сгенерирует при первом старте (значения GENERATE выше).
            // Вернуть мастер: добавить сюда settings.setOnboarding(true) или включить force_onboarding.
            return;
        }
        case 'set-channel': {
            if (!fs.existsSync(CONFIG)) {
                throw new Error('нет configuration.yaml');
            }
            settings.set(['advanced', 'channel'], parseChannel(arg));
            return;
        }
        default:
            throw new Error(`неизвестная команда '${cmd}'`);
    }
}

try {
    main();
} catch (error) {
    console.error(`seed-config: ${error.message}`);
    process.exit(3);
}
