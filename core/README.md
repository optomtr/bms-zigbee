# core — наше Zigbee-ядро (zigbee-herdsman + патчи)

## Зачем

Zigbee2MQTT (Z2M) закрывает Zigbee-ядро — библиотеку **zigbee-herdsman** — от внешних
дополнений. Чтобы устройства Tuya работали через нашу сеть так же, как через родной хаб Tuya,
нужна маленькая правка в драйвере Silicon Labs (`src/adapter/ember/`): APS-повтор, мощность
передачи при переподключении устройства, перестройка маршрутов, энергоскан для выбора канала.
Это возможно только в своей копии ядра. (Чистку списка «детей» координатора не делаем: у шлюза
Tuya такая функция есть, но её вызовов в его коде не найдено.)

Чтобы копия не «уплывала» от upstream, мы **не держим форк**. Здесь лежат:

- закреплённая версия ядра (берётся из `../versions.json`, сейчас 10.10.0);
- наши патчи `patches/*.patch` — маленькие, по одному на смысл;
- `build.sh` — берёт чистый тег upstream, накладывает патчи, собирает, гоняет тесты и
  упаковывает tgz с версией `10.10.0-bms.N`, чтобы по журналу Z2M было видно, что стоит наше ядро.

Сейчас патчей четыре, ревизия `10.10.0-bms.2` (что и зачем — раздел «Наши патчи» ниже).

## Что здесь лежит

| Путь | Что |
|---|---|
| `build.sh` | сборка (см. ниже) |
| `patches/` | наши патчи `0001…0004` (см. «Наши патчи») |
| `BMS_REVISION` | число N в версии `X.Y.Z-bms.N`; растёт при каждом изменении набора патчей |
| `upstream/` | исходники upstream с патчами (создаёт `build.sh`, в .gitignore) |
| `dist/` | готовый `zigbee-herdsman-X.Y.Z-bms.N.tgz` (в .gitignore) |
| `.work/` | временное (в .gitignore) |

## Как собрать

Нужны: node >= 22.2, git, интернет (GitHub и npm). pnpm ставить не надо — скрипт берёт ту
версию, что upstream закрепил у себя (`packageManager`), через `npx`.

```bash
cd ~/bms-zigbee/core
./build.sh
```

Что делает, по шагам (любой сбой — остановка с ненулевым кодом):

1. читает версию из `../versions.json` и номер из `BMS_REVISION`;
2. клонирует тег `v<версия>` из `Koenkk/zigbee-herdsman` в `upstream/` (каждый раз заново);
3. накладывает `patches/*.patch` по порядку имён; не лёг патч — падает и называет его;
4. `pnpm install --frozen-lockfile`, затем `biome check` (проверка стиля, как в CI upstream);
5. ставит версию `X.Y.Z-bms.N` и поле `bms` (база, ревизия, список патчей) в package.json;
6. `tsc`, тесты драйвера ember, затем весь набор тестов;
7. `pnpm pack` -> `dist/zigbee-herdsman-X.Y.Z-bms.N.tgz`, проверяет версию внутри архива и то,
   что в нём есть `dist/adapter/ember/bms/energyScanCli.js` и `coordinatorCli.js` (контракты с дополнением),
   печатает sha256.
   Сборка воспроизводима: тот же набор патчей даёт тот же sha256.

Занимает около минуты. `./build.sh --prepare` делает только шаги 1–3 (нужно для написания патча).

## Как добавить патч

```bash
cd ~/bms-zigbee/core
./build.sh --prepare          # свежий upstream/ с уже наложенными патчами
cd upstream
# правим файлы в src/adapter/ember/..., при необходимости тесты в test/adapter/ember/
npx --yes pnpm@12.3.4 install --frozen-lockfile    # версия pnpm — из packageManager в upstream/package.json
npx --yes pnpm@12.3.4 run check                    # стиль
npx --yes pnpm@12.3.4 run build && npx --yes pnpm@12.3.4 run test test/adapter/ember
git add -A && git diff --cached > ../patches/0001-короткое-имя.patch
cd .. && echo 1 > BMS_REVISION    # на единицу больше прежнего
./build.sh                        # итоговая проверка и tgz
```

Правила:

- Имя `NNNN-короткое-имя.patch` (латиница); порядок наложения — по имени.
- Патч делается `git diff` поверх уже наложенных (`build.sh` коммитит каждый патч в `upstream/`,
  поэтому в diff попадает только новый).
