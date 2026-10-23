# Сверка библиотеки Tuya с zigbee-herdsman-converters

> Файл создаёт `tools/crosscheck.mjs` из `tools/crosscheck_spec.json`. Руками не править: правится спека,
> файл перегенерируется (команда в конце). Каждая ссылка `файл:строка` в таблицах проверена скриптом.

**Что сверяли.** `library/categories.json` (BMS Integration, ветка main, коммит `60af1e13d5`) и
zigbee-herdsman-converters 26.115.1 (тег v26.115.1 с GitHub; `src/devices/tuya.ts`,
`src/lib/tuya.ts`, `src/lib/legacy.ts`). Взято 11 моделей TS0601 из четырёх групп (шторы, термостат,
выключатель, датчик), 76 точек. Соответствие «свойство Z2M ↔ код библиотеки» — суждение человека (поле `lib` в спеке),
всё остальное (номер, строка, конвертер, значения, масштаб) считает скрипт.

## Вывод

**1. Предположение «номера точек у Zigbee-устройств Tuya те же, что в облаке Tuya и в BMS Integration» на этих
источниках проверить нельзя.** Причина на нашей стороне, а не в converters: пресеты BMS Integration хранят только
*коды* точек, а номер интеграция узнаёт из облака в момент настройки устройства (`cloud_api.py:473`, `cloud_api.py:493`).
Прямо называет номер единственная пара — `paint_colour_data` = DP 61 (`light.py:54`), — но в converters такой точки нет
ни у одной модели (поиск по `src/devices/gledopto.ts` и всему `src` ничего не дал; GLEDOPTO GL-C-008SPI из отчётов BMS там отсутствует).
Библиотека `categories.json` номеров не содержит (поле `dp` заполнено только у этой пары), сравнивать номера не с чем.

**2. Что есть вместо проверки.** Косвенные признаки «за» (слабые):
- Справочник BMS называет три номера (`docs/СПРАВОЧНИК.md:43`: DP 1 — вкл/выкл, DP 3 — позиция шторы, DP 4 — заряд батареи, и там же
  «Нумерация своя у каждой модели»). Из 8 проверок на моделях converters совпало 5, не совпало 3
  (не совпала батарея у моделей, где она лежит на 13 и 103).
- У `TS0601_cover_12` имена свойств Z2M повторяют облачные коды `cl`: `situation_set`, `fault`, `total_time` ↔ `time_total`. Это лишь совпадение имён: что автор
  converters брал имена из облачного описания — не сказано нигде.
- В BMS Integration Zigbee-устройство за шлюзом настраивается так: облачный `dp_id` ключом сверяется с локальным номером (`config_flow.py:1168-1170`).
  Это даёт нам право считать, что для шлюзового пути «номер в облаке = номер в локальном протоколе», но не для радио Zigbee.

**3. Главный результат сверки: номер определяет модель, а не категория.** В converters одна и та же функция лежит под разными номерами,
а один номер значит разное (таблицы ниже). Поэтому библиотека категорий может дать слою Tuya *набор кодов и смысл точек*, но
номера и индексы значений придётся брать по модели (отпечаток `modelID + manufacturerName`) — из converters или из замера.
Это согласуется с оговоркой самого справочника BMS.

**4. Ещё два ограничения.**
- У части Zigbee-устройств Tuya точек данных на радио нет вообще. Лампа Moes ZB-TDA14, у которой BMS видит DP 1-5
  (`tests/test_light_ct_brightness.py:26`), в converters описана через стандартные кластеры (`tuya.modernExtend.tuyaLight`,
  `src/devices/tuya.ts:5012`, белая этикетка на `tuya.ts:4977`), без `tuyaDatapoints`. Для таких устройств библиотека точек не нужна: номера возникают
  на стороне шлюза/облака, а Z2M их не использует.
- Имена значений перечислений в Zigbee — это индексы (0, 1, 2), а имена даёт модель. Библиотека хранит имена из облака
  (`open`, `stop`, `close`), но не индексы, поэтому «значения» сверяются только по именам; разные имена не значат ошибку, различие смысла оценено вручную (колонка «Значения»).

## Итог по строкам

| Проверка | Результат |
|---|---|
| Смысл: у свойства Z2M есть пара в библиотеке | совпало: 56; нет пары: 20 |
| Номер | нечем сравнить: 68; справочник совпал: 5; справочник не совпал: 3 |
| Значения перечислений (где есть что сравнивать) | нечем сравнить: 5; тот же смысл: 4; расходится: 4; частично: 2; имена совпали: 2 |
| Масштаб / диапазон (где есть что сравнивать) | совпало: 13; не совпало: 2 |

«Нет пары» — это точки, которые модель имеет, а категория в библиотеке нет (20 из 76): батарея у штор (`cl`), состояние мотора, расписания термостата, защита от замерзания,
положение клапана, таймер диммера. Пресеты BMS Integration взяты из Wi-Fi-мира, и для Zigbee-моделей их нужно дополнять.

## Номера по всем моделям converters

В `src/devices/tuya.ts` определений с `tuyaDatapoints` (список точек: номер, имя в Z2M, конвертер): 324. Разброс номеров для одной и той же функции
(моделей / разных номеров / самые частые номера с числом моделей / доля самого частого):

