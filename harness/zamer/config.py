"""Конфиг стенда: пары устройств и адреса MQTT / Home Assistant."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

CONFIRM_MODES = ("dp_event", "push_event")

# Самое раннее «подтверждение» из кэша хаба на стороне Tuya: интеграция ждёт
# ответа шлюза 5 с (pytuya/__init__.py:134 TIMEOUT_REPLY), затем через 6 с
# (coordinator.py:110 STATUS_VERIFY_DELAY) опрашивает хаб, а тот отвечает
# кэшем, где уже лежит наша же запись. Ожидание подтверждения обязано
# кончиться раньше, иначе ответ кэша засчитается устройству.
MAX_COMMAND_TIMEOUT_S = 10.0

# Сколько секунд после таймаута команды (и после возврата из «недоступно»)
# подтверждения стороны Tuya считаем подозрительными (SUSPECT, не в счёт).
# Таймаут шлюза 5 с + сверка через 6 с + до 5 с на ответ = ответ кэша хаба
# приходит через 11-16 с после команды; наш таймаут 8 с, окно 12 с после него
# закрывает всё до +20 с. Обнулить можно, только когда на железе проверено,
# что событие подтверждения не приходит из опроса кэша (см. README).
DEFAULT_SUSPECT_WINDOW_S = 12.0

# Как командовать исполнительным устройством каждого вида.
# Индекс 0 - «вкл / открыть», 1 - «выкл / закрыть».
# Значения для штор (cover) взяты из типовых определений и НЕ проверены на
# железе - их можно переопределить у пары в конфиге.
KINDS: dict[str, dict[str, Any]] = {
    "switch": {
        "ours_key": "state",
        "ours_values": ["ON", "OFF"],
        "tuya_values": [True, False],
        "ha_services": ["turn_on", "turn_off"],
        "ha_states": ["on", "off"],
    },
    "cover": {
        "ours_key": "state",
        "ours_values": ["OPEN", "CLOSE"],
        "tuya_values": ["open", "close"],
        "ha_services": ["open_cover", "close_cover"],
        # Шторы в HA проходят через opening/closing - откат по показу не ловим.
        "ha_states": [None, None],
    },
}


class ConfigError(ValueError):
    pass


@dataclass
class Pair:
    """Пара одинаковых устройств: одно на хабе Tuya, второе у нас в Z2M."""

    name: str
    type: str                      # actuator | sensor
    tuya_entity: str               # entity_id в HA (хаб Tuya через BMS Integration)
    ours: str                      # friendly_name в Z2M
    kind: str = "switch"
    report_interval_s: float | None = None
    far: bool = False              # дальнее, за повторителем (сценарий 3)
    tuya_device_id: str | None = None
    tuya_dp: str | None = None
    ours_endpoint: int | None = None
    ours_report_cluster: str | None = None
    ours_report_field: str | None = None
    ours_report_dp: int | None = None
    ours_report_values: list | None = None
    ours_key: str = "state"
    ours_values: list = field(default_factory=list)
    tuya_values: list = field(default_factory=list)
    ha_services: list = field(default_factory=list)
    ha_states: list = field(default_factory=list)

    @staticmethod
    def index(on: bool) -> int:
        return 0 if on else 1


@dataclass
class MqttCfg:
    host: str
    port: int = 1883
    username: str | None = None
    password: str | None = None
    base_topic: str = "zigbee2mqtt"


@dataclass
class HaCfg:
    url: str
    token: str
    confirm: str = "dp_event"
    suspect_window_s: float = DEFAULT_SUSPECT_WINDOW_S


@dataclass
class Config:
    mqtt: MqttCfg
    ha: HaCfg
    pairs: list[Pair]
    db_path: Path
    command_interval_s: float = 10.0
    command_timeout_s: float = 8.0

    def pair(self, name: str) -> Pair:
        for p in self.pairs:
            if p.name == name:
                return p
        raise KeyError(name)

    @property
    def actuators(self) -> list[Pair]:
        return [p for p in self.pairs if p.type == "actuator"]

    @property
    def sensors(self) -> list[Pair]:
        return [p for p in self.pairs if p.type == "sensor"]


def _secret(section: dict, key: str, where: str, required: bool) -> str | None:
    # Пароли и токены - только из переменных окружения: конфиг лежит рядом с
    # кодом и легко уезжает в git.
    env_name = section.get(f"{key}_env")
    if key in section:
        raise ConfigError(f"{where}.{key}: секрет в конфиге не храним, укажите {key}_env с именем переменной окружения")
    if not env_name:
        if required:
            raise ConfigError(f"{where}.{key}_env: не задано имя переменной окружения")
        return None
    value = os.environ.get(env_name)
    if required and not value:
        raise ConfigError(f"переменная окружения {env_name} пуста ({where}.{key}_env)")
    return value


def _pair(raw: dict, i: int) -> Pair:
    where = f"devices[{i}]"
    if not isinstance(raw, dict):
        raise ConfigError(f"{where}: ожидается словарь")
    name = raw.get("name")
    ptype = raw.get("type")
    tuya = raw.get("tuya") or {}
    ours = raw.get("ours") or {}
    if not name:
        raise ConfigError(f"{where}.name: обязательное поле")
    if ptype not in ("actuator", "sensor"):
        raise ConfigError(f"{where}.type: actuator или sensor, а не {ptype!r}")
    if not tuya.get("entity_id"):
        raise ConfigError(f"{where}.tuya.entity_id: обязательное поле")
    if not ours.get("friendly_name"):
        raise ConfigError(f"{where}.ours.friendly_name: обязательное поле")
    kind = raw.get("kind", "switch")
    if kind not in KINDS:
        raise ConfigError(f"{where}.kind: одно из {sorted(KINDS)}")
    interval = raw.get("report_interval_s")
    if ptype == "sensor" and not (isinstance(interval, (int, float)) and interval > 0):
        raise ConfigError(f"{where}.report_interval_s: для датчика нужен ожидаемый интервал отчётов, с")
    defaults = KINDS[kind]
    pair = Pair(
        name=str(name),
        type=ptype,
        tuya_entity=str(tuya["entity_id"]),
        ours=str(ours["friendly_name"]),
        kind=kind,
        report_interval_s=float(interval) if interval else None,
        far=bool(raw.get("far", False)),
        tuya_device_id=tuya.get("device_id"),
        tuya_dp=str(tuya["dp"]) if tuya.get("dp") is not None else None,
        ours_endpoint=ours.get("endpoint"),
        ours_report_cluster=ours.get("report_cluster"),
        ours_report_field=ours.get("report_field"),
        ours_report_dp=ours.get("report_dp"),
        ours_report_values=ours.get("report_values"),
        ours_key=raw.get("ours_key", defaults["ours_key"]),
        ours_values=list(raw.get("ours_values", defaults["ours_values"])),
        tuya_values=list(raw.get("tuya_values", defaults["tuya_values"])),
        ha_services=list(defaults["ha_services"]),
        ha_states=list(defaults["ha_states"]),
    )
    if pair.ours_endpoint is not None and (type(pair.ours_endpoint) is not int or not 1 <= pair.ours_endpoint <= 240):
        raise ConfigError(f"{where}.ours.endpoint: целое число 1…240")
    if pair.ours_report_dp is not None and (type(pair.ours_report_dp) is not int or not 1 <= pair.ours_report_dp <= 255):
        raise ConfigError(f"{where}.ours.report_dp: целое число 1…255")
    if pair.ours_report_dp is not None and pair.ours_report_field is not None:
        raise ConfigError(f"{where}.ours: report_dp и report_field взаимоисключающие")
    if pair.ours_report_field is not None and (not isinstance(pair.ours_report_field, str) or not pair.ours_report_field or not pair.ours_report_cluster):
        raise ConfigError(f"{where}.ours.report_field: нужен непустой ключ и report_cluster")
    if pair.ours_report_dp is not None or pair.ours_report_field is not None:
        if not isinstance(pair.ours_report_values, list) or len(pair.ours_report_values) != 2:
            raise ConfigError(f"{where}.ours.report_values: два сырых значения [вкл, выкл]")
    for attr in ("ours_values", "tuya_values"):
        if len(getattr(pair, attr)) != 2:
            raise ConfigError(f"{where}.{attr}: ровно два значения - [вкл, выкл]")
    return pair


def parse(data: dict, base_dir: Path = Path(".")) -> Config:
    if not isinstance(data, dict):
        raise ConfigError("конфиг: ожидается словарь")
    mqtt = data.get("mqtt") or {}
    ha = data.get("ha") or {}
    timing = data.get("timing") or {}
    if not mqtt.get("host"):
        raise ConfigError("mqtt.host: обязательное поле")
    if not ha.get("url"):
        raise ConfigError("ha.url: обязательное поле (ws://<адрес>:8123/api/websocket)")
    confirm = ha.get("confirm", "dp_event")
    if confirm not in CONFIRM_MODES:
        raise ConfigError(f"ha.confirm: одно из {CONFIRM_MODES}")

    raw_devices = data.get("devices") or []
    if not raw_devices:
        raise ConfigError("devices: нужна хотя бы одна пара")
    pairs = [_pair(raw, i) for i, raw in enumerate(raw_devices)]
    names = [p.name for p in pairs]
    dup = {n for n in names if names.count(n) > 1}
    if dup:
        raise ConfigError(f"devices: имена повторяются: {sorted(dup)}")

    interval = float(timing.get("command_interval_s", 10))
    timeout = float(timing.get("command_timeout_s", 8))
    if timeout > MAX_COMMAND_TIMEOUT_S:
        raise ConfigError(
            f"timing.command_timeout_s={timeout}: не больше {MAX_COMMAND_TIMEOUT_S} с - "
            "позже интеграция опрашивает кэш хаба, и его ответ засчитался бы устройству"
        )
    suspect = float(ha.get("suspect_window_s", DEFAULT_SUSPECT_WINDOW_S))
    if suspect < 0:
        raise ConfigError("ha.suspect_window_s: не меньше 0")
    if timeout >= interval:
        raise ConfigError("timing.command_timeout_s должен быть меньше command_interval_s")

    db = Path(data.get("db", ".work/zamer.sqlite"))
    if not db.is_absolute():
        db = (base_dir / db).resolve()
    return Config(
        mqtt=MqttCfg(
            host=str(mqtt["host"]),
            port=int(mqtt.get("port", 1883)),
            username=mqtt.get("username"),
            password=_secret(mqtt, "password", "mqtt", required=False),
            base_topic=str(mqtt.get("base_topic", "zigbee2mqtt")).rstrip("/"),
        ),
        ha=HaCfg(
            url=str(ha["url"]),
            token=_secret(ha, "token", "ha", required=True) or "",
            confirm=confirm,
            suspect_window_s=suspect,
        ),
        pairs=pairs,
        db_path=db,
        command_interval_s=interval,
        command_timeout_s=timeout,
    )


def load(path: str | Path) -> Config:
    path = Path(path)
    with path.open(encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return parse(data, base_dir=path.parent)