- Перед первой строкой `diff --git` можно писать обычный текст: **зачем** патч и что он меняет —
  `git apply` его пропускает (проверено).
- Меняется поведение — правим/добавляем тест в `test/adapter/ember/` в том же патче.
- Патч держим маленьким и в стиле upstream: чем меньше строк, тем реже конфликты при обновлении.
- Перед `git add -A` смотрим `git status`: в `upstream/` бывают чужие следы (например, папка
  `.claude-flow/` от хуков) — в патч они попасть не должны (`echo .claude-flow/ >> .git/info/exclude`).

## Наши патчи (ревизия bms.2)

Всё — только драйвер ember (`src/adapter/ember/`); z-stack и прочие адаптеры не тронуты; сетевые
ключи и PAN не трогаются. Образец поведения — шлюз Tuya. В журнале Z2M наши строки начинаются с `BMS:` (пространство `zh:ember`).

**0001-aps-retry-unicast** — APS-повтор для всех одноадресных ZCL-кадров.
Upstream в `sendZclFrameToEndpoint` снимал `RETRY`, если ответа не ждут, а команды Tuya
(`0xEF00 dataRequest`) converters шлют именно так — с `disableDefaultResponse` и без ответа. Один
потерянный по дороге через сеть кадр = потерянная команда («рядом работает, через сеть — нет»).
Шлюз Tuya шлёт одноадресные кадры с повтором (опции `0x1040` = RETRY | ENABLE_ADDRESS_DISCOVERY).
Теперь RETRY остаётся всегда (остальные опции — как в upstream: `0x1140`). Широковещательные и
групповые кадры не тронуты.

**0002-rejoin-power-and-routes** — при переподключении (rejoin) устройства, как шлюз Tuya:
- *Что считаем переподключением:* `trustCenterJoin` со статусом `STANDARD_SECURITY_SECURED_REJOIN` (0)
  или `STANDARD_SECURITY_UNSECURED_REJOIN` (3) из `EmberDeviceUpdate` (`src/adapter/ember/enums.ts`),
  и решение не `DENY_JOIN`. `UNSECURED_JOIN` (1) — новое подключение, `DEVICE_LEFT` (2) — уход.
- *Мощность:* база = `transmit_power` из настроек Z2M (если задана и применилась при старте), иначе
  текущая мощность радио (`radioTxPower` из `ezspGetNetworkParameters`). При базе < 18 — 19 dBm, база
  возвращается через 60 с после ПОСЛЕДНЕГО переподключения (новое продлевает окно). При базе 18/19
  не трогаем. Журнал: `BMS: transmit power set to 19 dBm (rejoin of <узел>).` и
  `BMS: transmit power set to <база> dBm (rejoin window over).`
- *Маршруты:* узел запоминается; на его первое входящее сообщение (ZCL или ZDO, например Device
  Announce) — `ezspSendManyToOneRouteRequest` с параметрами концентратора из стек-конфига (те же, что
  в `initNCPConcentrator`), не чаще раза в 30 с; узел убирается из списка (запрос широковещательный и
  обновляет маршруты всей сети). Журнал: `BMS: many-to-one route request sent after rejoin of <узел>.`
- При остановке адаптера таймеры снимаются, поднятая мощность возвращается к базе.
- Все вызовы EZSP идут через очередь адаптера (`this.queue`); `deviceJoined` их не ждёт.

**0003-energy-scan-cli** — энергоскан для выбора канала (Tuya создаёт сеть плагином Network Creator:
энергоскан и самый тихий канал; Z2M берёт канал из настроек). Новые файлы
`src/adapter/ember/bms/energyScan.ts` и `energyScanCli.ts`; код upstream не меняется.

КОНТРАКТ с дополнением (не менять без дополнения):

```bash
node <пакет>/dist/adapter/ember/bms/energyScanCli.js tcp://192.168.1.50:6638
# stdout — ОДНА строка: {"results":[{"channel":11,"rssi":-85},...],"best":15}   код выхода 0
# любая ошибка — код выхода 2 и понятный текст в stderr; stdout пуст
```

- Каналы 11, 15, 20, 25; `rssi` — максимум энергии на канале, dBm. Канал без отчёта NCP пропускается
  (строка в stderr); если не измерен ни один — ошибка.