| Свойство Z2M | Моделей | Разных номеров | Частые номера | Доля главного |
|---|---|---|---|---|
| battery | 84 | 18 | 4 (29), 15 (14), 6 (11), 13 (10) | 35% |
| state_l1 | 47 | 8 | 1 (35), 24 (4), 101 (2), 121 (2) | 74% |
| position | 34 | 12 | 2 (19), 3 (13), 9 (5), 8 (4) | 56% |
| temperature | 54 | 16 | 5 (15), 1 (9), 18 (5), 131 (5) | 28% |
| humidity | 34 | 12 | 2 (8), 19 (5), 101 (5), 118 (5) | 24% |
| current_heating_setpoint | 48 | 5 | 16 (20), 4 (14), 2 (9), 50 (4) | 42% |
| local_temperature | 49 | 6 | 24 (17), 5 (14), 3 (8), 16 (7) | 35% |
| child_lock | 62 | 13 | 40 (17), 101 (12), 7 (12), 39 (5) | 27% |

И наоборот — сколько разных свойств скрывается за одним номером:

| DP | Разных свойств | Чаще всего (моделей) |
|---|---|---|
| 1 | 35 | state (63), state_l1 (35), energy (34), presence (20), system_mode (18), occupancy (11) |
| 2 | 42 | state_l2 (32), preset (20), position (19), system_mode (16), current_heating_setpoint (9), produced_energy (9) |
| 3 | 34 | state_l3 (25), position (13), soil_moisture (9), running_state (9), local_temperature (8), battery_state (6) |
| 4 | 31 | battery (29), state_l4 (18), current_heating_setpoint (14), action (6), light_type (5), preset (5) |
| 5 | 25 | temperature (15), local_temperature (14), state_l5 (14), motor_direction (7), volume (4), max_brightness (3) |

Масштаб одной и той же функции тоже разный (конвертер `divideBy10` — множитель 0,1; `raw` — множитель 1):

| Свойство Z2M | Моделей | Конвертеры (моделей) |
|---|---|---|
| current_heating_setpoint | 48 | другой: 4; divideBy10: 36; raw: 8 |
| local_temperature | 49 | другой: 3; divideBy10: 44; raw: 2 |
| temperature | 54 | divideBy10: 39; raw: 6; divideBy100: 9 |
| humidity | 34 | raw: 25; divideBy10: 4; divideBy100: 5 |

Библиотека при этом даёт запасной масштаб 1 (число/датчик), 0,01 (`temp_current`/`humidity_value` у `wsdcg`) и точность 0,1 (климат) — все они «запасные», настоящий масштаб в BMS Integration приходит из облака
(`ha_entities/__init__.py:161`). У Zigbee-слоя облака нет, значит масштаб тоже должен быть в данных по модели.

## Сверка по моделям

Колонки: **Смысл** — есть ли у свойства Z2M пара в категории; **Номер** — «в библиотеке номера нет» значит, что сравнить не с чем, «справочник BMS» —
проверка по `docs/СПРАВОЧНИК.md:43`; **Значения** и **Масштаб** считаются только там, где есть что сравнивать с обеих сторон.
Ссылки вида `covers.py:39` — в `custom_components/bms_integration/core/ha_entities/` репозитория BMS Integration.

## Шторы

### TS0601_cover_12 ↔ категория `cl` (Шторы (привод карниза))

Единственная модель шторного мотора, у которой имена свойств Z2M почти дословно повторяют облачные коды Tuya (situation_set, fault, total_time). Определение: `src/devices/tuya.ts:25954`; производителей в отпечатках: 3.

| Z2M | DP | Строка / конвертер | Библиотека | Смысл | Номер | Значения | Масштаб |
|---|---|---|---|---|---|---|---|
| state | 1 | `src/devices/tuya.ts:25984`<br>`tuya.valueConverter.coverAction` | control (cover, covers.py:39) | совпало | в библиотеке номера нет | Z2M: OPEN=0, STOP=1, CLOSE=2, CONTINUE=3; в библиотеке списка значений нет | —<br><sub>Библиотека для cl хранит не индексы, а набор команд «open_close_stop» (covers.py:42); сверять имена значений не с чем.</sub> |
| position | 2 | `src/devices/tuya.ts:25985`<br>`tuya.valueConverter.coverPosition` | percent_control (cover, covers.py:39) | совпало | в библиотеке номера нет | — | —<br><sub>Задание положения (set_position_dp).</sub> |
| position | 3 | `src/devices/tuya.ts:25986`<br>`tuya.valueConverter.coverPosition` | percent_state (cover, covers.py:39) | совпало | справочник BMS «DP 3 — позиция шторы» совпал | — | —<br><sub>Текущее положение (current_position_dp).</sub> |
| motor_direction | 5 | `src/devices/tuya.ts:25987`<br>`tuya.valueConverter.tubularMotorDirection` | control_back (select/switch, selects.py:996) | совпало | в библиотеке номера нет | Z2M: normal=0, reversed=1; библиотека: control_back selects.py:996: forward/back - **тот же смысл** (индекс 0 = вперёд/normal, 1 = назад/reversed; имена разные) | —<br><sub>В converters строка 1686 прямо переводит приходящее от устройства "back" в reversed: значит устройство называет значения forward/back, как cloud-код control_back в библиотеке. Индексы совпадают по смыслу (0 = вперёд, 1 = назад); имена в Z2M другие.</sub> |
| auto_power | 6 | `src/devices/tuya.ts:25988`<br>`tuya.valueConverter.raw` | — | нет пары | в библиотеке номера нет | — | — |
| motor_state | 7 | `src/devices/tuya.ts:25989`<br>`tuya.valueConverter.motorState` | — | нет пары | в библиотеке номера нет | — | —<br><sub>В cl-пресете нет точки состояния мотора (opening/closing/stopped).</sub> |
| total_time | 10 | `src/devices/tuya.ts:25990`<br>`tuya.valueConverter.raw` | time_total (sensor, sensors.py:1468) | совпало | в библиотеке номера нет | — | —<br><sub>Имя в Z2M и код в библиотеке — одно слово наоборот.</sub> |
| situation_set | 11 | `src/devices/tuya.ts:25991`<br>`tuya.valueConverterBasic.lookup({fully_close: tuya.enum(0), fully_open: tuya.enum(1)})` | situation_set (cover, covers.py:39) | совпало | в библиотеке номера нет | Z2M: fully_close=0, fully_open=1; в библиотеке списка значений нет | — |
| fault | 12 | `src/devices/tuya.ts:25992`<br>`tuya.valueConverter.raw` | fault (binary_sensor, binary_sensors.py:43) | совпало | в библиотеке номера нет | — | — |
| favorite_position | 19 | `src/devices/tuya.ts:25993`<br>`tuya.valueConverter.raw` | — | нет пары | в библиотеке номера нет | — | — |
| battery | 103 | `src/devices/tuya.ts:25994`<br>`tuya.valueConverter.raw` | — | нет пары | справочник BMS «DP 4 — заряд батареи» не совпал (у модели DP 103) | — | —<br><sub>В пресете cl нет батареи вообще (у cl нет battery_* ни в одной платформе).</sub> |

