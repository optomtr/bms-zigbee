"""Пассивная диагностика Ember 10.10.0: счётчики слоёв, а не диагноз по timeout."""
from __future__ import annotations

import argparse
from collections import Counter
import json
import math
from pathlib import Path
import re

# Порядок из EmberCounterType и UartAsh.readAndClearCounters закреплённого ядра.
# Тест сверяет его с реально упакованным vendor, чтобы обновление не меняло смысл чисел молча.
SUPPORTED = {"10.10.0", "10.10.0-bms.3"}
NCP = (
    "MAC_RX_BROADCAST MAC_TX_BROADCAST MAC_RX_UNICAST MAC_TX_UNICAST_SUCCESS "
    "MAC_TX_UNICAST_RETRY MAC_TX_UNICAST_FAILED APS_DATA_RX_BROADCAST APS_DATA_TX_BROADCAST "
    "APS_DATA_RX_UNICAST APS_DATA_TX_UNICAST_SUCCESS APS_DATA_TX_UNICAST_RETRY APS_DATA_TX_UNICAST_FAILED "
    "ROUTE_DISCOVERY_INITIATED NEIGHBOR_ADDED NEIGHBOR_REMOVED NEIGHBOR_STALE JOIN_INDICATION CHILD_REMOVED "
    "ASH_OVERFLOW_ERROR ASH_FRAMING_ERROR ASH_OVERRUN_ERROR NWK_FRAME_COUNTER_FAILURE APS_FRAME_COUNTER_FAILURE "
    "ASH_XOFF APS_LINK_KEY_NOT_AUTHORIZED NWK_DECRYPTION_FAILURE APS_DECRYPTION_FAILURE "
    "ALLOCATE_PACKET_BUFFER_FAILURE RELAYED_UNICAST PHY_TO_MAC_QUEUE_LIMIT_REACHED "
    "PACKET_VALIDATE_LIBRARY_DROPPED_COUNT TYPE_NWK_RETRY_OVERFLOW PHY_CCA_FAIL_COUNT BROADCAST_TABLE_FULL "
    "PTA_LO_PRI_REQUESTED PTA_HI_PRI_REQUESTED PTA_LO_PRI_DENIED PTA_HI_PRI_DENIED PTA_LO_PRI_TX_ABORTED "
    "PTA_HI_PRI_TX_ABORTED ADDRESS_CONFLICT_SENT CSL_RX_SCHEDULE_FAILED"
).split()
ASH = (
    "txData txAllFrames txDataFrames txAckFrames txNakFrames txReDataFrames txN1Frames txCancelled "
    "rxData rxAllFrames rxDataFrames rxAckFrames rxNakFrames rxReDataFrames rxN1Frames rxCancelled "
    "rxCrcErrors rxCommErrors rxTooShort rxTooLong rxBadControl rxBadLength rxBadAckNumber rxNoBuffer "
    "rxDuplicates rxOutOfSequence rxAckTimeouts"
).split()
ANSI = re.compile(r"\x1b\[[0-9;]*m")
COUNTERS = re.compile(r"\[(NCP|ASH) COUNTERS\]\s*(.*?)\s*$")
POWER = re.compile(r"BMS: (failed to set transmit power to|transmit power set to) (-?\d+) dBm")
LIFECYCLE = ("ASH disconnected", "ASH connected", "ASH started", "ASH stopped", "NCP FATAL ERROR",
             "Adapter disconnected", "Starting zigbee-herdsman", "HOST_FATAL_ERROR", "ASH reset")