- `best` — наименьший `rssi`; при равенстве меньший номер, но 11 — последним (он на Wi-Fi канале 1).
- Скан: `Ezsp.start()` (сброс NCP по ASH), согласование версии EZSP, `ezspStartScan(ENERGY_SCAN,
  маска, 6)` — около 1 с на канал, ожидание до 30 с. `ezspNetworkInit` и прочие сетевые команды не
  вызываются: сеть на координаторе не создаётся и не трогается (если она есть, её поднимет Z2M).
- Журнал ядра идёт в stderr (только предупреждения и ошибки; всё — при `BMS_DEBUG=1`).
- Запускать, пока Z2M **не** подключён к координатору: скан сбрасывает NCP (ASH RST) и сорвал бы
  сеанс Z2M.

**0004-coordinator-probe-cli** — поиск координатора в сети и проверка прошивки, чтобы владелец не вводил IP.
Новые файлы `src/adapter/ember/bms/coordinatorProbe.ts`, `coordinatorCli.ts` и общий с энергосканом
`ezspSession.ts` (сброс NCP + согласование версии EZSP как в адаптере, `ezsp.stop()` всегда, обвязка CLI;
энергоскан переведён на него, его контракт не менялся). Код upstream не меняется.

КОНТРАКТ с дополнением (не менять без дополнения):

```bash
node <пакет>/dist/adapter/ember/bms/coordinatorCli.js probe tcp://192.168.1.50:6638
# {"ok":true,"path":"tcp://192.168.1.50:6638","ezspProtocol":13,"stackVersion":"7.4.4.0","eui64":"0x…"}  код 0
# {"ok":false,"path":"tcp://…","error":"…"}  код 3 — порт закрыт / не EZSP / таймаут (15 с)
node <пакет>/dist/adapter/ember/bms/coordinatorCli.js discover 192.168.1.37/24 [ещё CIDR…] [--port 6638] [--eui64 0x…]
# {"found":[{"path":"tcp://…","ezspProtocol":13,"stackVersion":"…","eui64":"…"}]}  код 0 — найден, 3 — никого
# неверные аргументы / внутренняя ошибка — код 2, текст в stderr, stdout пуст
```

- probe шлёт только то, с чего начинает сам адаптер: сброс ASH, VERSION (и второй — с версией NCP),
  `GET_VALUE(VERSION_INFO)` → `stackVersion` = major.minor.patch.special (как `emberVersion`),
  `GET_EUI64` (как `initEzsp`). Сеть не создаётся и не трогается; сокет закрывается всегда, и сразу после
  probe к координатору подключается следующий клиент (проверено на поддельном NCP).
- Протокол вне 13…19 (что умеет ember-адаптер Z2M): `ok:true` с настоящим `ezspProtocol`, `stackVersion`
  из ответа VERSION (по полубайту), `eui64:null`, и больше ничего не шлётся. Дополнению: `ezspProtocol < 13` —
  «обновите прошивку»; с `--eui64` такой координатор не совпадёт.
- discover: адрес интерфейса (`192.168.1.37/24`) превращается в сеть; без адреса сети и широковещательного;
  сеть больше 1024 адресов (шире /22) пропускается с заметкой в stderr; повторяющиеся адреса — один раз.
  TCP-подключение 400 мс, до 64 сразу (/24 — около 2 с); открытые порты проверяются probe по одному.
  Заметки (пропуск сети, «не EZSP», «EUI64 не тот») — в stderr.
- Как и энергоскан, запускать, пока Z2M **не** подключён: probe сбрасывает NCP.

## Как перейти на новую версию Z2M

1. Узнать, какое ядро и какие converters нужны новому Z2M (он закрепляет их точными версиями):
   ```bash
   npm view zigbee2mqtt@<новая> dependencies.zigbee-herdsman dependencies.zigbee-herdsman-converters
   ```
2. В `../versions.json` поменять `zigbee2mqtt`, `zigbee-herdsman`, `zigbee-herdsman-converters`
   и `ha-addon-upstream` (версия кода — только там, не в скриптах).
3. `echo 0 > BMS_REVISION` (новая база — счёт ревизий с нуля).
4. Посмотреть, что upstream поменял в ember между версиями:
   `https://github.com/Koenkk/zigbee-herdsman/compare/v<старая>...v<новая>` и `CHANGELOG.md`.
