import io
import json
from pathlib import Path
import re
import tarfile
from types import SimpleNamespace
import pytest
from zamer.radio import ASH, NCP, analyze, main, parse_log, read_records
from zamer.radio_capture import Recorder, TOPICS, capture_mqtt


def counters(layer, **values):
    names = NCP if layer == 'NCP' else ASH
    return {'kind': 'counters', 'layer': layer, 'values': [values.get(k, 0) for k in names]}


def log_line(row):
    return f"[2026-10-24 10:00:00] info: zh:ember: [{row['layer']} COUNTERS] " + ','.join(map(str, row['values']))


def test_contract_matches_shipped_core():
    root = Path(__file__).resolve().parents[2]
    with tarfile.open(root / 'addon/bms_zigbee/vendor/zigbee-herdsman.tgz') as archive:
        enums = archive.extractfile('package/dist/adapter/ember/enums.js').read().decode()
        ash = archive.extractfile('package/dist/adapter/ember/uart/ash.js').read().decode()
    entries = re.findall(r'EmberCounterType\[EmberCounterType\["(\w+)"\] = (\d+)\]', enums)
    assert [(name, int(i)) for name, i in entries if name != 'COUNT'] == list(zip(NCP, range(len(NCP))))
    assert re.findall(r'this.counters\.(\w+)', ash.split('readAndClearCounters()')[1].split('];')[0]) == ASH


def test_read_and_clear_sums_not_deltas_and_layers_do_not_mix():
    result = analyze([parse_log(log_line(counters('NCP', PHY_CCA_FAIL_COUNT=7))),
                      parse_log(log_line(counters('NCP', PHY_CCA_FAIL_COUNT=2))),
                      counters('ASH', rxAckTimeouts=3)], '10.10.0-bms.3')
    assert result['counters']['NCP']['PHY_CCA_FAIL_COUNT'] == 9
    assert result['counters']['ASH']['rxAckTimeouts'] == 3
    assert {i['layer'] for i in result['indicators']} == {'cca', 'transport'}
    assert result['samples'] == {'NCP': 2, 'ASH': 1}


def test_no_samples_is_not_healthy_and_zero_samples_not_proof():
    assert analyze([], '10.10.0')['assessment'] == 'insufficient_data'
    r = analyze([counters('NCP'), counters('ASH')], '10.10.0')
    assert r['assessment'] == 'no_indicators_in_samples' and r['indicators'] == []


@pytest.mark.parametrize('row', [
    {'kind': 'counters', 'layer': 'NCP', 'values': [0]},
    counters('NCP', PHY_CCA_FAIL_COUNT=-1), counters('NCP', PHY_CCA_FAIL_COUNT=True),
    counters('NCP', PHY_CCA_FAIL_COUNT=65536), counters('ASH', rxAckTimeouts=float('nan')),
])
def test_invalid_counters_never_contribute(row):
    r = analyze([row], '10.10.0')
    assert r['samples'] == {} and len(r['quality_issues']) == 1


def test_version_refusal_saturation_retained_and_disconnect():
    with pytest.raises(ValueError): analyze([], '11.0.0')
    with pytest.raises(ValueError): analyze([{'kind': 'context', 'herdsman': '10.9.0'}], '10.10.0')
    r = analyze([counters('NCP', PHY_CCA_FAIL_COUNT=65535),
                 {**counters('ASH', rxAckTimeouts=3), 'retained': True},
                 {'kind': 'mqtt_connection', 'state': 'disconnected'}], '10.10.0')
    assert r['samples'] == {'NCP': 1}
    assert {i['reason'] for i in r['quality_issues']} == {'ncp_counter_saturated_lower_bound', 'retained_event_ignored'}
    assert r['mqtt_capture_gaps']


def test_power_response_is_separate_from_config_and_physical_power():
    r = analyze([parse_log('BMS: transmit power set to 19 dBm (rejoin).'),
                 parse_log('BMS: failed to set transmit power to 13 dBm (restore) status=FAIL.')], '10.10.0')
    assert [v['accepted'] for v in r['power_command_results']] == [True, False]
    assert r['assessment'] == 'insufficient_data'