def parse_log(message: str) -> dict | None:
    message = ANSI.sub("", message)
    match = COUNTERS.search(message)
    if match:
        layer, raw = match.groups()
        names = NCP if layer == "NCP" else ASH
        tokens = raw.split(",")
        if len(tokens) != len(names) or any(not re.fullmatch(r"\s*\d+\s*", s) for s in tokens):
            return {"kind": "invalid_counter", "layer": layer, "reason": "length_or_encoding"}
        values = [int(s) for s in tokens]
        limit = 65535 if layer == "NCP" else 2**53 - 1
        if any(n > limit for n in values):
            return {"kind": "invalid_counter", "layer": layer, "reason": "range"}
        return {"kind": "counters", "layer": layer, "values": values}
    match = POWER.search(message)
    if match:
        return {"kind": "power", "accepted": match[1] == "transmit power set to", "dbm": int(match[2]),
                "evidence": "ncp_command_status"}
    for marker in LIFECYCLE:
        if marker.lower() in message.lower():
            event = {"kind": "lifecycle", "event": marker}
            version = re.search(r"Starting zigbee-herdsman \(([^)]+)\)", message)
            if version:
                event["herdsman"] = version[1]
            return event
    return None


def read_records(path: Path):
    """Читаем файл потоком; произвольный log никогда не копируем в итоговый отчёт."""
    with path.open(encoding="utf-8", errors="replace") as stream:
        for line_no, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                data = json.loads(line)
            except ValueError:
                if line.lstrip().startswith("{"):
                    yield {"kind": "invalid_record", "line": line_no}
                    continue
                record = parse_log(line)
            else:
                if not isinstance(data, dict):
                    yield {"kind": "invalid_record", "line": line_no}
                    continue
                if data.get("schema") == 1 and data.get("format") == "bms-radio":
                    record = data
                elif isinstance(data.get("message"), str):
                    record = parse_log(data["message"])
                else:
                    record = {"kind": "invalid_record"}
            if record:
                yield {**record, "line": line_no}


