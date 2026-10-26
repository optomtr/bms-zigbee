// Исходные HTML/CSS и движения макетов остаются у Component; здесь только данные и дополнительные действия BMS.
import { controls, features, mainState } from "./model.mjs";
import { mapGraph, safeServer } from "./network.mjs";
const demo = new URL(location.href).searchParams.get("demo") === "1";
const baseLocation = new URL("../", location.href);
baseLocation.search = location.search;
let view,
	api,
	backend,
	preparing = false,
	graph = null,
	lastStore;
const $ = (q) => document.querySelector(q);
const extraDialog = document.createElement("dialog");
extraDialog.id = "dialog";
extraDialog.setAttribute("aria-labelledby", "dialog-title");
document.body.append(extraDialog);
const toast = document.createElement("div");
toast.id = "toast";
toast.setAttribute("role", "status");
document.body.append(toast);
function refreshExtra() {
	const section = extraDialog.dataset.bmsSection;
	if (
		!api ||
		!extraDialog.open ||
		!section ||
		extraDialog.querySelector("input:focus,select:focus,textarea:focus")
	)
		return;
	const body = extraDialog.querySelector(".dialog-body");
	if (body) {
		const top = extraDialog.scrollTop;
		body.replaceChildren(
			section === "diagnostics"
				? api.diagnostics()
				: api.groupPage(section === "rooms"),
		);
		extraDialog.scrollTop = top;
	}
}
function syncTheme() {
	const theme = view?.props.theme ?? "light";
	extraDialog.className = `root ${theme} bms-extra sheet`;
	toast.className = toast.className.replace(/\b(?:light|dark)\b/g, "").trim();
	toast.dataset.theme = theme;
	const source = $(".root:not(.bms-extra)");
	if (source) {
		for (const p of ["--accent", "--accent-fill", "--bg", "--label", "--sans"])
			extraDialog.style.setProperty(
				p,
				getComputedStyle(source).getPropertyValue(p),
			);
	}
}
function projectedDemo() {
	const hub = view?.hub(view.state.sel) ?? view?.state.hubs[0];
	const devices = (hub?.devices ?? []).map((d) => ({
		ieee_address: d.id,
		friendly_name: d.name,
		type: d.bat == null ? "Router" : "EndDevice",
		definition: {
			model: d.model,
			vendor: "Демо",
			exposes: [
				...(["light", "relay"].includes(d.type)
					? [
							{
								type: "binary",
								name: "state",
								property: "state",
								access: 7,
								value_on: "ON",
								value_off: "OFF",
							},
						]
					: []),
				...(d.type === "light"
					? [
							{
								type: "numeric",
								name: "brightness",
								property: "brightness",
								access: 7,
								value_min: 0,
								value_max: 100,
								unit: "%",
							},
						]
					: []),
				...(d.bat != null
					? [
							{
								type: "numeric",
								name: "battery",
								property: "battery",
								access: 1,
								unit: "%",
							},
						]
					: []),
			],
		},
		endpoints: { 1: { clusters: { input: ["genOnOff", "genGroups"] } } },
	}));
	const switches = devices.filter((d) =>
		controls(d).some((f) => f.name === "state"),
	);
	const groups =
		switches.length >= 2
			? [
					{
						id: 1000,
						friendly_name: "Комната · " + hub.name.replace("Хаб · ", ""),
						members: switches
							.slice(0, 2)
							.map((d) => ({ ieee_address: d.ieee_address, endpoint: 1 })),
					},
					{
						id: 5,
						friendly_name: "Освещение",
						members: switches
							.filter((d) => features(d).some((f) => f.name === "brightness"))
							.map((d) => ({ ieee_address: d.ieee_address, endpoint: 1 })),
					},
				]
			: [];
	return {
		devices,
		groups,
		states: Object.fromEntries(
			(hub?.devices ?? []).map((d) => [
				d.name,
				{
					state: d.on ? "ON" : "OFF",
					brightness: d.bri,
					battery: d.bat,
					linkquality: d.lqi,
				},
			]),
		),
		info: {
			version: "Демо",
			network: { channel: hub?.channel },
			permit_join: !!view?.state.pj,
		},
	};
}
function syncDemo(store) {
	if (preparing || !view) return;
	const hub = view.hub(view.state.sel);
	if (!hub) return;
	const next = hub.devices.map((d) => {
		const state = store.states[d.name];
		return state
			? { ...d, on: state.state === "ON", bri: state.brightness ?? d.bri }
			: d;
	});
	if (
		next.some(
			(d, i) => d.on !== hub.devices[i].on || d.bri !== hub.devices[i].bri,
		)
	)
		view.patchHub(hub.id, { devices: next });
}
function liveDevice(d, store) {
	const f = features(d),
		state = store.states[d.friendly_name] ?? {},
		brightness = f.find((v) => v.name === "brightness"),
		mode = mainState(d, state);
	const type = brightness
		? "light"
		: f.some((v) => v.name === "state")
			? "relay"
			: f.some((v) => v.name === "occupancy")
				? "motion"
				: f.some((v) => v.name === "contact")
					? "door"
					: f.some((v) => v.name === "water_leak")
						? "leak"
						: "sensor";
	const reads = f.filter(
		(v) =>
			!(v.access & 2) &&
			state[v.property] != null &&
			[
				"temperature",
				"humidity",
				"occupancy",
				"contact",
				"water_leak",
			].includes(v.name),
	);
	return {
		id: d.ieee_address,
		type,
		name: d.friendly_name,
		model: d.definition?.model ?? "Модель не определена",
		on: mode === "on",
		known: mode !== "unknown",
		lqi: state.linkquality ?? 0,
		bat: d.type === "EndDevice" ? (state.battery ?? "—") : null,
		val:
			reads.map((v) => `${state[v.property]}${v.unit ?? ""}`).join(" · ") ||
			"Нет данных",
		bri:
			brightness && Number.isFinite(state[brightness.property])
				? Math.round((100 * state[brightness.property]) / brightness.value_max)
				: 0,
		interviewing: d.interview_state === "IN_PROGRESS",
		isNew: false,
	};
}
function syncLive(store) {
	if (!view) return;
	lastStore = store;
	const config = store.info?.config;
	const hub = {
		id: "live",
		name: "Хаб · BMS Zigbee",
		driver: config?.serial?.adapter ?? "ember",
		port: config?.serial?.port ?? "—",
		topic: config?.mqtt?.base_topic ?? "—",
		channel: store.info?.network?.channel ?? "—",
		pan: store.info?.network?.pan_id ?? "—",
		enabled: store.connected && store.ready,
		status: store.connected
			? store.ready
				? "online"
				: "connecting"
			: "offline",
		isNew: false,
		opts: {
			availability: config?.availability?.enabled ?? false,
			lastSeen:
				config?.advanced?.last_seen != null &&
				config.advanced.last_seen !== "disable",
			retain: config?.advanced?.retain ?? false,
			bmsMap: false,
		},
		devices: store.devices.map((d) => liveDevice(d, store)),
	};
	view.setState(() => ({
		hubs: [hub],
		sel: "live",
		brokerNote:
			store.connected && store.ready ? "BMS на связи" : "Нет подключения",
		log: store.logs.map((l, i) => ({
			id: String(i),
			hub: "live",
			t: l.time,
			topic: "bridge/logging",
			payload: l.message,
		})),
		pj: store.info?.permit_join
			? {
					hub: "live",
					left: Math.max(
						0,
						Math.round(
							(store.info.permit_join_timeout ?? Date.now() / 1000) -
								Date.now() / 1000,
						),
					),
				}
			: null,
	}));
}
window.BMS_ORIGINAL = {
	baseLocation,
	openSection: (id) => {
		if (["rooms", "groups", "diagnostics"].includes(id)) void extra(id);
	},
	update(store) {
		if (demo) syncDemo(store);
		else syncLive(store);
		refreshExtra();
		syncTheme();
	},
};
async function ensure() {
	if (!backend) {
		window.BMS_ORIGINAL.demoData = projectedDemo();
		backend = import("./app.mjs").then((m) => (api = m));
	}
	await backend;
	return api;
}
function prepare() {
	if (!demo) return;
	preparing = true;
	const data = projectedDemo();
	Object.assign(api.store, data, {
		connected: true,
		ready: true,
		received: true,
		availability: Object.fromEntries(
			data.devices.map((d) => [d.friendly_name, "online"]),
		),
	});
	preparing = false;
}
async function extra(section) {
	await ensure();
	prepare();
	syncTheme();
	if (section === "rooms" || section === "groups")
		api.modal(
			section === "rooms" ? "Комнаты" : "Группы",
			section === "rooms"
				? "Комнаты синхронизируются с Home Assistant."
				: "Ручные группы выбранного хаба.",
			api.h(
				"div",
				{ class: "dialog-body" },
				api.groupPage(section === "rooms"),
			),
		);
	else
		api.modal(
			"Диагностика",
			"Состояние выбранного хаба.",
			api.h("div", { class: "dialog-body" }, api.diagnostics()),
		);
	extraDialog.dataset.bmsSection = section;
}
async function detail(id) {
	await ensure();
	prepare();
	const d = api.store.devices.find((d) => d.ieee_address === id);
	if (d) {
		syncTheme();
		api.deviceDetail(d);
	}
}
function listenDetails() {
	let hold,
		held = false,
		start;
	document.addEventListener("pointerdown", (e) => {
		const tile = e.target.closest("[data-bms-device]");
		if (!tile) return;
		held = false;
		start = { x: e.clientX, y: e.clientY };
		hold = setTimeout(() => {
			held = true;
			void detail(tile.dataset.bmsDevice);
		}, 450);
	});
	const cancel = () => clearTimeout(hold);
	document.addEventListener("pointermove", (e) => {
		if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12)
			cancel();
	});
	document.addEventListener("pointerup", cancel);
	document.addEventListener("pointercancel", cancel);
	document.addEventListener(
		"click",
		(e) => {
			if (held) {
				e.preventDefault();
				e.stopImmediatePropagation();
				held = false;
			}
		},
		true,
	);
	document.addEventListener("contextmenu", (e) => {
		const tile = e.target.closest("[data-bms-device]");
		if (tile) {
			e.preventDefault();
			cancel();
			void detail(tile.dataset.bmsDevice);
		}
	});
	document.addEventListener("keydown", (e) => {
		const tile = e.target.closest("[data-bms-device]");
		if (tile && e.key === "Enter" && (e.altKey || e.target === tile)) {
			e.preventDefault();
			void detail(tile.dataset.bmsDevice);
		}
	});
}
export function mount(Original, defaults, opts) {
	const originalMap = Original.prototype.mapData;
	class Connected extends Original {
		seed() {
			const seeded = super.seed();
			return demo
				? seeded
				: {
						...seeded,
						hubs: [],
						sel: "live",
						log: [],
						brokerNote: "Подключение…",
					};
		}
		componentDidMount() {
			view = this;
			window.BMS_COMPONENT = this;
			listenDetails();
			syncTheme();
			if (!demo) void ensure();
		}
		componentDidUpdate() {
			syncTheme();
		}
		componentWillUnmount() {
			super.componentWillUnmount();
		}
		renderVals() {
			const values = super.renderVals();
			const source = this.hub(this.state.sel);
			values.devices = values.devices.map((d, i) => ({
				...d,
				id: source?.devices[i]?.id,
			}));
			values.bms = {
				rooms: () => extra("rooms"),
				groups: () => extra("groups"),
				diagnostics: () => extra("diagnostics"),
				advanced: new URL("?advanced=1", baseLocation).href,
			};
			if (!demo && lastStore) {
				values.kpi.rate = lastStore.messages.filter(
					(t) => Date.now() - t < 60000,
				).length;
				values.brokerAddress = safeServer(lastStore.info?.config?.mqtt?.server);
				values.cur.clientId = lastStore.info?.config?.mqtt?.client_id ?? "—";
				values.cur.adapter = lastStore.info?.config?.serial?.adapter ?? "—";
				values.devices = values.devices.map((d, i) => {
					const raw = lastStore.devices[i],
						offline = lastStore.availability[raw?.friendly_name] === "offline";
					return {
						...d,
						disabled: d.disabled || offline,
						readout: offline
							? "Нет связи"
							: !source?.devices[i]?.known && d.isActuator
								? "Нет данных"
								: d.readout,
					};
				});
			}
			return values;
		}
		toggleDev(hid, did) {
			if (demo) return super.toggleDev(hid, did);
			const d = api?.store.devices.find((d) => d.ieee_address === did);
			if (!d) return;
			const switches = controls(d).filter((f) => f.name === "state");
			if (switches.length !== 1) {
				void detail(did);
				return;
			}
			const f = switches[0],
				on = mainState(d, api.store.states[d.friendly_name]) === "on";
			this.fire("d" + did);
			api.command(d.friendly_name, {
				[f.property]: on ? f.value_off : f.value_on,
			});
		}
		toggleHub(id) {
			if (demo) return super.toggleHub(id);
			this.showToast("Работой дополнения управляет Home Assistant.");
		}
		toggleOpt(hid, key) {
			if (demo) return super.toggleOpt?.(hid, key);
			this.showToast("Параметры доступны в расширенных настройках.");
		}
		openSheet() {
			if (demo) return super.openSheet();
			void ensure().then(() => {
				syncTheme();
				api.modal(
					"Добавить хаб",
					"Каждый координатор требует отдельного экземпляра BMS Zigbee.",
					api.h(
						"div",
						{ class: "dialog-body" },
						api.h(
							"p",
							{},
							"Установите и настройте ещё одно дополнение с отдельным топиком.",
						),
					),
				);
			});
		}
		removeHub() {
			if (demo) return super.removeHub?.();
			this.showToast("Удаление координатора доступно в настройках дополнения.");
		}
		async permitJoin() {
			if (demo) return super.permitJoin();
			await ensure();
			this.fire("pj");
			try {
				await api.request("permit_join", {
					time: api.store.info?.permit_join ? 0 : 254,
				});
				this.showToast("Запрос сопряжения принят.");
			} catch (e) {
				this.showToast(e.message);
			}
		}
		async restart() {
			if (demo) return super.restart();
			await ensure();
			syncTheme();
			api.modal(
				"Перезапустить хаб?",
				"Во время перезапуска устройства временно недоступны.",
				api.h(
					"footer",
					{ class: "dialog-footer" },
					api.h(
						"button",
						{
							type: "button",
							class: "button secondary",
							onclick: () => extraDialog.close(),
						},
						"Отмена",
					),
					api.h(
						"button",
						{
							type: "button",
							class: "button primary",
							"data-live": "",
							onclick: async (e) => {
								e.currentTarget.disabled = true;
								try {
									await api.request("restart", {});
									extraDialog.close();
									this.showToast("Перезапуск запрошен.");
								} catch (error) {
									$("#dialog-error").textContent = error.message;
								}
							},
						},
						"Перезапустить",
					),
				),
			);
		}
		async checkBroker() {
			if (demo) return super.checkBroker();
			await ensure();
			this.fire("broker");
			try {
				const result = await api.request("health_check", {});
				this.showToast(
					result.healthy ? "BMS отвечает." : "Проверка BMS требует внимания.",
				);
			} catch (e) {
				this.showToast(e.message);
			}
		}
		async scanMap() {
			if (demo) return super.scanMap();
			await ensure();
			if (this.state.scanning) return;
			this.fire("scan");
			this.setState({ scanning: true });
			try {
				const result = await api.request(
					"networkmap",
					{ type: "raw", routes: false },
					120000,
				);
				graph = mapGraph(result.value);
				this.showToast("Карта получена из таблиц соседей.");
			} catch (e) {
				this.showToast(e.message);
			} finally {
				this.setState({ scanning: false });
			}
		}
		mapData(ch, W, H, k) {
			const base = originalMap.call(this, ch, W, H, k);
			if (demo) return base;
			if (!graph)
				return {
					...base,
					links: [],
					nodes: [],
					ready: false,
					info: [{ k: "Карта", v: "Нажмите «Обновить карту»." }],
				};
			const pos = new Map(
				graph.nodes.map((n) => [
					n.id,
					n.type === "Coordinator" ? { ...n, x: 50, y: 50 } : n,
				]),
			);
			const links = graph.links.map((l, i) => {
				const a = pos.get(l.from.id),
					b = pos.get(l.to.id),
					dx = ((b.x - a.x) * W) / 100,
					dy = ((b.y - a.y) * H) / 100;
				return {
					x: a.x,
					y: a.y,
					w: (Math.hypot(dx, dy) / W) * 100,
					a: (Math.atan2(dy, dx) * 180) / Math.PI,
					q: l.lqi > 140 ? "q-good" : l.lqi >= 80 ? "q-mid" : "q-bad",
					delay: 150 + i * 90,
				};
			});
			return {
				...base,
				ready: !this.state.scanning,
				links,
				nodes: base.nodes.flatMap((n) => {
					const raw = graph.nodes.find(
						(x) => x.name === n.name && x.type !== "Coordinator",
					);
					return raw ? [{ ...n, x: raw.x, y: raw.y }] : [];
				}),
				info: [
					{ k: "Источник", v: "Таблицы соседей Zigbee" },
					{ k: "Узлов", v: String(graph.nodes.length) },
					{ k: "Связей", v: String(graph.links.length) },
					{
						k: "Ограничение",
						v: "Расположение условное; снимок не доказывает доставку каждой команды.",
					},
				],
			};
		}
	}
	window.__mountDC(Connected, { ...defaults, effects: "full" }, opts);
	// Подпись адреса в live берётся из данных; демонстрационный исходник остаётся идентичным.
	if (!demo) {
		for (const node of document.querySelectorAll("template"))
			node.innerHTML = node.innerHTML
				.replace("mqtt://10.0.0.5:1883 · Mosquitto 2.0", "{{brokerAddress}}")
				.replace("mqtt://10.0.0.5:1883", "{{brokerAddress}}")
				.replace("Mosquitto 2.0", "Не указан");
	}
}