def test_file_plain_json_malformed_and_no_secrets(tmp_path):
    log = tmp_path / 'log.txt'
    log.write_text(log_line(counters('NCP', MAC_TX_UNICAST_FAILED=2)) + '\n' +
                   json.dumps({'message': log_line(counters('ASH'))}) + '\n{"broken"\nsecret=private-token\n')
    args = ['analyze', str(log), '--herdsman', '10.10.0', '--out', str(tmp_path / 'report')]
    assert main(args) == 0
    result = json.loads((tmp_path / 'report/radio.json').read_text())
    assert result['samples'] == {'NCP': 1, 'ASH': 1}
    assert result['quality_issues'][0]['reason'] == 'invalid_record'
    assert 'private-token' not in (tmp_path / 'report/radio.json').read_text()
    assert main(args) == 2


def test_capture_whitelist_redaction_and_retained():
    stream = io.StringIO(); recorder = Recorder(stream, 'bms')
    recorder.message('bms/bridge/info', json.dumps({'version': '2.14.2', 'zigbee_herdsman': {'version': '10.10.0-bms.3'},
        'config': {'advanced': {'network_key': 'SECRET', 'transmit_power': 13}, 'mqtt': {'password': 'SECRET'}},
        'coordinator': {'meta': {'revision': '7.4.4', 'secret': 'SECRET'}}}).encode(), True)
    recorder.message('bms/bridge/logging', json.dumps({'message': 'token=SECRET'}).encode())
    recorder.message('bms/private', b'SECRET')
    recorder.message('bms/bridge/logging', json.dumps({'message': log_line(counters('NCP'))}).encode(), True)
    recorder.message('bms/bridge/logging', json.dumps({'message': log_line(counters('NCP'))}).encode())
    recorder.message('bms/bridge/bms/device_report', b'{"schema":1,"data":{"secret":"SECRET"}}')
    assert 'SECRET' not in stream.getvalue()
    rows = [json.loads(s) for s in stream.getvalue().splitlines()]
    assert [r['kind'] for r in rows] == ['context', 'counters', 'device_report']
    assert rows[0]['configured_tx_power'] == 13 and rows[0]['firmware'] == {'revision': '7.4.4'}


def test_capture_sequence_gaps_duplicates_and_truncation():
    rows = [{'kind': 'capture_start', 'capture_session': 'a', 'sequence': 1},
            {**counters('NCP', PHY_CCA_FAIL_COUNT=4), 'capture_session': 'a', 'sequence': 3}]
    r = analyze(rows + [rows[1]], '10.10.0')
    assert r['counters']['NCP']['PHY_CCA_FAIL_COUNT'] == 4
    assert {i['reason'] for i in r['quality_issues']} == {
        'capture_sequence_gap', 'duplicate_or_reordered_capture_record', 'capture_end_missing'}


def test_mqtt_capture_never_publishes(monkeypatch, tmp_path):
    import paho.mqtt.client as mqtt
    instances = []
    class Client:
        def __init__(self, *a, **k): instances.append(self); self.subscriptions = []
        def reconnect_delay_set(self, *a): pass
        def connect_async(self, *a, **k): pass
        def loop_start(self): self.on_connect(self, None, None, SimpleNamespace(is_failure=False), None)
        def subscribe(self, topics):
            self.subscriptions.extend(topics)
            self.on_subscribe(self, None, 1, [SimpleNamespace(is_failure=False)], None)
        def disconnect(self): pass
        def loop_stop(self): pass
        def publish(self, *a, **k): pytest.fail('diagnostic collector must never publish')
    monkeypatch.setattr(mqtt, 'Client', Client)
    args = SimpleNamespace(host='unused', port=1883, username=None, password_env=None, base_topic='z2m',
                           seconds=0.001, out=tmp_path / 'capture.jsonl')
    assert capture_mqtt(args) == 0
    assert instances[0].subscriptions == [(f'z2m/{topic}', 0) for topic in TOPICS]
    rows = list(read_records(args.out))
    assert rows[-1]['kind'] == 'capture_end'
    assert not analyze(rows, '10.10.0')['mqtt_capture_gaps']