### TS0601_cover_6 ↔ категория `cl` (Шторы (привод карниза))

Мотор с инвертированным положением (coverPositionInverted) и батареей. Определение: `src/devices/tuya.ts:9604`; производителей в отпечатках: 3.

| Z2M | DP | Строка / конвертер | Библиотека | Смысл | Номер | Значения | Масштаб |
|---|---|---|---|---|---|---|---|
| state | 1 | `src/devices/tuya.ts:9621`<br>`tuya.valueConverter.coverAction` | control (cover, covers.py:39) | совпало | в библиотеке номера нет | — | — |
| position | 2 | `src/devices/tuya.ts:9622`<br>`tuya.valueConverter.coverPositionInverted` | percent_control (cover, covers.py:39) | совпало | в библиотеке номера нет | — | —<br><sub>Конвертер coverPositionInverted (tuya.ts:1661): 100 - v. То есть у этой модели 100 = закрыто — та самая особенность, о которой знает и BMS Integration (cover.py:166).</sub> |
| position | 3 | `src/devices/tuya.ts:9623`<br>`tuya.valueConverter.coverPositionInverted` | percent_state (cover, covers.py:39) | совпало | справочник BMS «DP 3 — позиция шторы» совпал | — | — |
| opening_mode | 4 | `src/devices/tuya.ts:9624`<br>`tuya.valueConverterBasic.lookup({ tilt: tuya.enum(0), lift: tuya.enum(1), }),` | — | нет пары | в библиотеке номера нет | — | — |
| work_state | 7 | `src/devices/tuya.ts:9632`<br>`tuya.valueConverterBasic.lookup({ standby: tuya.enum(0), success: tuya.enum(1), learning: ` | — | нет пары | в библиотеке номера нет | — | — |
| battery | 13 | `src/devices/tuya.ts:9641`<br>`tuya.valueConverter.raw` | — | нет пары | справочник BMS «DP 4 — заряд батареи» не совпал (у модели DP 13) | — | — |
| motor_direction | 101 | `src/devices/tuya.ts:9642`<br>`tuya.valueConverter.motorDirectionSide` | control_back (select/switch, selects.py:996) | совпало | в библиотеке номера нет | Z2M: left=0, right=1; библиотека: control_back selects.py:996: forward/back - **расходится** (left/right — сторона мотора, а не направление вращения forward/back) | —<br><sub>Тут направление названо left/right («сторона мотора»), а не forward/back.</sub> |
| set_upper_limit | 102 | `src/devices/tuya.ts:9643`<br>`tuya.valueConverterBasic.lookup({ start: tuya.enum(1), stop: tuya.enum(0), }),` | up_confirm (switch, switches.py:888) | совпало | в библиотеке номера нет | — | —<br><sub>В библиотеке это переключатель-кнопка «Set Upper Limit» (boolean), в Z2M — enum start/stop.</sub> |
| illuminance | 104 | `src/devices/tuya.ts:9651`<br>`tuya.valueConverter.raw` | — | нет пары | в библиотеке номера нет | — | — |
| factory_reset | 107 | `src/devices/tuya.ts:9652`<br>`tuya.valueConverter.setLimit` | — | нет пары | в библиотеке номера нет | — | — |

### TS0601_cover_1 ↔ категория `cl` (Шторы (привод карниза))

Самая массовая модель (72 производителя в отпечатках); у неё нет tuyaDatapoints, номера зашиты в legacy-конвертерах. Определение: `src/devices/tuya.ts:9493`; производителей в отпечатках: 72.

