"""Запись categories.json: формат файла и раздел conventions.

Отдельно от extract_bms.py, чтобы сборка (что класть в файл) и вид файла (как он
записан) менялись независимо.
"""

import json
from collections import OrderedDict

# --------------------------------------------------------------------------- #
# Запись JSON: верх с отступами, точки и сущности — по строке на запись
# --------------------------------------------------------------------------- #

LINE_LISTS = {"points", "entities", "declared", "source_notes"}


def dumps(obj, ind=0, key=None):
    """json.dumps с отступами, но points/entities по одной записи в строку.

    Один файл на полторы тысячи записей: построчный вывод даёт читаемый diff
    при перегенерации (изменилась запись — изменилась строка).
    """
    pad = " " * ind
    j = lambda x: json.dumps(x, ensure_ascii=False)  # noqa: E731
    if isinstance(obj, dict):
        if not obj:
            return "{}"
        body = ",\n".join(f"{pad} {j(k)}: {dumps(v, ind + 1, k)}" for k, v in obj.items())
        return "{\n" + body + "\n" + pad + "}"
    if isinstance(obj, list):
        if not obj:
            return "[]"
        if key in LINE_LISTS:
            return "[\n" + ",\n".join(f"{pad} {j(x)}" for x in obj) + "\n" + pad + "]"
        if all(not isinstance(x, (dict, list)) for x in obj):
            return j(obj)
        return "[\n" + ",\n".join(f"{pad} {dumps(x, ind + 1)}" for x in obj) + "\n" + pad + "]"
    return j(obj)


CONVENTIONS = OrderedDict([
    ("point.dp", "номер точки; null — источник его не называет (пресеты хранят коды, не номера)"),
    ("point.dp_type", "тип точки Tuya; null — источник его не называет"),
    ("use", "одно использование точки в сущности HA; точка может иметь несколько"),
    ("use.platform", "тип сущности HA: alarm_control_panel, binary_sensor, button, climate, cover, "
                     "fan, humidifier, light, lock, number, remote, select, sensor, siren, switch, "
                     "vacuum, water_heater"),
    ("use.role", "роль точки в сущности; id — главная точка сущности, прочие названы как в пресете"),
    ("use.alternatives", "если есть: коды, из которых автонастройка берёт ПЕРВЫЙ найденный у "
                         "устройства; priority — место этого кода в списке"),
    ("use.min/max/step/scale/precision/enum_map/enum_list/value_map",
     "значения пресета по умолчанию. from_cloud перечисляет, какие из них интеграция заменяет "
     "описанием точки из облака Tuya (ключ облака — значение); cloud_scaled — поля, которые "
     "облачное значение дополнительно делит на 10^scale"),
    ("use.scale", "множитель к сырому значению (облачное scale 1 = множитель 0.1)"),
    ("use.enum_map", "{значение точки: подпись}; enum_list — просто список значений"),
    ("use.value_map", "{состояние HA: значение точки у устройства}"),
    ("use.config", "прочие настройки сущности под исходными именами пресета"),
    ("use.match_contains_any", "пресет применяется, только если в строке точки "
                               "«<номер> ( code: … , value: … )» есть одна из этих подстрок"),
    ("ha:...", "константа Home Assistant, оставленная по имени как в источнике"),
    ("source, category_source", "файл:строка в репозитории BMS Integration: где создана сущность / "
                                "где объявлена категория в файле платформы"),
    ("codes", "коды сопоставляются без учёта регистра (ha_entities/__init__.py:119-133)"),
])


