"""Только MQTT subscribe: не открывает TCP/6638, не вызывает probe/reset/scan."""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone

from .radio import parse_log

TOPICS = ("bridge/info", "bridge/logging", "bridge/bms/extensions", "bridge/bms/tx_event", "bridge/bms/device_report")


def scalar(value):
    return value if type(value) in (str, int, float, bool) or value is None else None


class Recorder:
    def __init__(self, stream, base):
        self.stream = stream
        self.base = base.rstrip("/")
        self.session = str(uuid.uuid4())
        self.sequence = 0
        self.lock = threading.Lock()
        self.bytes_written = 0

    def write(self, record):
        with self.lock:
            self.sequence += 1
            row = {**record, "format": "bms-radio", "schema": 1, "capture_session": self.session,
                   "sequence": self.sequence, "received_at": datetime.now(timezone.utc).isoformat()}
            text = json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n"
            # Ограничиваем журнал; превышение останавливает сбор, а не делает вид полного захвата.
            if self.bytes_written + len(text.encode()) > 64 * 1024 * 1024:
                raise ValueError("достигнут предел журнала 64 MiB; завершите анализ и начните новый захват")
            self.stream.write(text)
            self.stream.flush()
            self.bytes_written += len(text.encode())

    def message(self, topic, payload, retained=False):
        prefix = self.base + "/"
        if not topic.startswith(prefix) or topic[len(prefix):] not in TOPICS:
            return
        suffix = topic[len(prefix):]
        if retained and suffix not in {"bridge/info", "bridge/bms/extensions"}:
            return
        if len(payload) > 1024 * 1024:
            self.write({"kind": "invalid_record", "reason": "payload_too_large"})
            return
        try:
            data = json.loads(payload)
            if not isinstance(data, dict):
                raise ValueError("object required")
        except (ValueError, UnicodeDecodeError):
            self.write({"kind": "invalid_record", "reason": "invalid_json"})
            return
        record = None
        if suffix == "bridge/logging" and isinstance(data.get("message"), str):
            record = parse_log(data["message"])
        elif suffix == "bridge/info":
            cfg = data.get("config") or {}
            advanced = cfg.get("advanced") or {}
            coordinator = data.get("coordinator") or {}
            meta = coordinator.get("meta") or {}
            record = {"kind": "context", "z2m": scalar(data.get("version")),
                      "herdsman": scalar((data.get("zigbee_herdsman") or {}).get("version")),
                      "firmware": {k: scalar(meta.get(k)) for k in ("majorrel", "minorrel", "maintrel", "revision", "build", "ezsp") if k in meta},
                      "adapter": scalar((cfg.get("serial") or {}).get("adapter")),
                      "channel": scalar((data.get("network") or {}).get("channel")),
                      "configured_tx_power": scalar(advanced.get("transmit_power"))}
        elif suffix == "bridge/bms/extensions":
            record = {"kind": "extensions", "status": scalar(data.get("status"))}
        elif suffix == "bridge/bms/tx_event" and data.get("schema") == 1:
            record = {"kind": "tx_event", "event": scalar(data.get("kind")), "source_session": scalar(data.get("session_id")),
                      "source_sequence": scalar(data.get("sequence"))}
        elif suffix == "bridge/bms/device_report" and data.get("schema") == 1:
            record = {"kind": "device_report", "source_session": scalar(data.get("session_id")),
                      "source_sequence": scalar(data.get("sequence"))}
        if record:
            self.write({**record, "retained": retained})


def capture_mqtt(args):
    import paho.mqtt.client as mqtt

    if not 1 <= args.port <= 65535 or not args.base_topic or any(c in args.base_topic for c in "+#"):
        raise ValueError("неверный порт или base-topic")
    password = os.environ.get(args.password_env) if args.password_env else None
    if args.password_env and not password:
        raise ValueError(f"переменная {args.password_env} пуста")
    connected = threading.Event()
    stop = threading.Event()
    errors = []
    interrupted = False
    with args.out.open("x", encoding="utf-8") as stream:
        recorder = Recorder(stream, args.base_topic)
        recorder.write({"kind": "capture_start", "duration_requested_s": args.seconds})
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"bms-radio-{uuid.uuid4().hex[:12]}")
        if args.username:
            client.username_pw_set(args.username, password)

        def safe(record):
            try:
                recorder.write(record)
            except (OSError, ValueError) as error:
                errors.append(str(error))
                stop.set()

        def on_connect(c, _userdata, _flags, reason, _properties):
            if reason.is_failure:
                errors.append("брокер отказал в подключении")
                stop.set()
                return
            # У клиента нет publish/запросов bridge; только эти пять подписок.
            c.subscribe([(f"{recorder.base}/{topic}", 0) for topic in TOPICS])
            safe({"kind": "mqtt_connection", "state": "connected"})

        def on_subscribe(_c, _userdata, _mid, reasons, _properties):
            if any(code.is_failure for code in reasons):
                errors.append("брокер отказал в диагностической подписке")
                stop.set()
            else:
                connected.set()

        def on_disconnect(_c, _userdata, _flags, _reason, _properties):
            safe({"kind": "mqtt_connection", "state": "disconnected"})

        def on_message(_c, _userdata, msg):
            try:
                recorder.message(msg.topic, msg.payload, bool(msg.retain))
            except (OSError, ValueError, TypeError, AttributeError) as error:
                errors.append(f"сбор прерван: {type(error).__name__}")
                stop.set()

        client.on_connect, client.on_disconnect = on_connect, on_disconnect
        client.on_subscribe, client.on_message = on_subscribe, on_message
        client.reconnect_delay_set(1, 30)
        try:
            client.connect_async(args.host, args.port, keepalive=30)
            client.loop_start()
            deadline = time.monotonic() + 15
            while not connected.is_set() and not stop.is_set() and time.monotonic() < deadline:
                stop.wait(0.1)
            if not connected.is_set():
                raise ValueError(errors[0] if errors else "MQTT не подключился за 15 секунд")
            print(f"Пассивный сбор {args.seconds:g} с → {args.out}; команды не отправляются", flush=True)
            stop.wait(args.seconds)
        except KeyboardInterrupt:
            interrupted = True
        except Exception:
            interrupted = True
            raise
        finally:
            # Обычное завершение не выдаём за разрыв сети.
            client.on_disconnect = None
            client.disconnect()
            client.loop_stop()
            safe({"kind": "capture_end", "complete": not errors and not interrupted})
        if errors:
            raise ValueError(errors[0])
    return 0
