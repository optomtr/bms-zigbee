// Состояние лежит на общем экземпляре Zigbee, а не в модуле: загрузчик внешних расширений
// импортирует временные копии файлов, но обе копии и штатный Groups получают тот же Zigbee.
export const MEMBERSHIP = Symbol.for("bms.groupMembership");

export function groupMembership(zigbee) {
    if (zigbee[MEMBERSHIP]) return zigbee[MEMBERSHIP];
    const tails = new Map();
    const known = new Map();
    const epochs = new Map();
    const active = new Set();
    const key = (ieee, endpoint) => `${ieee}/${endpoint}`;
    const runtime = {
        async withDeviceLock(ieee, fn) {
            const previous = tails.get(ieee) ?? Promise.resolve();
            const next = previous.catch(() => {}).then(async () => {
                active.add(ieee);
                try {
                    return await fn();
                } finally {
                    active.delete(ieee);
                }
            });
            tails.set(ieee, next);
            try {
                return await next;
            } finally {
                if (tails.get(ieee) === next) tails.delete(ieee);
            }
        },
        invalidate(ieee, endpoint) {
            epochs.set(ieee, (epochs.get(ieee) ?? 0) + 1);
            if (endpoint !== undefined) known.delete(key(ieee, endpoint));
            else for (const k of known.keys()) if (k.startsWith(`${ieee}/`)) known.delete(k);
        },
        // Планировщик снимет эпоху при постановке команды и проверит перед ZCL.
        // Пока операция выполняется, база ещё может отражать прежнее членство.
        getEpoch(ieee) {
            return epochs.get(ieee) ?? 0;
        },
        isChanging(ieee) {
            return active.has(ieee);
        },
        async verify(endpoint) {
            const k = key(endpoint.deviceIeeeAddress, endpoint.ID);
            known.delete(k);
            const epoch = epochs.get(endpoint.deviceIeeeAddress) ?? 0;
            // Ответ именно устройства, а не таблица zigbee-herdsman. Таймаут принадлежит
            // herdsman: освобождать блокировку по Promise.race при ещё живой команде нельзя.
            const result = await endpoint.command("genGroups", "getMembership", {groupcount: 0, grouplist: []}, {timeout: 10_000, disableDefaultResponse: true});
            if (!Array.isArray(result?.grouplist) || result.groupcount !== result.grouplist.length ||
                result.grouplist.some((id) => !Number.isInteger(id) || id < 1 || id > 0xfff7)) {
                throw new Error("Некорректный ответ genGroups.getMembership");
            }
            if ((epochs.get(endpoint.deviceIeeeAddress) ?? 0) !== epoch) {
                throw new Error("Устройство переподключилось во время проверки членства");
            }
            const groups = new Set(result.grouplist);
            known.set(k, groups);
            return groups;
        },
        isVerified(group) {
            const members = group.zh?.members ?? group.members ?? [];
            const id = group.ID ?? group.groupID ?? group.zh?.groupID;
            return members.length > 0 && members.every((e) => !active.has(e.deviceIeeeAddress) && known.get(key(e.deviceIeeeAddress, e.ID))?.has(id) === true);
        },
    };
    zigbee[MEMBERSHIP] = runtime;
    return runtime;
}
