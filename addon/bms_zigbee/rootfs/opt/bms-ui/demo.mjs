// Только явно выбранный demo: фиктивные устройства никогда не отправляются в сеть.
const light = [
	{
		type: "binary",
		name: "state",
		property: "state",
		access: 7,
		value_on: "ON",
		value_off: "OFF",
	},
	{
		type: "numeric",
		name: "brightness",
		property: "brightness",
		access: 7,
		value_min: 0,
		value_max: 254,
	},
	{
		type: "numeric",
		name: "color_temp",
		property: "color_temp",
		access: 7,
		value_min: 153,
		value_max: 500,
		unit: "mired",
	},
];
const relay = [
	{
		type: "binary",
		name: "state",
		property: "state",
		access: 7,
		value_on: "ON",
		value_off: "OFF",
	},
];
const device = (i, name, model, exposes, type = "Router") => ({
	ieee_address: `0x${String(i).padStart(16, "0")}`,
	friendly_name: name,
	type,
	supported: true,
	interview_state: "SUCCESSFUL",
	definition: { model, vendor: "Tuya", description: name, exposes },
	endpoints: { 1: { clusters: { input: ["genOnOff", "genGroups"] } } },
});
export const devices = [
	device(1, "Торшер у дивана", "TS0502B", light),
	device(2, "Основной свет", "TS0502B", light),
	device(3, "Подсветка кухни", "TS0502B", light),
	device(4, "Розетка кофемашины", "TS011F", relay),
	device(
		5,
		"Климат в спальне",
		"TS0201",
		[
			{
				type: "numeric",
				name: "temperature",
				property: "temperature",
				access: 1,
				unit: "°C",
			},
			{
				type: "numeric",
				name: "humidity",
				property: "humidity",
				access: 1,
				unit: "%",
			},
			{
				type: "numeric",
				name: "battery",
				property: "battery",
				access: 1,
				unit: "%",
			},
		],
		"EndDevice",
	),
	device(6, "Прикроватный свет", "TS0502B", light),
	device(7, "Свет в прихожей", "TS0001", relay),
];
export const groups = [
	{
		id: 1000,
		friendly_name: "Комната · Гостиная",
		members: [
			{ ieee_address: devices[0].ieee_address, endpoint: 1 },
			{ ieee_address: devices[1].ieee_address, endpoint: 1 },
		],
	},
	{
		id: 1001,
		friendly_name: "Комната · Кухня",
		members: [
			{ ieee_address: devices[2].ieee_address, endpoint: 1 },
			{ ieee_address: devices[3].ieee_address, endpoint: 1 },
		],
	},
	{
		id: 5,
		friendly_name: "Вечерний свет",
		members: [
			{ ieee_address: devices[0].ieee_address, endpoint: 1 },
			{ ieee_address: devices[5].ieee_address, endpoint: 1 },
		],
	},
];
export const states = Object.fromEntries(
	devices.map((d, i) => [
		d.friendly_name,
		i === 4
			? { temperature: 23.4, humidity: 46, battery: 87, linkquality: 112 }
			: {
					state: i % 3 === 0 ? "ON" : "OFF",
					brightness: 164,
					color_temp: 320,
					linkquality: 128 - i * 9,
				},
	]),
);
export const info = {
	config: {
		mqtt: { server: "mqtt://demo-broker:1883", base_topic: "zigbee2mqtt" },
		serial: { adapter: "ember" },
		advanced: { bms_device_reports: true, transmit_power: 13 },
	},
	version: "2.14.2",
	zigbee_herdsman: { version: "10.10.0-bms.3" },
	network: { channel: 15 },
	permit_join: false,
};

// Явные фиктивные связи для демонстрации: не вычисляются по расстоянию или LQI.
export const topology = {
	nodes: [
		{
			ieeeAddr: "demo-coordinator",
			friendlyName: "Координатор",
			type: "Coordinator",
		},
		...devices.slice(0, 5).map((d) => ({
			ieeeAddr: d.ieee_address,
			friendlyName: d.friendly_name,
			type: d.type,
		})),
	],
	links: [
		{
			source: { ieeeAddr: "demo-coordinator" },
			target: { ieeeAddr: devices[0].ieee_address },
			linkquality: 180,
		},
		{
			source: { ieeeAddr: "demo-coordinator" },
			target: { ieeeAddr: devices[1].ieee_address },
			linkquality: 160,
		},
		{
			source: { ieeeAddr: devices[0].ieee_address },
			target: { ieeeAddr: devices[2].ieee_address },
			linkquality: 110,
		},
		{
			source: { ieeeAddr: devices[1].ieee_address },
			target: { ieeeAddr: devices[3].ieee_address },
			linkquality: 90,
		},
		{
			source: { ieeeAddr: devices[3].ieee_address },
			target: { ieeeAddr: devices[4].ieee_address },
			linkquality: 70,
		},
	],
};
