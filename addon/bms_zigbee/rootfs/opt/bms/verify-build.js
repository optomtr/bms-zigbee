'use strict';
// BMS: название дополнения не доказывает, что внутри действительно наше ядро.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
function verify(manifestFile = '/opt/bms-build-manifest.json', app = '/app', layer = '/opt/bms-layer') {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.schema !== 1 || !manifest.herdsman?.includes('-bms.') || !manifest.core_patches?.includes('0005-response-retry-and-confirmed-power.patch')) {
        throw new Error('нет совместимого паспорта BMS/патча ядра');
    }
    const readPackage = name => JSON.parse(fs.readFileSync(path.join(app, 'node_modules', name, 'package.json'), 'utf8'));
    const core = readPackage('zigbee-herdsman');
    const z2m = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    if (core.version !== manifest.herdsman || z2m.version !== manifest.zigbee2mqtt || readPackage('zigbee-herdsman-converters').version !== manifest.converters) {
        throw new Error('версии установленных Z2M/herdsman/converters не совпадают с паспортом BMS');
    }
    const converterDirectory = fs.realpathSync(path.join(app, 'node_modules/zigbee-herdsman-converters'));
    const resolveCore = from => fs.realpathSync(require.resolve('zigbee-herdsman', {paths: [from]}));
    if (resolveCore(app) !== resolveCore(converterDirectory)) {
        throw new Error('converters использует другой экземпляр ядра zigbee-herdsman');
    }
    const check = (file, expected) => {
        const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (actual !== expected) throw new Error(`контрольная сумма не совпала: ${file}`);
    };
    if (!Object.keys(manifest.core_files ?? {}).length) throw new Error('в паспорте нет контрольных сумм ядра');
    for (const [name, expected] of Object.entries(manifest.core_files)) check(path.join(app, 'node_modules/zigbee-herdsman', name), expected);
    if (!manifest.z2m_files?.['dist/controller.js']) throw new Error('в паспорте нет проверенного кода Z2M');
    for (const [name, expected] of Object.entries(manifest.z2m_files)) check(path.join(app, name), expected);
    for (const [name, expected] of Object.entries(manifest.files ?? {})) {
        if (name.startsWith('bms-layer/')) check(path.join(layer, name.slice('bms-layer/'.length)), expected);
    }
    return `BMS: build=${manifest.build_version}; Z2M=${z2m.version}; herdsman=${core.version}; converters=${manifest.converters}; tree=${manifest.source_tree_sha256}; patches=${manifest.z2m_patches.join(',')}`;
}
module.exports = {verify};
if (require.main === module) {
    try { console.log(verify()); } catch (error) { console.error(`BMS: проверка сборки не пройдена: ${error.message}`); process.exitCode = 1; }
}
