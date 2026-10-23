"""Ручные таблицы для extract_bms.py: номера точек, особенности, русские названия.

Вынесены отдельно, чтобы скрипт-сборщик оставался коротким, а эти таблицы правились
как данные. Каждая запись несёт ссылку на источник и дословную цитату со строки:
extract_bms.py при каждом запуске сверяет, что цитата стоит ровно на этой строке
снимка main, поэтому устаревшая ссылка не пройдёт молча.
"""

INT_ROOT = "custom_components/bms_integration"
ENT_ROOT = INT_ROOT + "/core/ha_entities"

# --------------------------------------------------------------------------- #
# Ручные таблицы. Каждая запись — ссылка + дословная цитата со строки.
# --------------------------------------------------------------------------- #

# Номера точек, которые BMS Integration называет прямо. Больше их в пресетах нет:
# пресеты хранят КОДЫ, а номер интеграция берёт у облака Tuya в момент настройки
# (см. README, раздел «Откуда номера»).
KNOWN_DP_NUMBERS = [
    {
        "code": "paint_colour_data",
        "dp": 61,
        "scope": "контроллеры адресных лент (на объекте GLEDOPTO SPI); формат — "
                 "двоичный HSV-кадр в base64",
        "basis": [
            {"file": INT_ROOT + "/light.py", "line": 54, "quote": 'PAINT_COLOUR_DP = "61"'},
            {"file": INT_ROOT + "/light.py", "line": 510,
             "quote": "paint_colour_data (DP 61)"},
            {"file": "README.md", "line": 631, "quote": "`paint_colour_data` (DP 61)"},
        ],
    },
]

# Номера, которые источник называет, но которые НЕЛЬЗЯ считать свойством категории: они
# описывают конкретные изделия на объектах. Лежат отдельно от points[].dp, чтобы
# библиотека не выдала частный случай за правило. Сам тест
# tests/test_paint_colour.py проверяет и DP 5, и DP 24 как «цвет обычной лампы» —
# то есть номер у colour_data зависит от изделия.
OBSERVED_NUMBERS = [
    {
        "code": "colour_data",
        "dp": 5,
        "scope": "контроллер адресной ленты GLEDOPTO SPI на объекте: DP 5 он несёт, но "
                 "игнорирует (цвет берёт из DP 61). Формат — как у обычных RGB-ламп",
        "basis": [
            {"file": INT_ROOT + "/light.py", "line": 510, "quote": "colour_data (DP 5)"},
            {"file": "README.md", "line": 630, "quote": "(DP 5), the format of ordinary RGB bulbs"},
        ],
    },
    {
        "code": "colour_data",
        "dp": 24,
        "scope": "цветовая точка DP 24 тест считает «обычной лампой», не лентой "
                 "(в тесте код точки не назван, назван только её номер)",
        "basis": [
            {"file": "tests/test_paint_colour.py", "line": 100,
             "quote": 'make_light("24")._LocalTuyaLight__is_paint_colour()'},
        ],
    },
]