| Z2M | DP | Строка / конвертер | Библиотека | Смысл | Номер | Значения | Масштаб |
|---|---|---|---|---|---|---|---|
| state | 1 | `src/lib/legacy.ts:592`<br>`legacy.dataPoints.state` | control (cover, covers.py:39) | совпало | в библиотеке номера нет | Z2M: open=0, stop=1, close=2; в библиотеке списка значений нет | —<br><sub>Значения по умолчанию (legacy.ts:112). Для _TZE200_rddyvrci, _TZE200_wmcdj3aq, _TZE200_cowvfni3, _TYST11_cowvfni3 индексы другие (legacy.ts:93-105): у одного и того же «open/stop/close» разные числа. При чтении состояния DP 1 игнорируется (legacy.ts:3579).</sub> |
| position | 2 | `src/lib/legacy.ts:594`<br>`legacy.dataPoints.coverPosition` | percent_control (cover, covers.py:39) | совпало | в библиотеке номера нет | — | — |
| position | 3 | `src/lib/legacy.ts:598`<br>`legacy.dataPoints.coverArrived` | percent_state (cover, covers.py:39) | совпало | справочник BMS «DP 3 — позиция шторы» совпал | — | — |
| motor_direction | 5 | `src/lib/legacy.ts:603`<br>`legacy.dataPoints.motorDirection / config` | control_back (select/switch, selects.py:996) | совпало | в библиотеке номера нет | — | — |
| (coverChange) | 7 | `src/lib/legacy.ts:606`<br>`legacy.dataPoints.coverChange` | — | нет пары | в библиотеке номера нет | — | —<br><sub>Игнорируется как ненадёжная (legacy.ts:3581).</sub> |
| motor_speed | 105 | `src/lib/legacy.ts:617`<br>`legacy.dataPoints.coverSpeed` | — | нет пары | в библиотеке номера нет | — | — |
| (список инверсии положения) | 2 | `src/lib/legacy.ts:537`<br>`legacy.coverPositionInvert: 7 производителей (legacy.ts:541-549)` | — | нет пары | в библиотеке номера нет | — | —<br><sub>ОСОБЕННОСТЬ совпала: и у converters, и у BMS Integration положение шторы бывает наоборот (0 = открыто, 100 = закрыто). В converters это список из 7 производителей (legacy.ts:541-549), в BMS Integration — настройка position_inverted и калибровка краёв (cover.py:140-179). Библиотечные пресеты cl инверсию не задают (covers.py:23).</sub> |

## Термостат

### TS0601_thermostat_3 ↔ категория `wk` (Термостат)

Настенный термостат, 20 производителей. Определение: `src/devices/tuya.ts:11128`; производителей в отпечатках: 20.

| Z2M | DP | Строка / конвертер | Библиотека | Смысл | Номер | Значения | Масштаб |
|---|---|---|---|---|---|---|---|
| system_mode | 2 | `src/devices/tuya.ts:11183`<br>`tuya.valueConverterBasic.lookup({ auto: tuya.enum(0), heat: tuya.enum(1), off: tuya.enum(2` | systemmode (climate, climates.py:214)<br>switch (climate, climates.py:214)<br>mode (climate, climates.py:214) | совпало | в библиотеке номера нет | Z2M: auto=0, heat=1, off=2; библиотека: systemmode climates.py:214: true/false - **расходится** (библиотека по умолчанию ждёт логический вкл/выкл (HEAT=true, OFF=false), у модели три значения auto/heat/off) | — |
| running_state | 3 | `src/devices/tuya.ts:11192`<br>`tuya.valueConverterBasic.lookup({ heat: tuya.enum(0), idle: tuya.enum(1), }),` | work_state (climate, climates.py:214)<br>work_mode (climate, climates.py:214)<br>work_status (climate, climates.py:214) | совпало | в библиотеке номера нет | Z2M: heat=0, idle=1; библиотека: work_state climates.py:214: true/false - **расходится** (библиотека по умолчанию ждёт true/false, у модели enum heat/idle) | — |
| current_heating_setpoint | 4 | `src/devices/tuya.ts:11200`<br>`tuya.valueConverter.divideBy10` | temp_set (climate, climates.py:214) | совпало | в библиотеке номера нет | — | множитель Z2M 0.1; temp_set.precision = 0.1 (climates.py:214) - совпало |
| local_temperature | 5 | `src/devices/tuya.ts:11201`<br>`tuya.valueConverter.divideBy10` | temp_current (climate/sensor, climates.py:214) | совпало | в библиотеке номера нет | — | множитель Z2M 0.1; temp_current.precision = 0.1 (climates.py:214) - совпало |
| child_lock | 7 | `src/devices/tuya.ts:11202`<br>`tuya.valueConverter.lockUnlock` | child_lock (switch, switches.py:1005) | совпало | в библиотеке номера нет | — | — |
| schedule_monday | 28 | `src/devices/tuya.ts:11203`<br>`tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(1, 6)` | — | нет пары | в библиотеке номера нет | — | —<br><sub>Расписание на неделю: DP 28-34.</sub> |
| frost_protection | 36 | `src/devices/tuya.ts:11211`<br>`tuya.valueConverter.onOff` | — | нет пары | в библиотеке номера нет | — | — |
| scale_protection | 39 | `src/devices/tuya.ts:11212`<br>`tuya.valueConverter.onOff` | — | нет пары | в библиотеке номера нет | — | — |
| local_temperature_calibration | 47 | `src/devices/tuya.ts:11213`<br>`tuya.valueConverter.raw` | tempcomp (number, numbers.py:719) | совпало | в библиотеке номера нет | — | множитель Z2M 1; tempcomp.scale = 1 (numbers.py:719) - совпало<br><sub>tempcomp в библиотеке — число «Calibration offset» -9..9.</sub> |
| pi_heating_demand | 101 | `src/devices/tuya.ts:11214`<br>`tuya.valueConverter.raw` | — | нет пары | в библиотеке номера нет | — | — |

### TS0601_thermostat_1 ↔ категория `wkf` (Термоголовка радиатора (TRV))

Термоголовка радиатора (TRV) с батареей. Определение: `src/devices/tuya.ts:11558`; производителей в отпечатках: 4.

