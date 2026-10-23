"""Конфиг: пример из README рабочий, ошибки ловятся с понятным текстом."""
from pathlib import Path

import pytest

from zamer import config as config_mod
from zamer.config import ConfigError

HERE = Path(__file__).resolve().parent.parent


def _base(**over):
    data = {
        "mqtt": {"host": "h"},
        "ha": {"url": "ws://h:8123/api/websocket", "token_env": "HA_TOKEN_T"},
        "devices": [{"name": "a", "type": "actuator", "tuya": {"entity_id": "switch.a"}, "ours": {"friendly_name": "a"}}],
    }
    data.update(over)
    return data


def test_example_config_is_valid(monkeypatch):
    monkeypatch.setenv("HA_TOKEN", "t")
    monkeypatch.setenv("MQTT_PASSWORD", "p")
    cfg = config_mod.load(HERE / "example.config.yaml")
    assert [p.name for p in cfg.actuators] == ["rozetka_kuhnya", "rele_garazh", "shtory_zal"]
    assert cfg.pair("rele_garazh").far and cfg.pair("rele_garazh").tuya_dp == "1"
    assert cfg.pair("shtory_zal").ours_values == ["OPEN", "CLOSE"]
    assert cfg.pair("datchik_vanna").report_interval_s == 3600
    assert cfg.ha.token == "t" and cfg.mqtt.password == "p"
    assert cfg.db_path == HERE / ".work" / "zamer.sqlite"


def test_secret_in_file_is_refused(monkeypatch):
    with pytest.raises(ConfigError, match="секрет"):
        config_mod.parse(_base(ha={"url": "ws://x", "token": "abc"}))


def test_missing_token_env(monkeypatch):
    monkeypatch.delenv("HA_TOKEN_T", raising=False)
    with pytest.raises(ConfigError, match="HA_TOKEN_T"):
        config_mod.parse(_base())


def test_timeout_longer_than_cache_answer_is_refused(monkeypatch):
    monkeypatch.setenv("HA_TOKEN_T", "t")
    with pytest.raises(ConfigError, match="кэш"):
        config_mod.parse(_base(timing={"command_interval_s": 20, "command_timeout_s": 12}))


def test_sensor_needs_interval(monkeypatch):
    monkeypatch.setenv("HA_TOKEN_T", "t")
    dev = {"name": "s", "type": "sensor", "tuya": {"entity_id": "sensor.s"}, "ours": {"friendly_name": "s"}}
    with pytest.raises(ConfigError, match="report_interval_s"):
        config_mod.parse(_base(devices=[dev]))


def test_duplicate_names(monkeypatch):
    monkeypatch.setenv("HA_TOKEN_T", "t")
    dev = _base()["devices"][0]
    with pytest.raises(ConfigError, match="повторяются"):
        config_mod.parse(_base(devices=[dev, dev]))