# Особенности, которые BMS Integration знает и которые не видны в таблицах пресетов.
# applies_to — только то, что называет сам источник; «?» не пишем.
QUIRKS = [
    {
        "id": "cover_position_inverted",
        "title": "Положение шторы бывает наоборот; два края калибруются отдельно",
        "text": "Есть моторы, которые считают положение в обратную сторону и не доходят "
                "до края шкалы: на объекте закрытая штора показывала 100, открытая - 7. "
                "Одной галочки «инвертировать» не хватает, нужны оба края "
                "(position_open_raw / position_closed_raw). По умолчанию в пресетах "
                "инверсия выключена.",
        "applies_to": {"platform": "cover", "categories": ["cl", "clkg", "jdcljqr"],
                       "codes": ["percent_control", "percent_state", "position"]},
        "basis": [
            {"file": INT_ROOT + "/cover.py", "line": 144,
             "quote": "на объекте закрытая штора показывала 100, открытая - 7"},
            {"file": INT_ROOT + "/cover.py", "line": 166,
             "quote": "round(100 - raw if config.get(CONF_POSITION_INVERTED) else raw)"},
            {"file": INT_ROOT + "/core/ha_entities/covers.py", "line": 23,
             "quote": "def localtuya_cover(cmd_set, position_mode=None, inverted=False, timed=25):"},
        ],
    },
    {
        "id": "garage_door_inverted",
        "title": "Ворота ckmkzq: инверсия включена в пресете, положения нет",
        "text": "Для ворот пресет ставит position_inverted=True и positioning_mode=none: "
                "состояние берётся из датчика doorcontact_state (значение true = открыто).",
        "applies_to": {"platform": "cover", "categories": ["ckmkzq"],
                       "codes": ["switch_1", "doorcontact_state"]},
        "basis": [
            {"file": INT_ROOT + "/core/ha_entities/covers.py", "line": 97,
             "quote": 'localtuya_cover("open_close_stop", "none", True)'},
            {"file": INT_ROOT + "/core/ha_entities/covers.py", "line": 98,
             "quote": 'CONF_GATE_OPEN_STATE: "true"'},
        ],
    },
    {
        "id": "gate_sensor_inverted",
        "title": "Геркон ворот бывает перевёрнут",
        "text": "Если геркон смонтирован наоборот и сообщает closed при открытых воротах, "
                "инвертируется только датчик (gate_inverted), а не значения open/closed.",
        "applies_to": {"platform": "cover", "categories": ["ckmkzq"], "codes": ["doorcontact_state"]},
        "basis": [
            {"file": "README.md", "line": 712, "quote": "**`Invert gate sensor`**"},
        ],
    },
    {
        "id": "paint_colour_dp61",
        "title": "Адресные ленты держат цвет в DP 61 paint_colour_data, а не в DP 5",
        "text": "Контроллеры адресных лент несут и colour_data (DP 5), но игнорируют его: "
                "цвет они берут только из paint_colour_data (DP 61) — двоичный HSV-кадр "
                "в base64: версия(1) режим(1: цвет) эффект(1) сегменты(1) закраска(1) "
                "оттенок 0-360 (2) насыщенность 0-1000 (2) яркость 0-1000 (2). "
                "Интеграция выбирает кодек по НОМЕРУ точки (равен 61), а не по коду. "
                "В пресетах paint_colour_data стоит первым в списке цветов, потому что "
                "побеждает первый найденный код.",
        "applies_to": {"platform": "light", "categories": ["dc", "dd", "dj"],
                       "codes": ["paint_colour_data", "colour_data"]},
        "basis": [
            {"file": INT_ROOT + "/light.py", "line": 506, "quote": "def __is_paint_colour(self) -> bool:"},
            {"file": INT_ROOT + "/light.py", "line": 515,
             "quote": "return str(self._config.get(CONF_COLOR)) == PAINT_COLOUR_DP"},
            {"file": INT_ROOT + "/light.py", "line": 522, "quote": "00        версия"},
            {"file": INT_ROOT + "/core/ha_entities/lights.py", "line": 80,
             "quote": "# paint первым: адресные ленты несут и colour_data"},
        ],
    },
    {
        "id": "colour_data_formats",
        "title": "Форматы colour_data: v1 и v2",
        "text": "colour_data v1 — hex-строка hhhh ss vv (оттенок 0-360, насыщенность и яркость "
                "0-255); colour_data_v2 — hhhh ssss vvvv (оттенок 0-360, насыщенность и яркость "
                "0-1000). Есть ещё недокументированный вариант (строка длиннее 12 символов): "
                "RGB-байты + оттенок + насыщенность + яркость.",
        "applies_to": {"platform": "light", "categories": ["dd", "dj", "dc"],
                       "codes": ["colour_data", "colour_data_v2"]},
        "basis": [
            {"file": INT_ROOT + "/light.py", "line": 555, "quote": "def __to_color_(self, hs, brightness):"},
            {"file": INT_ROOT + "/light.py", "line": 563, "quote": "def __to_color_v2(self, hs, brightness):"},
            {"file": INT_ROOT + "/light.py", "line": 485,
             "quote": "# for now we will prefer non encoded if color is none"},
        ],
    },
    {
        "id": "light_work_mode_values",
        "title": "work_mode лампы: значения colour/white/scene/music (или manual вместо colour)",
        "text": "Значения режима: white, colour, scene, music. Вариант «manual» вместо "
                "«colour» выбирается настройкой color_mode_set.",
        "applies_to": {"platform": "light", "categories": [], "codes": ["work_mode"]},
        "basis": [
            {"file": INT_ROOT + "/light.py", "line": 148, "quote": "class Mode:"},
            {"file": INT_ROOT + "/light.py", "line": 162,
             "quote": "MAP_MODE_SET = {0: Mode(), 1: Mode(color=MODE_MANUAL)}"},
        ],
    },
    {
        "id": "light_brightness_color_temp_defaults",
        "title": "Яркость лампы 0..1000 (по умолчанию нижняя граница 29), цветовая температура 2700..6500 K",
        "text": "Пресет задаёт яркость lower=29, upper=1000 и цветовую температуру "
                "2700..6500 K, температура не инвертирована. Яркость и температура — "
                "отдельные точки; в одном вызове с цветом они не должны смешивать режимы.",
        "applies_to": {"platform": "light", "categories": [], "codes": ["bright_value", "temp_value"]},
        "basis": [
            {"file": INT_ROOT + "/core/ha_entities/lights.py", "line": 24,
             "quote": "lower=29, upper=1000, min_kv=2700, max_kv=6500"},
            {"file": "README.md", "line": 654, "quote": "wrote DP 3/4 with the white mode"},
        ],
    },
    {
        "id": "climate_precision_from_cloud",
        "title": "Точность температуры: 0,1 по умолчанию, но берётся из scale самой точки",
        "text": "Пресеты климата ставят точность 0,1 (kt, qn, wk, wkf), но подменяют её "
                "значением scale из описания точки у облака Tuya (scale 0 -> точность 1, "
                "scale 1 -> 0,1). Облако в Zigbee-слое отсутствует, поэтому scale надо "
                "брать из самой модели (converters) или из измерения, а не из умолчания.",
        "applies_to": {"platform": "climate", "categories": ["kt", "qn", "wk", "wkf"],
                       "codes": ["temp_set", "temp_current"]},
        "basis": [
            {"file": INT_ROOT + "/core/ha_entities/climates.py", "line": 81,
             "quote": "CONF_PRECISION: CLOUD_VALUE("},
            {"file": INT_ROOT + "/core/ha_entities/climates.py", "line": 84,
             "quote": "CONF_TARGET_PRECISION: CLOUD_VALUE("},
            {"file": INT_ROOT + "/core/ha_entities/__init__.py", "line": 244,
             "quote": 'dp_values["scale"] = pref_type(scale(1, val_scale, float))'},
        ],
    },
    {
        "id": "climate_setpoint_zero",
        "title": "Уставка 0 — не показание, а заглушка",
        "text": "Кондиционер сообщал цель 0 при своём диапазоне 16-30. Такое значение "
                "отбрасывается, остаётся последняя разумная уставка.",
        "applies_to": {"platform": "climate", "categories": ["kt"], "codes": ["temp_set"]},
        "basis": [
            {"file": "README.md", "line": 454,
             "quote": "An air conditioner reported a target of 0 against its own range of 16-30"},
        ],
    },
    {
        "id": "alternatives_first_match",
        "title": "Список кодов в одной роли — это приоритет, берётся первый найденный у устройства",
        "text": "Когда роль сущности задана кортежем кодов, автонастройка берёт первый код "
                "из списка, который реально есть у устройства. Порядок в списке — приоритет.",
        "applies_to": {"platform": "*", "categories": [], "codes": []},
        "basis": [
            {"file": ENT_ROOT + "/__init__.py", "line": 111, "quote": "if isinstance(code, tuple):"},
            {"file": ENT_ROOT + "/__init__.py", "line": 113,
             "quote": "if any(_code in dp.lower().split() for dp in detected_dps):"},
        ],
    },
    {
        "id": "cloud_overrides_defaults",
        "title": "Диапазоны, масштаб и перечисления из пресета — запасные; настоящие даёт облако",
        "text": "Значения min/max/step/scale/enum в пресетах (CLOUD_VALUE.default_value) "
                "используются, только если облако не вернуло описание точки. У Zigbee-слоя "
                "без облака их надо получать из модели (converters) или замером.",
        "applies_to": {"platform": "*", "categories": [], "codes": []},
        "basis": [
            {"file": ENT_ROOT + "/__init__.py", "line": 161,
             "quote": "entity[k] = dp_values.get(v.value_key, v.default_value)"},
        ],
    },
    {
        "id": "scale_is_power_of_ten",
        "title": "scale облака Tuya = степень десяти: множитель 10^-scale",
        "text": "Облачное scale 1 означает множитель 0,1; scale 0 — множитель 1.",
        "applies_to": {"platform": "*", "categories": [], "codes": []},
        "basis": [
            {"file": ENT_ROOT + "/__init__.py", "line": 271, "quote": "def scale(value: int, scale: int, _type: type = int) -> float:"},
            {"file": ENT_ROOT + "/__init__.py", "line": 273, "quote": "value = _type(value) / (10**scale)"},
        ],
    },
    {
        "id": "zigbee_subdevice_address",
        "title": "Zigbee-устройство за шлюзом адресуется cid (node_id), номера точек — те же числа",
        "text": "Шлюз держит одно соединение; саб-устройство различается адресом cid. "
                "Номера точек в локальном протоколе и в облачном описании хранятся одним "
                "пространством (ключ dp сверяется с облачным dp_id напрямую).",
        "applies_to": {"platform": "*", "categories": [], "codes": []},
        "basis": [
            {"file": "CLAUDE.md", "line": 48, "quote": "is addressed by its `cid` (node_id)"},
            {"file": INT_ROOT + "/core/cloud_api.py", "line": 473, "quote": 'str(p["dp_id"]): p'},
            {"file": INT_ROOT + "/config_flow.py", "line": 1168,
             "quote": "for dp, func in cloud_dp_codes.items():"},
            {"file": INT_ROOT + "/config_flow.py", "line": 1170,
             "quote": "if dp not in dps_data or dps_data.get(dp) == -1:"},
        ],
    },
]