5. `./build.sh`. Если патч не лёг, сообщение называет его — перенос:
   ```bash
   mkdir -p .work/old-patches && mv patches/0002-имя.patch .work/old-patches/   # и все патчи после него
   ./build.sh --prepare
   cd upstream
   git apply --reject --whitespace=nowarn ../.work/old-patches/0002-имя.patch   # что смогло — применится, остальное в *.rej
   # доделываем руками по смыслу патча, затем удаляем *.rej и *.orig
   git add -A && git diff --cached > ../patches/0002-имя.patch
   ```
   и снова `./build.sh`.
6. Проверить с настоящим Z2M новой версии (раздел ниже): одна копия ядра с `-bms.N` и строка в журнале.
7. Проверка на железе (координатор SLZB-06M, живые устройства) — вручную; скриптом не покрыта.

## Проверка, что tgz подходит к Z2M

Z2M и converters закрепляют herdsman точно (`"zigbee-herdsman": "10.10.0"`), поэтому подмена
идёт через `overrides` — тогда в дереве остаётся одна копия, наша. Z2M при этом
стартует с ядра и падает без адаптера — это ожидаемо, MQTT для проверки не нужен.

```bash
cd ~/bms-zigbee/core
TGZ=dist/zigbee-herdsman-$(node -p "require('../versions.json')['zigbee-herdsman']")-bms.$(cat BMS_REVISION).tgz
Z2M=$(node -p "require('../versions.json').zigbee2mqtt")
rm -rf .work/z2m-check && mkdir -p .work/z2m-check/data && cd .work/z2m-check
cat > package.json <<EOF
{"name":"z2m-check","private":true,
 "dependencies":{"zigbee2mqtt":"$Z2M"},
 "overrides":{"zigbee-herdsman":"file:../../$TGZ"}}
EOF
cat > data/configuration.yaml <<'EOF'
version: 5
mqtt: {server: "mqtt://127.0.0.1:1883"}
serial: {port: "tcp://127.0.0.1:6638", adapter: ember}
frontend: {enabled: false}
homeassistant: {enabled: false}
EOF
npm install --no-audit --no-fund
npm ls zigbee-herdsman --all          # одна копия: zigbee-herdsman@X.Y.Z-bms.N overridden / deduped
# GIT_DIR: Z2M сверяет свою сборку с `git rev-parse HEAD` текущей папки; внутри репозитория bms-zigbee
# он увидит чужой коммит и полезет пересобираться через pnpm — отключаем
GIT_DIR=/nonexistent ZIGBEE2MQTT_DATA=$PWD/data node node_modules/zigbee2mqtt/index.js 2>&1 | grep -E "Starting zigbee-herdsman|ECONNREFUSED"
```

Ожидаемо: `Starting zigbee-herdsman (10.10.0-bms.N)` и `connect ECONNREFUSED 127.0.0.1:6638`.

## Проверка энергоскана без железа (поддельный NCP)

`.work/fake-ncp/fake-ncp.js` (временное, не в git) — поддельный NCP по EZSP/ASH поверх TCP: отвечает на
RST, VERSION (как EmberZNet 7.4.4.0 — EZSP v13, хосту приходится согласовывать версию), START_SCAN (шлёт
отчёты по каналам), `GET_VALUE(VERSION_INFO)` и `GET_EUI64` (`0x0017880104abcdef`). Свой кодировщик ASH
сверяет с кадрами, записанными в тестах upstream. Любую другую команду EZSP записывает в `unexpected`.
`--ezsp 8` — старая прошивка (EmberZNet 6.10.3), `--connections N` — выключиться после N соединений
(discover сперва только проверяет порт, потом подключается probe). На каждое соединение печатает сводку;
`socketError` в ней — хост закрыл сокет не чисто.

```bash
cd ~/bms-zigbee/core/.work/fake-ncp
node fake-ncp.js 16640 '{"11":-90,"15":-90,"20":-70,"25":-85}' > fake.out &
node <пакет>/dist/adapter/ember/bms/energyScanCli.js tcp://127.0.0.1:16640; echo "exit=$?"
cat fake.out    # {"commands":[0,0,26],"unexpected":[],...}: только VERSION x2 и START_SCAN

node fake-ncp.js 16641 '{}' --connections 2 > fake.out &
node <пакет>/dist/adapter/ember/bms/coordinatorCli.js discover 127.0.0.1/32 --port 16641; echo "exit=$?"
cat fake.out    # проверка порта: commands []; probe: [0,0,170,38] — VERSION x2, GET_VALUE, GET_EUI64
```

## Что проверено

Ревизия bms.2 (четыре патча), 23.10.2026, macOS arm64, node 22:

