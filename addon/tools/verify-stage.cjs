// BMS: stage в CI не должен молча исправлять устаревшую копию, уже записанную в git.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const hash = data => createHash('sha256').update(data).digest('hex');
function files(root, prefix = '') {
    const result = {};
    for (const name of fs.readdirSync(root).sort()) {
        const file = path.join(root, name), key = prefix + name;
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`BMS: ссылка вместо файла выпуска: ${file}`);
        if (fs.statSync(file).isDirectory()) Object.assign(result, files(file, key + '/'));
        else result[key] = hash(fs.readFileSync(file));
    }
    return result;
}
function verify(root = path.resolve(__dirname, '../..')) {
    const app = path.join(root, 'addon/bms_zigbee');
    const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json')));
    const manifest = JSON.parse(fs.readFileSync(path.join(app, 'build-manifest.json')));
    const fail = message => { throw new Error(`BMS: ${message}; выполните stage.sh после проверки исходников`); };
    const source = {};
    for (const kind of ['external_converters', 'external_extensions']) {
        const directory = path.join(root, 'tuya/layer', kind);
        for (const name of fs.readdirSync(directory).filter(n => n.startsWith('bms-')).sort()) {
            const file = path.join(directory, name), key = kind + '/' + name;
            if (fs.lstatSync(file).isSymbolicLink()) fail(`символическая ссылка ${key}`);
            if (fs.statSync(file).isDirectory()) Object.assign(source, files(file, key + '/'));
            else source[key] = hash(fs.readFileSync(file));
        }
    }
    source['bms-models.example.yaml'] = hash(fs.readFileSync(path.join(root, 'tuya/layer/bms-models.example.yaml')));
    const staged = files(path.join(app, 'bms-layer'));
    for (const placeholder of ['.gitkeep', 'external_converters/.gitkeep', 'external_extensions/.gitkeep']) delete staged[placeholder];
    for (const key of new Set([...Object.keys(source), ...Object.keys(staged)])) {
        if (source[key] !== staged[key]) fail(`исходный и упакованный слой расходятся: ${key}`);
    }
    const actual = {};
    for (const directory of ['vendor', 'z2m-patches', 'bms-layer', 'rootfs']) Object.assign(actual, files(path.join(app, directory), directory + '/'));
    for (const key of new Set([...Object.keys(actual), ...Object.keys(manifest.files)])) {
        if (actual[key] !== manifest.files[key]) fail(`паспорт не соответствует файлу ${key}`);
    }
    if (hash(JSON.stringify(actual)) !== manifest.source_tree_sha256) fail('суммарный SHA паспорта неверен');
    const version = `${versions.zigbee2mqtt}-bms.${versions['bms-addon-revision']}`;
    const config = fs.readFileSync(path.join(app, 'config.yaml'), 'utf8').match(/^version:\s*["']?([^\s"']+)/m)?.[1];
    const core = `${versions['zigbee-herdsman']}-bms.${fs.readFileSync(path.join(root, 'core/BMS_REVISION'), 'utf8').trim()}`;
    if (manifest.build_version !== version || config !== version || manifest.herdsman !== core || manifest.zigbee2mqtt !== versions.zigbee2mqtt || manifest.converters !== versions['zigbee-herdsman-converters']) fail('версии композиции расходятся');
    if (actual['vendor/zigbee-herdsman.tgz'] !== versions['bms-core-sha256'] || manifest.vendor_sha256 !== versions['bms-core-sha256']) fail('vendor SHA отличается от закреплённого');
    const required = Object.keys(source).filter(key => /^external_extensions\/bms-[^/]+\.(mjs|cjs|js)$/.test(key)).map(key => path.basename(key)).sort();
    if (JSON.stringify(required) !== JSON.stringify(manifest.required_extensions)) fail('список обязательных расширений неверен');
    if (!manifest.z2m_files?.['dist/controller.js'] || JSON.stringify(manifest.z2m_verified_inputs) !== JSON.stringify(require('./record-z2m-build.cjs').inputs(root))) fail('патчи/версии изменились после проверки сборки Z2M');
    return `BMS: исходники, stage и паспорт ${version} совпадают`;
}
module.exports = {verify};
if (require.main === module) { try { console.log(verify()); } catch (error) { console.error(error.message); process.exitCode = 1; } }