def analyze(records, herdsman: str) -> dict:
    if herdsman not in SUPPORTED:
        raise ValueError(f"нет проверенной схемы счётчиков для {herdsman}; поддержаны {sorted(SUPPORTED)}")
    totals = {"NCP": Counter(), "ASH": Counter()}
    samples = Counter()
    events = Counter()
    traffic = Counter()
    issues = []
    powers = []
    contexts = []
    capture_sequences = {}
    captures_started, captures_ended = set(), set()
    source_seen = set()
    for record in records:
        kind = record.get("kind")
        line = record.get("line")
        capture_id, sequence = record.get("capture_session"), record.get("sequence")
        if capture_id is not None:
            if not isinstance(capture_id, str) or type(sequence) is not int or sequence <= 0:
                issues.append({"line": line, "reason": "invalid_capture_sequence"})
                continue
            previous = capture_sequences.get(capture_id, 0)
            if sequence <= previous:
                issues.append({"line": line, "reason": "duplicate_or_reordered_capture_record"})
                continue
            if sequence != previous + 1:
                issues.append({"line": line, "reason": "capture_sequence_gap"})
            capture_sequences[capture_id] = sequence
            if kind == "capture_start":
                captures_started.add(capture_id)
            if kind == "capture_end":
                captures_ended.add(capture_id)
                if record.get("complete") is not True:
                    issues.append({"line": line, "reason": "capture_ended_early"})
        if kind in {"tx_event", "device_report"}:
            source = record.get("source_session"), record.get("source_sequence"), kind
            if isinstance(source[0], str) and type(source[1]) is int:
                if source in source_seen:
                    issues.append({"line": line, "reason": "duplicate_source_event"})
                    continue
                source_seen.add(source)
        if record.get("retained") and kind not in {"context", "extensions"}:
            issues.append({"line": line, "reason": "retained_event_ignored"})
            continue
        observed = record.get("herdsman")
        if observed and observed != herdsman:
            raise ValueError(f"строка {line}: версия {observed} отличается от выбранной {herdsman}")
        if kind == "counters":
            layer, values = record.get("layer"), record.get("values")
            names = NCP if layer == "NCP" else ASH if layer == "ASH" else []
            maximum = 65535 if layer == "NCP" else 2**53 - 1
            if (not names or not isinstance(values, list) or len(values) != len(names)
                    or any(type(v) is not int or not 0 <= v <= maximum for v in values)):
                issues.append({"line": line, "reason": "invalid_counter"})
                continue
            # readAndClear уже возвращает интервалы: вычитание соседних выборок ошибочно.
            totals[layer].update(dict(zip(names, values)))
            samples[layer] += 1
            if layer == "NCP" and 65535 in values:
                issues.append({"line": line, "reason": "ncp_counter_saturated_lower_bound"})
        elif kind in {"invalid_counter", "invalid_record"}:
            issues.append({"line": line, "reason": kind})
        elif kind == "mqtt_connection":
            state = record.get("state")
            if state in {"connected", "disconnected"}:
                events[f"mqtt_{state}"] += 1
        elif kind == "lifecycle":
            event = record.get("event")
            if event in LIFECYCLE:
                events[event] += 1
        elif kind == "power":
            if type(record.get("accepted")) is bool and type(record.get("dbm")) is int:
                powers.append({"line": line, "accepted": record["accepted"], "dbm": record["dbm"]})
        elif kind == "extensions" and record.get("status") in {"loading", "ready", "degraded"}:
            events["extensions_" + record["status"]] += 1
        elif kind == "context":
            # Поля allowlist: network_key, MQTT-пароль и HA-токен сюда не попадают.
            contexts.append({k: record[k] for k in ("herdsman", "z2m", "firmware", "channel", "configured_tx_power", "adapter") if k in record})
        elif kind == "tx_event" and record.get("event") in {"mqtt_intent", "group_frame", "unicast_frame"}:
            traffic[record["event"]] += 1
        elif kind == "device_report":
            traffic["device_report"] += 1
    for capture_id in captures_started - captures_ended:
        issues.append({"reason": "capture_end_missing", "capture_session": capture_id})
    ncp, ash = totals["NCP"], totals["ASH"]
    indicators = []
    def indicator(name, evidence, next_step):
        positive = {k: v for k, v in evidence.items() if v > 0}
        if positive:
            indicators.append({"layer": name, "evidence": positive, "next_step": next_step})
    indicator("cca", {"PHY_CCA_FAIL_COUNT": ncp["PHY_CCA_FAIL_COUNT"]},
              "Зафиксированы отказы CCA. Сопоставить с нагрузкой и местом; изменение CCA допустимо только после проверки контракта прошивки и A/B.")
    indicator("mac_aps", {k: ncp[k] for k in ("MAC_TX_UNICAST_RETRY", "MAC_TX_UNICAST_FAILED", "APS_DATA_TX_UNICAST_RETRY", "APS_DATA_TX_UNICAST_FAILED")},
              "Есть повторы/отказы доставки на уровне MAC/APS. Они не доказывают причину и не равны числу неисполненных команд.")
    indicator("buffers", {k: ncp[k] for k in ("ALLOCATE_PACKET_BUFFER_FAILURE", "PHY_TO_MAC_QUEUE_LIMIT_REACHED", "TYPE_NWK_RETRY_OVERFLOW", "BROADCAST_TABLE_FULL")},
              "Проверить предложенную нагрузку и очереди до экспериментов с мощностью/прошивкой.")
    indicator("transport", {**{k: ash[k] for k in ("rxCrcErrors", "rxCommErrors", "rxAckTimeouts", "rxNoBuffer", "rxBadAckNumber")},
                            **{k: ncp[k] for k in ("ASH_OVERFLOW_ERROR", "ASH_FRAMING_ERROR", "ASH_OVERRUN_ERROR")}},
              "Есть признаки проблем ASH/UART. Проверить транспорт до NCP отдельно; счётчик сам по себе не локализует Ethernet или UART.")
    indicator("security", {k: ncp[k] for k in ("NWK_FRAME_COUNTER_FAILURE", "APS_FRAME_COUNTER_FAILURE", "APS_LINK_KEY_NOT_AUTHORIZED", "NWK_DECRYPTION_FAILURE", "APS_DECRYPTION_FAILURE")},
              "Есть отбрасывания по безопасности. Сопоставить с rejoin и конкретными устройствами, не считать это слабым сигналом.")
    gaps = bool(events["mqtt_disconnected"] or events["mqtt_connected"] > 1)
    return {
        "schema": 1, "herdsman_contract": herdsman,
        "assessment": "indicators_present" if indicators else "no_indicators_in_samples" if samples["NCP"] and samples["ASH"] else "insufficient_data",
        "samples": dict(samples), "counters": {k: dict(v) for k, v in totals.items()},
        "indicators": indicators, "quality_issues": issues, "mqtt_capture_gaps": gaps,
        "events": dict(events), "traffic_observed": dict(traffic), "power_command_results": powers, "contexts": contexts,
        "limits": [
            "Суммы относятся только к записанным read-and-clear выборкам, не ко всему времени файла. Первая выборка может начинаться до захвата.",
            "Штатный watchdog снимает счётчики раз в час; короткий журнал без них не подтверждает исправность радио.",
            "NCP и ASH имеют разные единицы. MQTT ingress, API-вызовы, device reports и физическое исполнение не взаимозаменяемы.",
            "MQTT logging подавляет одинаковые сообщения подряд; QoS 0, разрывы и ротация могут терять выборки. Полнота не гарантирована.",
            "Положительные счётчики дают направление проверки, а не причинный диагноз. Нулевые не исключают неисправность.",
            "Мощность в конфиге — запрос, успешный setPower — ответ NCP, ни то ни другое не измеряет фактическую мощность передатчика.",
        ],
    }