- `./build.sh` целиком зелёный: патчи легли, biome чисто; тесты ember — 299 прошло, 1 пропущен (8 файлов),
  весь набор — 1891 прошло, 1 пропущен (37 файлов); повторов (`--retry`) не понадобилось;
  `dist/zigbee-herdsman-10.10.0-bms.2.tgz`, в нём `package/dist/adapter/ember/bms/coordinatorCli.js`;
  sha256 `c2c80c3f…a81a` — одинаковый у двух сборок подряд.
- Тесты ember **без** `--retry`: 5 прогонов подряд — все зелёные. Покрытие `src/adapter/ember/**` — 100 %.
- Тесты краснеют на поломке (сломал — проверил — вернул): probe читает EUI64 у старой прошивки → 4 красных;
  убрать `ezsp.stop()` из сеанса → 20; /22 считать «слишком большой» → 1; выключить фильтр EUI64 → 2;
  probe без координатора с кодом 0 → 1; без таймаута probe → 1; брать адрес сети и широковещательный → 3.
- CLI из tgz (поставлен `npm install` в пустую папку) против поддельного NCP по TCP:
  - `probe` → код 0, `{"ok":true,…,"ezspProtocol":13,"stackVersion":"7.4.4.0","eui64":"0x0017880104abcdef"}`;
    NCP получил только `[0,0,170,38]`, сокет закрыт чисто; сразу следом энергоскан на том же NCP — код 0.
  - старая прошивка (`--ezsp 8`) → код 0, `"ezspProtocol":8,"stackVersion":"6.10.3.0","eui64":null`, NCP
    получил только один VERSION.
  - закрытый порт → код 3, `"error":"Failed to start EZSP layer with status=HOST_FATAL_ERROR."`;
    открытый порт без EZSP → код 3 через 15 с (`No EZSP answer within 15000ms.`).
  - `discover 127.0.0.1/32` и `discover 127.0.0.0/24` (254 адреса, 1,8 с) → код 0, найден поддельный NCP;
    с чужим `--eui64` → код 3, `{"found":[]}`; `127.0.0.0/24` без NCP → код 3 за 1,7 с;
    `10.0.0.0/16` → пропуск с заметкой в stderr; неверные аргументы → код 2, stdout пуст.

Ревизия bms.1 (три патча), 23.10.2026, macOS arm64, node 22:

- `./build.sh` целиком зелёный: патчи легли, biome чисто, тесты ember — 225 прошло, 1 пропущен
  (7 файлов), весь набор — 1817 прошло, 1 пропущен (36 файлов); `dist/zigbee-herdsman-10.10.0-bms.1.tgz`,
  sha256 `5d91a85a…3e81` — одинаковый у двух сборок подряд.
- Тесты ember **без** `--retry` (`npx --yes pnpm@12.3.4 run test test/adapter/ember` в `upstream/`):
  6 прогонов подряд — все зелёные. Наши тесты идут только на поддельных таймерах.
- Покрытие `src/adapter/ember/**` тестами ember — 100 % (строки/ветви/функции), как требует upstream.
- Тесты краснеют на поломке (сломал — проверил — вернул):
  вернуть снятие RETRY → 3 теста красные (в т.ч. «Tuya dataRequest … with APS RETRY»);
  считать переподключением только SECURED_REJOIN → красный; не продлевать окно 60 с → красный;
  убрать ограничение 30 с → красный; убрать правило «11 последним» → красный; убрать гашение позднего
  отказа скана → Unhandled Rejection, прогон красный; вызвать из скана `ezspNetworkInit` → 10 красных.
- В tgz есть `package/dist/adapter/ember/bms/energyScanCli.js` (проверяет и `build.sh`).
- tgz поставлен через `npm install` в пустую папку; CLI из него против поддельного NCP по TCP: код 0,
  в stdout одна строка `{"results":[…4 канала…],"best":15}` (11 и 15 равны — выбран 15), stderr пуст;
  NCP получил только VERSION, VERSION (согласование до v13) и START_SCAN (маска 11/15/20/25,
  длительность 6), ни одной сетевой команды. Ошибки: без аргумента — код 2 и подсказка; закрытый порт —
  код 2, `Failed to start EZSP layer with status=HOST_FATAL_ERROR.`; NCP без отчётов — код 2,
  `No channel was measured.`; stdout во всех ошибках пуст.
