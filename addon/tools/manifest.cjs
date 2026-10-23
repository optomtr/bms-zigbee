// BMS: один воспроизводимый паспорт содержимого, без зависимости от mtime архива.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const app = path.join(root, 'addon/bms_zigbee');
const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json')));
const tested = JSON.parse(fs.readFileSync(path.join(root, 'addon/.work/z2m-tested.json')));
if (JSON.stringify(tested.inputs) !== JSON.stringify(require('./record-z2m-build.cjs').inputs())) {
    throw new Error('BMS: исходники изменились после проверки Z2M; выполните addon/tools/check-z2m.sh');
}
const archive = path.join(app, 'vendor/zigbee-herdsman.tgz');
const readArchive = name => execFileSync('tar', ['-xOzf', archive, `package/${name}`], {maxBuffer: 16 * 1024 * 1024});
const pkg = JSON.parse(readArchive('package.json'));
const expected = `${versions['zigbee-herdsman']}-bms.${fs.readFileSync(path.join(root, 'core/BMS_REVISION'), 'utf8').trim()}`;
if (pkg.name !== 'zigbee-herdsman' || pkg.version !== expected || !pkg.bms?.patches?.includes('0005-response-retry-and-confirmed-power.patch')) {
    throw new Error(`BMS: vendor должен содержать ${expected} с патчем 0005, получено ${pkg.version}`);
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
if (sha(fs.readFileSync(archive)) !== versions['bms-core-sha256']) throw new Error('BMS: SHA vendor не совпадает с versions.json');
const files = {};
function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
        const file = path.join(dir, name);
        if (fs.statSync(file).isDirectory()) walk(file);
        else files[path.relative(app, file)] = sha(fs.readFileSync(file));
    }
}
for (const dir of ['vendor', 'z2m-patches', 'bms-layer', 'rootfs']) walk(path.join(app, dir));
const coreFiles = {};
for (const name of ['dist/controller/model/device.js', 'dist/adapter/ember/adapter/emberAdapter.js']) coreFiles[name] = sha(readArchive(name));
const manifest = {
    schema: 1,
    build_version: `${versions.zigbee2mqtt}-bms.${versions['bms-addon-revision']}`,
    zigbee2mqtt: versions.zigbee2mqtt,
    converters: versions['zigbee-herdsman-converters'],
    herdsman: pkg.version,
    core_patches: pkg.bms.patches,
    vendor_sha256: versions["bms-core-sha256"],
    required_extensions: fs.readdirSync(path.join(app, "bms-layer/external_extensions")).filter(n => /^bms-.*\.(mjs|cjs|js)$/.test(n)).sort(),
    core_files: coreFiles,
    z2m_files: tested.files,
    z2m_verified_inputs: tested.inputs,
    z2m_patches: fs.readdirSync(path.join(app, 'z2m-patches')).filter(n => n.endsWith('.patch')).sort(),
    source_tree_sha256: sha(JSON.stringify(files)),
    files,
};
fs.writeFileSync(path.join(app, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`BMS: паспорт ${manifest.build_version}, дерево ${manifest.source_tree_sha256}`);