| Z2M | DP | Строка / конвертер | Библиотека | Смысл | Номер | Значения | Масштаб |
|---|---|---|---|---|---|---|---|
| system_mode | 1 | `src/devices/tuya.ts:11621`<br>`tuya.valueConverter.thermostatSystemModeAndPreset("system_mode")` | systemmode (climate, climates.py:242)<br>mode (climate, climates.py:242) | совпало | в библиотеке номера нет | — | —<br><sub>Режим и предустановка в одной точке (thermostatSystemModeAndPreset, tuya.ts:2518): индексы 0 auto, 1 manual, 2 off, 3 on. В библиотеке wkf режимы heat=manual, auto=auto (climates.py:255) — совпадает только частично: нет off/on.</sub> |
| current_heating_setpoint | 2 | `src/devices/tuya.ts:11623`<br>`tuya.valueConverter.divideBy10` | temp_set (climate, climates.py:242) | совпало | в библиотеке номера нет | — | множитель Z2M 0.1; temp_set.precision = 0.1 (climates.py:242) - совпало |
| local_temperature | 3 | `src/devices/tuya.ts:11624`<br>`tuya.valueConverter.divideBy10` | temp_current (climate, climates.py:242) | совпало | в библиотеке номера нет | — | множитель Z2M 0.1; temp_current.precision = 0.1 (climates.py:242) - совпало |
| running_state | 6 | `src/devices/tuya.ts:11627`<br>`tuya.valueConverterBasic.lookup({heat: 1, idle: 0})` | work_state (climate, climates.py:242)<br>work_mode (climate, climates.py:242)<br>work_status (climate, climates.py:242) | совпало | в библиотеке номера нет | Z2M: heat=1, idle=0; библиотека: work_state climates.py:242: opened/closed - **тот же смысл** (heat/idle = открыт/закрыт клапан; имена разные) | — |
| window | 7 | `src/devices/tuya.ts:11628`<br>`tuya.valueConverterBasic.lookup({OPEN: 1, CLOSE: 0})` | window_state (binary_sensor, binary_sensors.py:415) | совпало | в библиотеке номера нет | Z2M: OPEN=1, CLOSE=0; библиотека: window_state binary_sensors.py:415: opened - **тот же смысл** (OPEN/CLOSE и opened — одно и то же состояние окна) | — |
| window_detection | 8 | `src/devices/tuya.ts:11629`<br>`tuya.valueConverter.onOff` | — | нет пары | в библиотеке номера нет | — | — |
| child_lock | 12 | `src/devices/tuya.ts:11630`<br>`tuya.valueConverter.lockUnlock` | child_lock (switch, switches.py:1005) | совпало | в библиотеке номера нет | — | — |
| battery | 13 | `src/devices/tuya.ts:11631`<br>`tuya.valueConverter.raw` | battery (sensor, sensors.py:91)<br>battery_percentage (sensor, sensors.py:60) | совпало | справочник BMS «DP 4 — заряд батареи» не совпал (у модели DP 13) | — | множитель Z2M 1; battery.scale = 1 (sensors.py:91); battery_percentage.scale = 1 (sensors.py:60) - совпало |
| min_temperature | 15 | `src/devices/tuya.ts:11633`<br>`tuya.valueConverter.divideBy10` | — | нет пары | в библиотеке номера нет | — | —<br><sub>Границы уставки в библиотеке берутся из самой точки temp_set (min/max из облака).</sub> |
| position | 102 | `src/devices/tuya.ts:11643`<br>`tuya.valueConverter.divideBy10` | — | нет пары | в библиотеке номера нет | — | —<br><sub>Открытие клапана.</sub> |

## Выключатель

### TS0601_switch_4_gang_1 ↔ категория `kg` (Выключатель)

Четырёхклавишный выключатель, 13 производителей. Определение: `src/devices/tuya.ts:6809`; производителей в отпечатках: 13.

| Z2M | DP | Строка / конвертер | Библиотека | Смысл | Номер | Значения | Масштаб |
|---|---|---|---|---|---|---|---|
| state_l1 | 1 | `src/devices/tuya.ts:6833`<br>`tuya.valueConverter.onOff` | switch_1 (switch, switches.py:180) | совпало | справочник BMS «DP 1 — включено/выключено» совпал | — | — |
| state_l2 | 2 | `src/devices/tuya.ts:6834`<br>`tuya.valueConverter.onOff` | switch_2 (switch, switches.py:184) | совпало | в библиотеке номера нет | — | — |
| state_l3 | 3 | `src/devices/tuya.ts:6835`<br>`tuya.valueConverter.onOff` | switch_3 (switch, switches.py:188) | совпало | в библиотеке номера нет | — | — |
| state_l4 | 4 | `src/devices/tuya.ts:6836`<br>`tuya.valueConverter.onOff` | switch_4 (switch, switches.py:192) | совпало | в библиотеке номера нет | — | — |

### TS0601_switch_6_gang ↔ категория `kg` (Выключатель)

Шестиклавишный выключатель с режимом питания и индикатором. Определение: `src/devices/tuya.ts:6887`; производителей в отпечатках: 14.