def markdown(result: dict) -> str:
    rows = ["# Диагностика BMS Zigbee", "", f"Контракт ядра: `{result['herdsman_contract']}`.",
            f"Результат: `{result['assessment']}`. Это направления проверки, не установленная причина сбоя.", "",
            f"Выборки: NCP — {result['samples'].get('NCP', 0)}, ASH — {result['samples'].get('ASH', 0)}.",
            f"Замечания к данным: {len(result['quality_issues'])}; разрывы MQTT: {result['mqtt_capture_gaps']}.", ""]
    for item in result["indicators"]:
        rows += [f"- **{item['layer']}**: " + ", ".join(f"{k}={v}" for k, v in item["evidence"].items()) + ". " + item["next_step"]]
    rows += ["", "## Границы вывода", ""] + [f"- {s}" for s in result["limits"]]
    rows += ["", "Полные именованные счётчики, контекст и ошибки качества сохранены в JSON.", ""]
    return "\n".join(rows)


def positive_seconds(text: str) -> float:
    value = float(text)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError("длительность должна быть положительным конечным числом секунд")
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description="Пассивная диагностика радио BMS; без команд координатору")
    sub = parser.add_subparsers(dest="command", required=True)
    report = sub.add_parser("analyze", help="расшифровать сохранённый журнал, без сети")
    report.add_argument("input", type=Path)
    report.add_argument("--herdsman", required=True, help="точная версия из установленной сборки")
    report.add_argument("--out", type=Path, required=True, help="новая папка JSON + Markdown")
    capture = sub.add_parser("capture", help="только подписка на диагностические MQTT-топики")
    capture.add_argument("--host", required=True)
    capture.add_argument("--port", type=int, default=1883)
    capture.add_argument("--base-topic", default="zigbee2mqtt")
    capture.add_argument("--username")
    capture.add_argument("--password-env", help="имя переменной окружения, не сам пароль")
    capture.add_argument("--seconds", type=positive_seconds, default=3900)
    capture.add_argument("--out", type=Path, required=True, help="новый JSONL файл")
    args = parser.parse_args(argv)
    try:
        if args.command == "capture":
            from .radio_capture import capture_mqtt
            return capture_mqtt(args)
        result = analyze(read_records(args.input), args.herdsman)
        args.out.mkdir(parents=True, exist_ok=False)
        (args.out / "radio.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        (args.out / "radio.md").write_text(markdown(result))
        print(f"{result['assessment']}: {args.out / 'radio.md'}")
        return 0
    except (OSError, ValueError) as error:
        print(f"Диагностика: {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
