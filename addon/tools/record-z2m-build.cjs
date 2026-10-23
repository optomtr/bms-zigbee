// BMS: вызывается clean-check только после успешных build + Z2M + Tuya tests.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const repo = path.resolve(__dirname, '../..');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inputs(root = repo) {
    const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json')));
    const dir = path.join(root, 'addon/bms_zigbee/z2m-patches');
    return {zigbee2mqtt: versions.zigbee2mqtt, converters: versions['zigbee-herdsman-converters'],
        core_sha256: versions['bms-core-sha256'], patches: Object.fromEntries(fs.readdirSync(dir).filter(n => n.endsWith('.patch')).sort().map(n => [n, hash(path.join(dir, n))]))};
}
function record(app) {
    const files = {};
    const walk = (dir, prefix) => {
        for (const name of fs.readdirSync(dir).sort()) {
            if (name === '.hash') continue; // upstream commit marker меняется при локальной разработке
            const file = path.join(dir, name), relative = prefix + '/' + name;
            if (fs.statSync(file).isDirectory()) walk(file, relative);
            else files[relative] = hash(file);
        }
    };
    walk(path.join(app, 'dist'), 'dist');
    if (!files['dist/controller.js']) throw new Error('BMS: отсутствует собранный Controller');
    const receipt = {inputs: inputs(), files};
    fs.mkdirSync(path.join(repo, 'addon/.work'), {recursive: true});
    fs.writeFileSync(path.join(repo, 'addon/.work/z2m-tested.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(`BMS: сохранены хеши ${Object.keys(files).length} проверенных файлов Z2M`);
}
module.exports = {inputs};
if (require.main === module) record(path.resolve(process.argv[2]));