| Z2M | DP | Строка / конвертер | Библиотека | Смысл | Номер | Значения | Масштаб |
|---|---|---|---|---|---|---|---|
| state_l5 | 5 | `src/devices/tuya.ts:6917`<br>`tuya.valueConverter.onOff` | switch_5 (switch, switches.py:196) | совпало | в библиотеке номера нет | — | — |
| state_l6 | 6 | `src/devices/tuya.ts:6918`<br>`tuya.valueConverter.onOff` | switch_6 (switch, switches.py:200) | совпало | в библиотеке номера нет | — | — |
| power_on_behavior | 14 | `src/devices/tuya.ts:6919`<br>`tuya.valueConverterBasic.lookup({ off: tuya.enum(0), on: tuya.enum(1), memory: tuya.enum(2` | relay_status (select, selects.py:212) | совпало | в библиотеке номера нет | Z2M: off=0, on=1, memory=2; библиотека: relay_status selects.py:212: power_on/power_off/last; relay_status selects.py:222: on/off/memory; relay_status selects.py:232: 0/1/2 - **частично** (вариант библиотеки с именами on/off/memory совпал, но вариант с индексами 0=ON, 1=OFF (selects.py:232) противоречит модели (0=off, 1=on)) | — |
| indicator_mode | 15 | `src/devices/tuya.ts:6928`<br>`tuya.valueConverterBasic.lookup({ none: tuya.enum(0), relay: tuya.enum(1), pos: tuya.enum(` | light_mode (select, selects.py:415) | совпало | в библиотеке номера нет | Z2M: none=0, relay=1, pos=2; библиотека: light_mode selects.py:415: relay/pos/none - **имена совпали** | — |

### TS0601_dimmer_1_gang_1 ↔ категория `tgkg` (Диммер-выключатель)

Одноканальный диммер, 29 производителей. Определение: `src/devices/tuya.ts:5978`; производителей в отпечатках: 29.

| Z2M | DP | Строка / конвертер | Библиотека | Смысл | Номер | Значения | Масштаб |
|---|---|---|---|---|---|---|---|
| state | 1 | `src/devices/tuya.ts:6026`<br>`tuya.valueConverter.onOff, {skip: tuya.skip.stateOnAndBrightnessPresent}` | switch_led_1 (light, lights.py:277) | совпало | в библиотеке номера нет | — | — |
| brightness | 2 | `src/devices/tuya.ts:6027`<br>`tuya.valueConverter.scale0_254to0_1000` | bright_value_1 (light, lights.py:277) | совпало | в библиотеке номера нет | — | диапазон Z2M 1000; bright_value_1.max = 1000 (lights.py:277) - совпало<br><sub>scale0_254to0_1000 (tuya.ts:1574): точка 0..1000, Z2M показывает 0..254. Верхняя граница 1000 в библиотеке (lights.py:24) совпадает.</sub> |
| min_brightness | 3 | `src/devices/tuya.ts:6028`<br>`tuya.valueConverter.scale0_254to0_1000` | brightness_min_1 (light/number, lights.py:277) | совпало | в библиотеке номера нет | — | — |
| light_type | 4 | `src/devices/tuya.ts:6029`<br>`tuya.valueConverter.lightType` | led_type_1 (select, selects.py:765) | совпало | в библиотеке номера нет | Z2M: led=0, incandescent=1, halogen=2; библиотека: led_type_1 selects.py:765: led/incandescent/halogen - **имена совпали** | — |
| max_brightness | 5 | `src/devices/tuya.ts:6030`<br>`tuya.valueConverter.scale0_254to0_1000` | brightness_max_1 (light/number, lights.py:277) | совпало | в библиотеке номера нет | — | — |
| countdown | 6 | `src/devices/tuya.ts:6031`<br>`tuya.valueConverter.countdown` | — | нет пары | в библиотеке номера нет | — | —<br><sub>Таймер: в tgkg его нет (есть в kg как countdown_1).</sub> |
| power_on_behavior | 14 | `src/devices/tuya.ts:6032`<br>`tuya.valueConverter.powerOnBehavior` | relay_status (select, selects.py:738) | совпало | в библиотеке номера нет | Z2M: off=0, on=1, previous=2; библиотека: relay_status selects.py:738: on/off/memory; relay_status selects.py:748: 0/1/2 - **частично** (имена memory/previous разные; вариант с индексами 0=ON, 1=OFF (selects.py:748) противоречит модели (0=off, 1=on)) | — |
| backlight_mode | 21 | `src/devices/tuya.ts:6033`<br>`tuya.valueConverter.backlightModeOffNormalInverted` | light_mode (select, selects.py:757) | совпало | в библиотеке номера нет | Z2M: off=0, normal=1, inverted=2; библиотека: light_mode selects.py:757: relay/pos/none - **расходится** (у Z2M off/normal/inverted, у библиотеки relay/pos/none — разные наборы режимов подсветки) | — |

## Датчик

### TS0601_temperature_humidity_sensor_3 ↔ категория `wsdcg` (Датчик температуры и влажности)

Датчик температуры и влажности с батареей. Определение: `src/devices/tuya.ts:4050`; производителей в отпечатках: 3.

