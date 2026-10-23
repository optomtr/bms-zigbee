// BMS: интерфейс строится по exposes устройства, а не по догадке из его имени.
export function features(device) {
	const result = [];
	const walk = (items, endpoint) => {
		for (const item of items ?? []) {
			if (item.features && !["composite", "list"].includes(item.type))
				walk(item.features, item.endpoint ?? endpoint);
			else if (item.property)
				result.push({ ...item, endpoint: item.endpoint ?? endpoint });
		}
	};
	walk(device.definition?.exposes);
	return result;
}
export function controls(device) {
	return features(device).filter(
		(f) =>
			f.access & 2 &&
			(f.type === "binary" ||
				(f.type === "numeric" &&
					Number.isFinite(f.value_min) &&
					Number.isFinite(f.value_max)) ||
				(f.type === "enum" && Array.isArray(f.values))),
	);
}
export function isRoom(group) {
	return (
		group.friendly_name?.startsWith("Комната · ") &&
		group.id >= 1000 &&
		group.id <= 1999
	);
}
export function roomName(group) {
	return isRoom(group)
		? group.friendly_name.slice("Комната · ".length)
		: group.friendly_name;
}
export function members(group, devices) {
	return (group.members ?? []).map((m) => ({
		...m,
		device: devices.find((d) => d.ieee_address === m.ieee_address),
	}));
}
export function mainState(device, state) {
	const fields = features(device).filter(
		(f) => f.type === "binary" && f.name === "state",
	);
	if (!fields.length) return null;
	const values = fields.map((f) => state?.[f.property]);
	if (values.every((v) => v === undefined)) return "unknown";
	if (fields.some((f, i) => values[i] === f.value_on)) return "on";
	if (fields.every((f, i) => values[i] === f.value_off)) return "off";
	return "unknown";
}
export function label(feature) {
	const names = {
		state: "Питание",
		brightness: "Яркость",
		color_temp: "Температура света",
		temperature: "Температура",
		humidity: "Влажность",
		battery: "Батарея",
		illuminance: "Освещённость",
		contact: "Контакт",
		occupancy: "Движение",
		linkquality: "Качество связи",
		power: "Мощность",
		energy: "Энергия",
		position: "Положение",
		child_lock: "Блокировка",
	};
	return (
		(names[feature.name] ?? feature.label ?? feature.property) +
		(feature.endpoint ? ` · ${feature.endpoint}` : "")
	);
}
export function groupSwitchable(group, devices) {
	const all = members(group, devices);
	// Групповой OnOff поддерживаем только по известным кластерам каждого endpoint.
	return (
		all.length > 0 &&
		all.every((m) => {
			const clusters = m.device?.endpoints?.[m.endpoint]?.clusters?.input ?? [];
			return clusters.includes("genOnOff") || clusters.includes(6);
		})
	);
}
export function wsURL(location, token = "") {
	const url = new URL("./api", location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	if (token) url.searchParams.set("token", token);
	return url.toString();
}
export function validName(name) {
	return (
		!!name.trim() &&
		name.length <= 100 &&
		!/[\x00-\x1f\x7f#+/]/.test(name) &&
		name !== "bridge"
	);
}