# Русские названия категорий — перевод английской подписи из источника (она в
# name_en). Ключ — код категории Tuya. Заполняется после просмотра списка
# (запуск с --names печатает коды и подписи).
CATEGORY_RU = {
    "bh": "Умный чайник",
    "bxx": "Сейф / запирающийся шкафчик",
    "cjkg": "Сценарный выключатель",
    "ckmkzq": "Привод гаражных ворот",
    "cl": "Шторы (привод карниза)",
    "clkg": "Выключатель для штор",
    "cn": "EasyBaby (название устройства из источника)",
    "co2bj": "Датчик CO2",
    "cobj": "Датчик угарного газа (CO)",
    "cs": "Осушитель воздуха",
    "cwwsq": "Умная кормушка для питомцев",
    "cwysj": "Поилка для питомцев",
    "cz": "Розетка",
    "dc": "Световая гирлянда",
    "dd": "Светодиодная лента",
    "dgnbj": "Многофункциональный датчик",
    "dgnzk": "Умная панель с выключателями и Zigbee-хабом (по источнику, с вопросом)",
    "dj": "Лампа / освещение",
    "dlq": "Автоматический выключатель",
    "fs": "Вентилятор",
    "fsd": "Вентилятор со светильником (потолочный)",
    "fskg": "Выключатель вентилятора",
    "fwd": "Фоновая подсветка",
    "gcj": "Газонокосилка",
    "gyd": "Светильник с датчиком движения",
    "gyms": "Без подписи в источнике",
    "hdmipmtbq": "HDMI Sync Box A1",
    "hjjcy": "Монитор качества воздуха",
    "hotelms": "Без подписи в источнике",
    "hps": "Датчик присутствия человека",
    "hxd": "Свет-будильник (Wake Up Light II)",
    "jdcljqr": "Робот для штор",
    "jqbj": "Датчик формальдегида",
    "jsq": "Увлажнитель воздуха",
    "jtmsbh": "Без подписи в источнике",
    "jtmspro": "Без подписи в источнике",
    "jwbj": "Датчик метана",
    "kfj": "Кофемашина",
    "kg": "Выключатель",
    "kj": "Очиститель воздуха",
    "kt": "Кондиционер",
    "ldcg": "Датчик освещённости",
    "mal": "Охранная панель",
    "mbd": "Неизвестная лампа",
    "mc": "Контроллер двери и окна",
    "mcs": "Датчик открытия двери/окна",
    "mk": "Контроль доступа",
    "ms": "Замок",
    "ms_category": "Без подписи в источнике",
    "msp": "Лоток для кошки",
    "mzj": "Су-вид (термоциркулятор)",
    "pc": "Силовая розетка",
    "photolock": "Без подписи в источнике",
    "pir": "Датчик движения PIR",
    "pm2.5": "Датчик PM2.5",
    "qccdz": "Зарядка электромобиля",
    "qjdcz": "Неизвестное устройство со светом (по источнику)",
    "qn": "Обогреватель",
    "qt": "Универсальные изделия, зарядка электромобиля",
    "qxj": "Метеостанция",
    "rqbj": "Датчик газа",
    "rs": "Водонагреватель",
    "sd": "Робот-пылесос",
    "sfkzq": "Водяной клапан",
    "sgbj": "Сирена",
    "sj": "Датчик протечки воды",
    "sos": "Тревожная кнопка",
    "sp": "Камера",
    "szjqr": "Fingerbot (нажиматель кнопок)",
    "tdq": "Диммер / IoT-выключатель",
    "tgkg": "Диммер-выключатель",
    "tgq": "Диммер",
    "tyndj": "Светильник на солнечной батарее",
    "videolock": "Без подписи в источнике",
    "voc": "Датчик летучих органических соединений",
    "wk": "Термостат",
    "wkcz": "Двусторонний выключатель по температуре и влажности",
    "wkf": "Термоголовка радиатора (TRV)",
    "wnykq": "ИК-пульт",
    "wsdcg": "Датчик температуры и влажности",
    "wxkg": "Беспроводной выключатель",
    "xdd": "Потолочный светильник",
    "xxj": "Диффузор",
    "ykq": "Пульт управления",
    "ylcg": "Датчик давления",
    "ywbj": "Датчик дыма",
    "ywcgq": "Ультразвуковой датчик уровня",
    "zd": "Датчик вибрации",
    "zndb": "Умный счётчик электроэнергии",
    "znsb": "Умный счётчик воды",
    "zwjcy": "Датчик почвы (монитор растений)",
}

# Какие ключи CLOUD_VALUE/плоских настроек пресета как нормализованные поля точки.
# Вне таблицы — остаются в config под своим исходным именем: ничего не теряем.
FIELD_OF_KEY = {
    "min_value": "min", "max_value": "max", "step_size": "step", "scaling": "scale",
    "min_temperature": "min", "max_temperature": "max", "temperature_step": "step",
    "precision": "precision", "target_precision": "precision",
    "min_humidity": "min", "max_humidity": "max",
    "fan_speed_min": "min", "fan_speed_max": "max",
    "brightness_lower": "min", "brightness_upper": "max",
    "unit_of_measurement": "unit",
    "select_options": "enum_map", "humidifier_available_modes": "enum_map",
    "preset_set": "enum_map",
    "fan_speed_list": "enum_list", "fan_speeds": "enum_list",
    "hvac_mode_set": "value_map", "hvac_action_set": "value_map",
    "alarm_supported_states": "value_map",
}
NUMERIC_FIELDS = {"min", "max", "step", "scale", "precision"}
# 'modes' в пылесосе — строка через запятую, в водонагревателе — словарь.
# Решаем по типу значения, см. norm_modes().