| Z2M | DP | Строка / конвертер | Библиотека | Смысл | Номер | Значения | Масштаб |
|---|---|---|---|---|---|---|---|
| temperature | 1 | `src/devices/tuya.ts:4057`<br>`tuya.valueConverter.divideBy10` | va_temperature (sensor, sensors.py:1203)<br>temp_current (sensor, sensors.py:1210) | совпало | в библиотеке номера нет | — | множитель Z2M 0.1; va_temperature.scale = 1 (sensors.py:1203); temp_current.scale = 0.01 (sensors.py:1210) - не совпало<br><sub>У температуры в библиотеке два кода с разными запасными масштабами: va_temperature 1, temp_current 0.01 (sensors.py:1203, 1210).</sub> |
| humidity | 2 | `src/devices/tuya.ts:4058`<br>`tuya.valueConverter.raw` | va_humidity (sensor, sensors.py:1217)<br>humidity_value (sensor, sensors.py:1217) | совпало | в библиотеке номера нет | — | множитель Z2M 1; va_humidity.scale = 0.01 (sensors.py:1217); humidity_value.scale = 0.01 (sensors.py:1217) - не совпало |
| battery | 4 | `src/devices/tuya.ts:4059`<br>`tuya.valueConverter.raw` | battery_percentage (sensor, sensors.py:60) | совпало | справочник BMS «DP 4 — заряд батареи» совпал | — | множитель Z2M 1; battery_percentage.scale = 1 (sensors.py:60) - совпало |
| temperature_unit | 9 | `src/devices/tuya.ts:4060`<br>`tuya.valueConverter.temperatureUnitEnum` | c_f (select, selects.py:1228)<br>temp_unit_convert (select, selects.py:1228) | совпало | в библиотеке номера нет | Z2M: celsius=0, fahrenheit=1; библиотека: c_f selects.py:1228: c/f - **тот же смысл** (celsius/fahrenheit и c/f; индексы 0/1 в библиотеке не заданы) | — |
| temperature_sensitivity | 19 | `src/devices/tuya.ts:4061`<br>`tuya.valueConverter.raw` | temp_sensitivity (number, numbers.py:775) | совпало | в библиотеке номера нет | — | множитель Z2M 1; temp_sensitivity.scale = 1 (numbers.py:775) - совпало |

### TS0601_smoke_4 ↔ категория `ywbj` (Датчик дыма)

Датчик дыма с батареей, 5 производителей. Определение: `src/devices/tuya.ts:12688`; производителей в отпечатках: 5.

| Z2M | DP | Строка / конвертер | Библиотека | Смысл | Номер | Значения | Масштаб |
|---|---|---|---|---|---|---|---|
| smoke | 1 | `src/devices/tuya.ts:12695`<br>`tuya.valueConverter.trueFalse0` | smoke_sensor_status (binary_sensor, binary_sensors.py:436)<br>smoke_sensor_state (binary_sensor, binary_sensors.py:441) | совпало | в библиотеке номера нет | — | — |
| battery_state | 14 | `src/devices/tuya.ts:12696`<br>`tuya.valueConverter.batteryState` | battery_state (sensor, sensors.py:68) | совпало | в библиотеке номера нет | Z2M: low=0, medium=1, high=2; в библиотеке списка значений нет | — |
| battery | 15 | `src/devices/tuya.ts:12697`<br>`tuya.valueConverter.raw` | battery_percentage (sensor, sensors.py:60) | совпало | в библиотеке номера нет | — | множитель Z2M 1; battery_percentage.scale = 1 (sensors.py:60) - совпало |

### TS0601_soil ↔ категория `zwjcy` (Датчик почвы (монитор растений))

Датчик почвы, 9 производителей. Определение: `src/devices/tuya.ts:5489`; производителей в отпечатках: 9.

| Z2M | DP | Строка / конвертер | Библиотека | Смысл | Номер | Значения | Масштаб |
|---|---|---|---|---|---|---|---|
| soil_moisture | 3 | `src/devices/tuya.ts:5496`<br>`tuya.valueConverter.raw` | humidity (sensor, sensors.py:1773) | совпало | в библиотеке номера нет | — | множитель Z2M 1; humidity.scale = 1 (sensors.py:1773) - совпало |
| temperature | 5 | `src/devices/tuya.ts:5497`<br>`tuya.valueConverter.raw` | temp_current (sensor, sensors.py:1766) | совпало | в библиотеке номера нет | — | множитель Z2M 1; temp_current.scale = 1 (sensors.py:1766) - совпало<br><sub>У этой модели температура raw (масштаб 1), у модели _sensor_3 — divideBy10: масштаб зависит от модели, а не от категории.</sub> |
| battery_state | 14 | `src/devices/tuya.ts:5499`<br>`tuya.valueConverter.batteryState` | battery_state (sensor, sensors.py:68) | совпало | в библиотеке номера нет | Z2M: low=0, medium=1, high=2; в библиотеке списка значений нет | — |
| battery | 15 | `src/devices/tuya.ts:5500`<br>`tuya.valueConverter.raw` | battery_percentage (sensor, sensors.py:60) | совпало | в библиотеке номера нет | — | множитель Z2M 1; battery_percentage.scale = 1 (sensors.py:60) - совпало |

## Самые важные расхождения

1. **Одна функция — разные номера.** Батарея: самый частый номер 4, но есть 13 (`TS0601_cover_6`, `TS0601_thermostat_1`), 15 (датчики дыма и почвы), 103 (`TS0601_cover_12`), 21 (legacy-таблица `legacy.ts:609`).
   Номер 3 у шторы — положение, у термостата `TS0601_thermostat_1` — температура, у почвенного датчика — влажность почвы. Библиотеке категорий нельзя приписывать номера.
2. **Индексы значений у одной и той же команды.** Шторы: по умолчанию `open=0, stop=1, close=2` (`legacy.ts:112`), но для четырёх производителей другие (`legacy.ts:93-105`),
   а у `TS0601_cover_12` в `coverAction` ещё и `CONTINUE=3` (`tuya.ts:1671`). В библиотеке для `cl` хранится набор команд «open_close_stop», а не индексы.
3. **Положение штор бывает наоборот — совпало.** И у converters (`legacy.ts:541-549`, `coverPositionInverted` на `tuya.ts:1661`), и у BMS Integration (`cover.py:140-179`). Пресеты `cl` инверсию не задают (`covers.py:23`), это настройка.
4. **Режимы климата.** Пресет `wk` по умолчанию ждёт логические значения (`HEAT=true, OFF=false`, `climates.py:227`), а модель `TS0601_thermostat_3` отдаёт enum `auto/heat/off`, и режим работы `heat/idle`.
   Для TRV (`wkf`) режимы `manual/auto` (`climates.py:255`) закрывают только часть значений `thermostatSystemModeAndPreset` (`tuya.ts:2518`).
