const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {verify} = require('../bms_zigbee/rootfs/opt/bms/verify-build.js');
const digest = s => createHash('sha256').update(s).digest('hex');
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bms-build-test-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const put = (name, data) => {const p = path.join(dir, name);fs.mkdirSync(path.dirname(p), {recursive: true});fs.writeFileSync(p, data);return p;};
    put('app/package.json', JSON.stringify({version: '2.14.2'}));
    put('app/node_modules/zigbee-herdsman/package.json', JSON.stringify({version: '10.10.0-bms.3'}));
    put('app/node_modules/zigbee-herdsman/index.js', '// fixture entry');
    put('app/node_modules/zigbee-herdsman-converters/package.json', JSON.stringify({version: '26.115.1'}));
    const core = put('app/node_modules/zigbee-herdsman/dist/device.js', 'patched core');
    put('layer/external_extensions/bms-test.mjs', 'layer');
    const manifest = {schema: 1,build_version: '2.14.2-bms.7',zigbee2mqtt: '2.14.2',herdsman: '10.10.0-bms.3',converters: '26.115.1',
        core_patches: ['0005-response-retry-and-confirmed-power.patch'],core_files: {'dist/device.js': digest('patched core')},
        files: {'bms-layer/external_extensions/bms-test.mjs': digest('layer')},z2m_patches: ['0004.patch','0005.patch'],source_tree_sha256: 'test'};
    const file = put('manifest.json', JSON.stringify(manifest));
    return {dir,put,core,file,manifest,run: () => verify(file,path.join(dir,'app'),path.join(dir,'layer'))};
}
test('runtime identifies exact BMS composition', t => {
    const f=fixture(t);assert.match(f.run(), /build=2.14.2-bms.7;.*herdsman=10.10.0-bms.3/);
});
test('stock or mismatched core cannot silently start', t => {
    const f=fixture(t);f.put('app/node_modules/zigbee-herdsman/package.json', JSON.stringify({version:'10.10.0'}));
    assert.throws(f.run,/версии/);
});
test('nested core used by converters cannot silently start', t => {
    const f=fixture(t);
    f.put('app/node_modules/zigbee-herdsman-converters/node_modules/zigbee-herdsman/package.json', JSON.stringify({version:'10.10.0'}));
    f.put('app/node_modules/zigbee-herdsman-converters/node_modules/zigbee-herdsman/index.js', '// stock');
    assert.throws(f.run,/другой экземпляр/);
});
test('tampered compiled core or missing manifest cannot start', t => {
    const f=fixture(t);fs.writeFileSync(f.core,'stock core');assert.throws(f.run,/контрольная сумма/);
    fs.unlinkSync(f.file);assert.throws(f.run,/ENOENT/);
});
test('staging fails before a stock fallback when expected archive is missing', t => {
    const f=fixture(t);
    f.put('versions.json',JSON.stringify({zigbee2mqtt:'2.14.2','zigbee-herdsman':'10.10.0','bms-addon-revision':7}));
    f.put('core/BMS_REVISION','3');f.put('addon/bms_zigbee/config.yaml','version: 2.14.2-bms.6\n');
    f.put('addon/stage.sh',fs.readFileSync(path.join(__dirname,'../stage.sh')));
    const result=spawnSync('bash',[path.join(f.dir,'addon/stage.sh')],{encoding:'utf8'});
    assert.notEqual(result.status,0);assert.match(result.stderr,/fallback запрещён/);
    assert.equal(fs.existsSync(path.join(f.dir,'addon/bms_zigbee/vendor/zigbee-herdsman.tgz')),false);
});