- Z2M 2.14.2 + наш tgz через `overrides`: одна копия ядра, Z2M печатает
  `Starting zigbee-herdsman (10.10.0-bms.1)`.

Ревизия bms.0 (без патчей):

- `./build.sh` на чистом upstream v10.10.0 (патчей нет): biome чисто; тесты ember — 188 прошло,
  1 пропущен (6 файлов); весь набор — 1780 прошло, 1 пропущен (35 файлов); получился
  `dist/zigbee-herdsman-10.10.0-bms.0.tgz`.
- Механизм патчей на временном патче (строка журнала в `EmberAdapter.start()`, лежал в `.work/`,
  не в `patches/`): наложился, сборка и тесты зелёные, строка попала в `dist` и в журнал Z2M.
  Повторная сборка даёт тот же sha256.
- Сломанный патч: сборка останавливается на шаге 3, печатает `ПАТЧ НЕ ЛЁГ: <имя>`, код выхода 1,
  tgz не создаётся.
- Z2M 2.14.2 из npm + наш tgz через `overrides`: в дереве одна копия ядра `10.10.0-bms.0`
  (и у Z2M, и у converters); Z2M печатает `Starting zigbee-herdsman (10.10.0-bms.0)`.
- Внутри tgz нет нативного кода (только `dist` на JS) — он не привязан к платформе;
  нативный `@serialport/bindings-cpp` ставит тот, кто устанавливает пакет.

## Что не проверено / на что смотреть

- Поиск координатора (0004) — только на поддельном NCP на 127.0.0.1: не проверено с SLZB-06M в настоящей
  сети — что его прошивка отвечает на VERSION_INFO/EUI64 так же, что подключение «открыл-закрыл» при
  проверке порта ему не мешает и что сразу после probe к нему подключается Z2M; на что похожи другие
  устройства с открытым 6638 (SLZB-06 на Z-Stack отвечает не EZSP → `ok:false` через 15 с). Только IPv4.
- Всё про настоящее радио — только на поддельном EZSP: SLZB-06M и живые устройства не подключались.
  На железе проверить: (1) энергоскан на SLZB-06M — `ezspStartScan` до `networkInit` принимается,
  отчёты приходят по всем 4 каналам, скан укладывается в 30 с, сеть после него поднимается Z2M как была;
  (2) переподключение даёт статусы 0/3 (а не 1) в `trustCenterJoin`; (3) 19 dBm принимается прошивкой
  и возвращается база (`BMS:` строки в журнале); (4) many-to-one route request после переподключения
  не мешает трафику; (5) APS-повтор: команды Tuya через 2–3 хопа доходят (сравнить с хабом Tuya —
  задача замерщика).
- Если `transmit_power` в Z2M не задан, база = то, что стоит на радио. Сеть, созданная Z2M без
  `transmit_power`, получает 5 dBm (так upstream `formNetwork`), шлюз Tuya держит 13. Дополнению стоит
  задать `advanced.transmit_power: 13`. Если процесс убит (SIGKILL) в окне 60 с, на радио может
  остаться 19 dBm: при заданном `transmit_power` Z2M вернёт базу при старте, без него 19 станет базой.
- APS-повтор на кадрах «без ответа» держит буфер NCP дольше (ждёт APS ACK); при очень плотном трафике
  чаще возможен `ZIGBEE_MAX_MESSAGE_LIMIT_REACHED` (адаптер на него ждёт и повторяет). Не мерили.
- Сборка только на macOS (arm64). На Linux/в контейнере дополнения не гонялась (там нужны те же
  node, git, интернет).
- Подмена через `overrides` проверена для npm. Если дополнение будет ставить Z2M через pnpm,
  то нужен `pnpm.overrides` — проверить отдельно.
- Версия `10.10.0-bms.0` по semver — пререлиз, то есть *меньше* `10.10.0`. Поэтому точный pin в
  Z2M/converters удовлетворяется только через `overrides`; без него npm поставит оригинал.
- Часть upstream-тестов зависит от реального времени: на занятой машине без защиты красны то
  `Controller start` (идёт ~4,9 с из 5), то `Device OTA > throttles when response delay is configured`.
  Поэтому `build.sh` гоняет тесты с 2 воркерами, таймаутом 30 с и двумя повторами упавшего теста
  (`TEST_WORKERS` меняет число воркеров). Настоящая поломка красна все три раза.
- `upstream/` после сборки занимает ~160 МБ (node_modules); его можно удалять, `build.sh` создаст заново.