5. **Масштаб температуры.** Запасные масштабы библиотеки (1 и 0,01) не равны множителю 0,1 у `TS0601_temperature_humidity_sensor_3`; у почвенного датчика температура `raw`. Точность климата 0,1 совпала с `divideBy10`, а у моделей с `raw` была бы 1; BMS Integration решает это подменой точности значением `scale` из облака (`climates.py:81-86`), у Zigbee-слоя облака нет, значит масштаб берётся из модели.
6. **Нет пары в библиотеке:** батарея у штор `cl`; `motor_state`, `auto_power`, `favorite_position`; расписания, защита от замерзания, положение клапана, таймер диммера.
7. **Совпало по смыслу и по набору имён:** тип лампы диммера (`led/incandescent/halogen`), режим индикатора выключателя (`relay/pos/none`), каналы выключателя (`state_lN` ↔ `switch_N`), блокировка от детей, время работы шторы (`time_total`), неисправность (`fault`), уставка и текущая температура термостата (множитель 0,1).

## Категория Zigbee-устройства без облака (открытый вопрос)

**Связаны ли восемь знаков `_TZE200_xxxxxxxx` с `product_id` Tuya — в доступных источниках доказательства нет.** Что именно искали и что нашли:

*BMS Integration (ветка main).*
- Слов `product_id`, `manufacturerName`, `modelId`, `_TZE`, `_TZ3`, `_TYZB`, `_TYST` в репозитории нет ни разу (`grep` по `custom_components`, `tests`, `docs`, `tools`, `README.md`, `CLAUDE.md`; каталоги `upstream-*` не входят в main — они в `.gitignore:8`).
- Облачная запись устройства сохраняется целиком (`cloud_api.py:342`), но читаются из неё только `category` (`config_flow.py:97,683,1013`), `product_name` (`config_flow.py:310,358,508`), `node_id`, `local_key`, `name` (`config_flow.py:978-986`). `product_id` не читается нигде.
- `product_key`, который BMS кладёт в настройки (`config_flow.py:512,986`, `__init__.py:272`), — это `productKey` из UDP-вещания шлюза/Wi-Fi-устройства, а не 8 знаков Zigbee; в фикстурах он пустой или `sim` (`tests/js/render_screens.js:74`, `tools/tuya_device_sim.py:158`).
- Категория BMS берётся только из облака (`config_flow.py:683`); без облака интеграция её не знает.

*zigbee-herdsman-converters 26.115.1.*
- Упоминаний product id нет (поиск `product_id|productId|product id|pid` по `src` находит только PID-регуляторы термостатов и `productCode` Plugwise). В `tuya.ts:23286` «PID» — режим клапана.
- **Косвенные признаки, что восемь знаков — идентификатор изделия:**
  - Из 1405 различных восьмизнаковых хвостов в отпечатках у 182 один и тот же хвост встречается под несколькими префиксами (`_TZE200_`, `_TZE204_`, `_TZE284_`, `_TZ3000_`), например `vuwtqx0t`: _TZE284_, _TZE200_ (определение `TS0601_water_valve`);
    у 26 из них — даже в разных определениях: например `hewlydpz` — _TZE204_, _TZE200_ в определениях TS0601_4gang_7ytnacie, TS0601_switch_4_gang_2.
  - У старого семейства `_TYST11_` модель, которую устройство сообщает само, равна хвосту без первой буквы плюс нулевой байт: 5 из 6 отпечатков с `\u0000` подчиняются этому правилу (`tuya.ts:6487`, `9490`, `9491`, `11491`, `11523`; исключение — `tuya.ts:16439`). Там же, рядом, тот же хвост стоит под `_TZE200_` (`tuya.ts:6487`, `11491`, `11523`).
  - Но ни одна строка не говорит, что этот хвост равен облачному `product_id`.

**Что нужно, чтобы решить вопрос:** два-три живых устройства, у которых одновременно известны (а) `manufacturerName` в Z2M и (б) `product_id` в облаке Tuya (BMS уже ходит в облако за списком устройств, `cloud_api.py:342`, так что поле приходит в ответе; его надо только прочитать и сравнить). Это задача для стенда («замерщик»).
**Практический вывод:** пока соответствие не доказано, категория по `_TZE200_…` не определяется. Рабочие пути: (1) таблица «модель Z2M → категория», собираемая один раз через облако на объекте при установке; (2) выбор категории человеком в дополнении; (3) вывод категории из набора пришедших точек и их сверки со списками `tuyaDatapoints` в converters (определений: 324) — это хуже, но не требует облака.

## Что не проверено

- Номера точек ни разу не сопоставлены с **облаком Tuya**: в BMS Integration нет облачных дампов реальных Zigbee-устройств (в `tests/` и `tools/` DP-карты придуманы симулятором `tools/tuya_device_sim.py`; на них не опираемся).
- Проверены 11 моделей из 324; выбор — по числу производителей и по четырём группам, не случайная выборка.
- Соответствие «свойство Z2M ↔ код библиотеки» сделано человеком; ошибка в нём даёт ложное «совпало».
- Ничего не проверено на железе.

## Как перегенерировать

```
node tools/scan_converters.mjs .work/converters-src/zigbee-herdsman-converters-26.115.1 > .work/scan.json
node tools/crosscheck.mjs --src .work/converters-src/zigbee-herdsman-converters-26.115.1 --scan .work/scan.json --bms .work/bms-main --out library/crosscheck.md
```
