const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {verify} = require('../tools/verify-stage.cjs');
const repo = path.resolve(__dirname, '../..');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bms-stage-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    for (const item of ['addon/bms_zigbee', 'tuya/layer/external_extensions', 'tuya/layer/external_converters', 'tuya/layer/bms-models.example.yaml', 'core/BMS_REVISION', 'versions.json']) {
        fs.mkdirSync(path.dirname(path.join(root, item)), {recursive: true});
        fs.cpSync(path.join(repo, item), path.join(root, item), {recursive: true});
    }
    return {root, run: () => verify(root), change: (file, data) => fs.writeFileSync(path.join(root, file), data)};
}
test('committed release layer, versions, vendor SHA and manifest match', () => assert.match(verify(repo), /совпадают/));
test('source edits without stage cannot be hidden by rebuilding in CI', t => {
    const f = fixture(t);
    f.change('tuya/layer/external_extensions/bms-tuya-service.mjs', '// changed only in source');
    assert.throws(f.run, /исходный и упакованный слой расходятся/);
});
test('stale extra layer files and tampered staged files are rejected', t => {
    const f = fixture(t);
    f.change('addon/bms_zigbee/bms-layer/external_extensions/bms-obsolete.mjs', '// stale');
    assert.throws(f.run, /bms-obsolete/);
    fs.unlinkSync(path.join(f.root, 'addon/bms_zigbee/bms-layer/external_extensions/bms-obsolete.mjs'));
    f.change('addon/bms_zigbee/rootfs/opt/bms/verify-build.js', '// different runtime');
    assert.throws(f.run, /паспорт не соответствует/);
});
test('different core checksum pin and release revision are rejected', t => {
    const f = fixture(t);
    const versions = JSON.parse(fs.readFileSync(path.join(f.root, 'versions.json')));
    f.change('versions.json', JSON.stringify({...versions, 'bms-core-sha256': '0'.repeat(64)}));
    assert.throws(f.run, /vendor SHA/);
    f.change('versions.json', JSON.stringify({...versions, 'bms-addon-revision': 999}));
    assert.throws(f.run, /версии композиции/);
});
