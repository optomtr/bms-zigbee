import {
	controls,
	features,
	groupSwitchable,
	isRoom,
	label,
	members,
	roomName,
	validName,
	wsURL,
} from "./model.mjs";

const $ = (q, root = document) => root.querySelector(q);
const original = window.BMS_ORIGINAL;
const baseLocation = original?.baseLocation ?? location;
const h = (tag, attrs = {}, ...children) => {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
		else if (key === "class") el.className = value;
		else if (
			(key.startsWith("data-") || key.startsWith("aria-")) &&
			value != null
		)
			el.setAttribute(key, String(value));
		else if (value !== false && value != null)
			el.setAttribute(key, value === true ? "" : value);
	}
	for (const child of children.flat(Infinity))
		if (child != null)
			el.append(
				child instanceof Node ? child : document.createTextNode(String(child)),
			);
	return el;
};
const paths = {
	hub: "M9 8V4h6v4M7 8h10v13H7zM10 13h4M10 17h4",
	server: "M3 4h18v7H3zM3 14h18v7H3zM7 7.5h.01M7 17.5h.01",
	list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
	back: "m15 4-8 8 8 8",
	refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
	home: "M3 11 12 3l9 8M5 10v11h14V10M9 21v-7h6v7",
	devices: "M8 3h8v18H8zM11 17h2M3 8h2v10H3M19 6h2v12h-2",
	rooms: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
	groups: "M8 8h8v8H8zM3 3h4v4H3zM17 3h4v4h-4zM3 17h4v4H3zM17 17h4v4h-4z",
	pulse: "M2 12h5l3-8 4 16 3-8h5",
	plus: "M12 5v14M5 12h14",
	arrow: "M5 12h14m-5-5 5 5-5 5",
	search: "M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
	bulb: "M9 18h6M10 22h4M8 14a6 6 0 1 1 8 0l-1 2H9z",
	power: "M12 2v10M6 5a9 9 0 1 0 12 0",
	sensor: "M10 4a2 2 0 0 1 4 0v10a4 4 0 1 1-4 0z",
	signal: "M3 18v3M9 13v8M15 8v13M21 3v18",
	check: "m5 12 4 4L19 6",
	close: "m6 6 12 12M6 18 18 6",
	settings:
		"M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
	down: "M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4",
	help: "M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 4M12 18v1",
};
function icon(name) {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	for (const [k, v] of Object.entries({
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": "1.6",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
		"aria-hidden": "true",
	}))
		svg.setAttribute(k, v);
	const p = document.createElementNS(svg.namespaceURI, "path");
	p.setAttribute("d", paths[name] ?? paths.devices);
	svg.append(p);
	return svg;
}
const demo = new URL(location.href).searchParams.get("demo") === "1";
const store = {
	devices: [],
	groups: [],
	states: Object.create(null),
	availability: Object.create(null),
	info: null,
	extensions: null,
	connected: false,
	ready: false,
	received: false,
	traffic: Object.create(null),
	logs: [],
	counters: null,
	map: null,
	mapAt: null,
	mapError: "",
	mapBusy: false,
	messages: [],
	selfCheck: null,
};
let socket,
	retry,
	token = new URL(location.href).searchParams.get("token") ?? "",
	toastTimer,
	renderTimer;
const pending = new Map();
const dialog = $("#dialog");
let lastFocus;
dialog.addEventListener("close", () => {
	if (lastFocus?.isConnected) lastFocus.focus();
	else $(".nav-link.active")?.focus();
});
const friendlyError = () =>
	"Не удалось выполнить запрос. Проверьте связь и состояние устройства в диагностике.";
function toast(text, error = false) {
	const el = $("#toast");
	el.textContent = text;
	el.className = error ? "visible error" : "visible";
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (el.className = ""), 5500);
}
function button(text, action, cls = "button secondary", extra = {}) {
	return h(
		"button",
		{ type: "button", class: cls, onclick: action, ...extra },
		text,
	);
}
function channelCount(n) {
	const x = n % 100;
	return `${n} ${x >= 11 && x <= 14 ? "каналов" : n % 10 === 1 ? "канал" : n % 10 >= 2 && n % 10 <= 4 ? "канала" : "каналов"}`;
}
function tag(text, color = "neutral") {
	return h("span", { class: `tag ${color}` }, text);
}
function online() {
	return store.connected && store.ready;
}
function unavailable(d) {
	return store.availability[d.friendly_name] === "offline";
}
function send(topic, payload) {
	if (!online())
		throw new Error("Нет связи с BMS Zigbee. Команда не отправлена.");
	if (demo) return;
	if (socket?.readyState !== WebSocket.OPEN)
		throw new Error("Нет соединения. Команда не отправлена.");
	socket.send(JSON.stringify({ topic, payload }));
}
function command(entity, payload) {
	try {
		if (store.availability[entity] === "offline")
			throw new Error("Устройство без связи. Команда не отправлена.");
		send(`${entity}/set`, payload);
		if (demo) {
			store.states[entity] = { ...store.states[entity], ...payload };
			render();
		}
		toast(
			demo
				? "Демо: состояние изменено только в примере"
				: "Команда отправлена. Состояние обновится по данным Z2M.",
		);
	} catch (error) {
		toast(error.message, true);
	}
}
function request(action, payload, timeout = 15000) {
	if (demo)
		return Promise.reject(
			new Error(
				"В демо можно управлять примерами. Настройка доступна после подключения к вашему BMS.",
			),
		);
	return new Promise((resolve, reject) => {
		const transaction = `bms-ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const timer = setTimeout(() => {
			pending.delete(transaction);
			reject(
				new Error(
					`Нет ответа за ${timeout / 1000} секунд. Проверьте результат перед повторной попыткой.`,
				),
			);
		}, timeout);
		pending.set(transaction, { resolve, reject, timer, action });
		try {
			send(`bridge/request/${action}`, { ...payload, transaction });
		} catch (error) {
			clearTimeout(timer);
			pending.delete(transaction);
			reject(error);
		}
	});
}
async function perform(action, payload, control, success) {
	control.disabled = true;
	control.dataset.busy = "true";
	try {
		await request(action, payload);
		dialog.close();
		toast(success);
	} catch (error) {
		if (dialog.open && $("#dialog-error"))
			$("#dialog-error").textContent = error.message;
		toast(error.message, true);
	} finally {
		delete control.dataset.busy;
		control.disabled = !online();
	}
}
function modal(title, sub, ...body) {
	lastFocus = document.activeElement;
	dialog.replaceChildren(
		h(
			"header",
			{ class: "dialog-head" },
			h("div", {}, h("h2", { id: "dialog-title" }, title), h("p", {}, sub)),
			button(icon("close"), () => dialog.close(), "icon-button", {
				"aria-label": "Закрыть",
			}),
		),
		...body,
		h("p", { id: "dialog-error", class: "dialog-error", role: "alert" }),
	);
	if (!dialog.open) dialog.showModal();
}
function sectionTitle(title, sub, action) {
	return h(
		"div",
		{ class: "section-title" },
		h("div", {}, h("h2", {}, title), sub ? h("p", {}, sub) : null),
		action,
	);
}
function blank(title, text, action) {
	return h(
		"div",
		{ class: "empty" },
		h("span", { class: "empty-icon" }, icon("devices")),
		h("h2", {}, title),
		h("p", {}, text),
		action,
	);
}
function scheduleRender() {
	clearTimeout(renderTimer);
	renderTimer = setTimeout(render, 150);
}
function render() {
	original?.update(store);
	for (const control of document.querySelectorAll("[data-live]")) {
		const off = control.dataset.device
			? store.availability[control.dataset.device] === "offline"
			: control.dataset.offline === "true";
		control.disabled = !online() || off || control.dataset.busy === "true";
	}
}

function heading(kicker, title, text, action) {
	return h(
		"div",
		{ class: "page-heading" },
		h(
			"div",
			{},
			h("span", { class: "eyebrow" }, kicker),
			h("h1", {}, title),
			h("p", {}, text),
		),
		action,
	);
}
function networkCard() {
	const state = store.extensions?.status;
	return h(
		"section",
		{ class: "network-card" },
		h(
			"div",
			{ class: "network-heading" },
			h("span", { class: "orbit" }, icon("pulse")),
			tag(
				online() ? "Подключено" : "Нет связи",
				online() ? "green" : "neutral",
			),
		),
		h("h2", {}, "Состояние системы"),
		h("p", {}, "Понятно, что происходит"),
		h(
			"dl",
			{},
			h(
				"div",
				{},
				h("dt", {}, "Zigbee2MQTT"),
				h("dd", {}, store.info?.version ?? "Нет данных"),
			),
			h(
				"div",
				{},
				h("dt", {}, "Расширения BMS"),
				h(
					"dd",
					{},
					state === "ready"
						? "Запущены"
						: state === "degraded"
							? "Требуют внимания"
							: state === "loading"
								? "Запускаются"
								: "Нет данных",
				),
			),
			h(
				"div",
				{},
				h("dt", {}, "Канал сети"),
				h("dd", {}, store.info?.network?.channel ?? "Нет данных"),
			),
		),
		h(
			"p",
			{ class: "fine-print" },
			"Связь с интерфейсом не подтверждает доставку команд устройствам.",
		),
		button(
			["Открыть диагностику", icon("arrow")],
			() => (location.hash = "diagnostics"),
			"button dark",
		),
	);
}
function roomCard(g) {
	return h(
		"article",
		{ class: "room-card" },
		h(
			"div",
			{ class: "room-top" },
			h("span", { class: "room-symbol" }, icon("home")),
			h("span", { class: "room-count" }, channelCount(g.members?.length ?? 0)),
		),
		button(roomName(g), () => groupDetail(g), "room-title"),
		h(
			"p",
			{},
			isRoom(g) ? "Синхронизация с Home Assistant" : "Ваша группа устройств",
		),
		h(
			"div",
			{ class: "room-footer" },
			button(["Открыть", icon("arrow")], () => groupDetail(g), "text-button"),
			groupSwitchable(g, store.devices)
				? button(icon("power"), () => groupDetail(g), "room-power", {
						"aria-label": `Управление ${roomName(g)}`,
					})
				: null,
		),
	);
}
function groupPage(rooms) {
	const groups = store.groups.filter((g) => isRoom(g) === rooms);
	return h(
		"div",
		{},
		heading(
			rooms ? "КОМНАТЫ" : "ГРУППЫ",
			rooms ? "Комнаты" : "Группы",
			rooms
				? "Комнаты из Home Assistant. Их состав обновляется автоматически."
				: "Объедините свет и реле для одного общего действия.",
			!rooms
				? button(
						[icon("plus"), "Создать группу"],
						createGroup,
						"button primary",
						{ "data-live": "" },
					)
				: null,
		),
		groups.length
			? h("div", { class: "room-grid large" }, groups.map(roomCard))
			: blank(
					rooms ? "Комнат пока нет" : "Создайте первую группу",
					rooms
						? "Назначьте область устройствам в Home Assistant. Для автоматической группы нужны как минимум два устройства."
						: "Например, «Вечерний свет» для торшера и прикроватной лампы.",
					!rooms
						? button("Создать группу", createGroup, "button primary", {
								"data-live": "",
							})
						: null,
				),
	);
}
function deviceDetail(d) {
	const values = store.states[d.friendly_name] ?? {};
	const fieldset = h(
		"fieldset",
		{
			"data-live": "",
			"data-offline": unavailable(d),
			"data-device": d.friendly_name,
			disabled: !online() || unavailable(d),
		},
		controls(d).map((f) => {
			const id = `control-${f.property}`,
				current = values[f.property];
			let control;
			if (f.type === "binary")
				control = h(
					"select",
					{
						id,
						onchange: (e) =>
							command(d.friendly_name, {
								[f.property]:
									e.target.value === "on" ? f.value_on : f.value_off,
							}),
					},
					h(
						"option",
						{
							value: "unknown",
							disabled: true,
							selected: current !== f.value_on && current !== f.value_off,
						},
						"Нет данных",
					),
					h(
						"option",
						{ value: "off", selected: current === f.value_off },
						String(f.value_off) === "OFF" ? "Выключено" : String(f.value_off),
					),
					h(
						"option",
						{ value: "on", selected: current === f.value_on },
						String(f.value_on) === "ON" ? "Включено" : String(f.value_on),
					),
				);
			else if (f.type === "numeric") {
				const output = h("output", {}, current ?? "—");
				control = h(
					"div",
					{ class: "range-wrap" },
					h("input", {
						id,
						type: "range",
						min: f.value_min,
						max: f.value_max,
						step: f.value_step ?? 1,
						value: current ?? f.value_min,
						oninput: (e) => {
							output.textContent = e.target.value;
							e.target.style.setProperty(
								"--level",
								`${(100 * (Number(e.target.value) - f.value_min)) / (f.value_max - f.value_min)}%`,
							);
						},
						style: `--level:${(100 * ((current ?? f.value_min) - f.value_min)) / (f.value_max - f.value_min)}%`,
						onchange: (e) =>
							command(d.friendly_name, {
								[f.property]: Number(e.target.value),
							}),
					}),
					output,
					h("span", {}, f.unit ?? ""),
				);
			} else
				control = h(
					"select",
					{
						id,
						onchange: (e) =>
							command(d.friendly_name, {
								[f.property]: f.values[e.target.selectedIndex - 1],
							}),
					},
					h(
						"option",
						{ disabled: true, selected: !f.values.includes(current) },
						"Выберите значение",
					),
					f.values.map((v) => h("option", { selected: v === current }, v)),
				);
			return h(
				"div",
				{ class: "control-row" },
				h("label", { for: id }, label(f)),
				control,
			);
		}),
	);
	const readonly = features(d).filter(
		(f) => values[f.property] != null && !(f.access & 2),
	);
	modal(
		d.friendly_name,
		`${d.definition?.vendor ?? "Производитель не указан"} · ${d.definition?.model ?? "Модель не определена"}`,
		h(
			"div",
			{ class: "dialog-body" },
			unavailable(d)
				? h(
						"p",
						{ class: "notice warning" },
						"Устройство без связи. Управление недоступно.",
					)
				: null,
			controls(d).length
				? fieldset
				: h(
						"p",
						{ class: "muted" },
						"Для этого устройства нет доступных элементов управления.",
					),
			readonly.length
				? h(
						"dl",
						{ class: "readings" },
						readonly.map((f) =>
							h(
								"div",
								{},
								h("dt", {}, label(f)),
								h("dd", {}, `${values[f.property]} ${f.unit ?? ""}`),
							),
						),
					)
				: null,
			h(
				"p",
				{ class: "fine-print" },
				"Значения показаны по данным Z2M и могут быть сохранёнными. Отправка команды не подтверждает её физическое исполнение.",
			),
			h(
				"details",
				{},
				h("summary", {}, "Информация об устройстве"),
				h("p", { class: "mono" }, d.ieee_address),
				h("p", {}, `Последнее LQI: ${values.linkquality ?? "нет данных"}`),
			),
		),
		h(
			"footer",
			{ class: "dialog-footer" },
			button("Переименовать", () => renameDevice(d), "button secondary", {
				"data-live": "",
				disabled: !online(),
			}),
			button("Готово", () => dialog.close(), "button primary"),
		),
	);
}
function nameModal(title, sub, value, action, payload) {
	const input = h("input", {
			id: "new-name",
			value,
			maxlength: 100,
			required: true,
			autocomplete: "off",
		}),
		error = h("p", { class: "form-error", role: "alert" });
	const submit = button("Сохранить", () => {}, "button primary", {
		"data-live": "",
		disabled: !online(),
	});
	const form = h(
		"form",
		{
			onsubmit: (e) => {
				e.preventDefault();
				const name = input.value.trim();
				if (!validName(name)) {
					error.textContent = "Укажите название без /, + и #, до 100 символов.";
					return;
				}
				perform(action, payload(name), submit, "Изменения сохранены.");
			},
		},
		h(
			"div",
			{ class: "dialog-body" },
			h("label", { for: "new-name" }, "Название"),
			input,
			error,
		),
		h(
			"footer",
			{ class: "dialog-footer" },
			button("Отмена", () => dialog.close(), "button secondary"),
			submit,
		),
	);
	submit.type = "submit";
	modal(title, sub, form);
}
function renameDevice(d) {
	nameModal(
		"Понятное название",
		"Например, «Торшер у дивана».",
		d.friendly_name,
		"device/rename",
		(name) => ({ from: d.ieee_address, to: name }),
	);
}
function createGroup() {
	nameModal(
		"Новая группа",
		"Сначала назовите группу, затем добавьте устройства.",
		"",
		"group/add",
		(name) => ({ friendly_name: name }),
	);
}
function groupDetail(g) {
	const automatic = isRoom(g);
	const canSwitch = groupSwitchable(g, store.devices);
	const memberList = h(
		"div",
		{ class: "member-list" },
		members(g, store.devices).map((m) =>
			h(
				"div",
				{ class: "member-row" },
				h("span", { class: "device-icon" }, icon("devices")),
				h(
					"div",
					{},
					h("strong", {}, m.device?.friendly_name ?? m.ieee_address),
					h("small", {}, `Канал ${m.endpoint}`),
				),
				!automatic
					? button(
							"Убрать",
							(e) =>
								perform(
									"group/members/remove",
									{
										group: String(g.id),
										device: m.ieee_address,
										endpoint: m.endpoint,
									},
									e.currentTarget,
									"Канал удалён из группы.",
								),
							"text-button",
							{ "data-live": "", disabled: !online() },
						)
					: null,
			),
		),
	);
	modal(
		roomName(g),
		automatic
			? "Состав управляется через комнаты Home Assistant."
			: `${channelCount(g.members?.length ?? 0)} в группе`,
		h(
			"div",
			{ class: "dialog-body" },
			canSwitch
				? h(
						"div",
						{ class: "group-actions" },
						button(
							[icon("power"), "Включить всё"],
							() => command(String(g.id), { state: "ON" }),
							"button primary",
							{ "data-live": "", disabled: !online() },
						),
						button(
							"Выключить всё",
							() => command(String(g.id), { state: "OFF" }),
							"button secondary",
							{ "data-live": "", disabled: !online() },
						),
					)
				: h(
						"p",
						{ class: "notice" },
						"Общее включение недоступно: не у всех каналов известна поддержка On/Off. Откройте отдельное устройство.",
					),
			memberList,
			!automatic
				? h(
						"details",
						{ class: "group-edit" },
						h("summary", {}, "Настройка группы"),
						button(
							"Переименовать группу",
							() =>
								nameModal(
									"Название группы",
									"Устройства и их состояния сохранятся.",
									g.friendly_name,
									"group/rename",
									(name) => ({ from: g.friendly_name, to: name }),
								),
							"text-button",
							{ "data-live": "", disabled: !online() },
						),
						button(
							"Удалить группу",
							() => removeGroup(g),
							"text-button danger",
							{ "data-live": "", disabled: !online() },
						),
					)
				: null,
			h(
				"p",
				{ class: "fine-print" },
				"Групповые команды не подтверждают исполнение каждым участником.",
			),
		),
		h(
			"footer",
			{ class: "dialog-footer" },
			!automatic
				? button(
						[icon("plus"), "Добавить канал"],
						() => addMember(g),
						"button secondary",
						{ "data-live": "", disabled: !online() },
					)
				: null,
			button("Готово", () => dialog.close(), "button primary"),
		),
	);
}
function removeGroup(g) {
	modal(
		"Удалить группу?",
		g.friendly_name,
		h(
			"div",
			{ class: "dialog-body" },
			h(
				"p",
				{},
				"Группа будет удалена. Её устройства останутся в вашей Zigbee-сети.",
			),
		),
		h(
			"footer",
			{ class: "dialog-footer" },
			button("Отмена", () => groupDetail(g), "button secondary"),
			button(
				"Удалить группу",
				(e) =>
					perform(
						"group/remove",
						{ id: String(g.id), force: false },
						e.currentTarget,
						"Группа удалена.",
					),
				"button danger",
				{ "data-live": "", disabled: !online() },
			),
		),
	);
}
function addMember(g) {
	const candidates = [];
	for (const d of store.devices)
		for (const [endpoint, details] of Object.entries(d.endpoints ?? {}))
			if (
				(details.clusters?.input ?? []).some(
					(c) => c === "genGroups" || c === 4,
				) &&
				!(g.members ?? []).some(
					(m) =>
						m.ieee_address === d.ieee_address &&
						Number(m.endpoint) === Number(endpoint),
				)
			)
				candidates.push({ d, endpoint: Number(endpoint) });
	const select = h(
		"select",
		{ id: "member-select" },
		candidates.map((m, i) =>
			h("option", { value: i }, `${m.d.friendly_name} · канал ${m.endpoint}`),
		),
	);
	const submit = button(
		"Добавить",
		(e) => {
			const m = candidates[Number(select.value)];
			if (m)
				perform(
					"group/members/add",
					{
						group: String(g.id),
						device: m.d.ieee_address,
						endpoint: m.endpoint,
					},
					e.currentTarget,
					"Канал добавлен и проверен.",
				);
		},
		"button primary",
		{ "data-live": "", disabled: !online() || !candidates.length },
	);
	modal(
		"Добавить в группу",
		g.friendly_name,
		h(
			"div",
			{ class: "dialog-body" },
			candidates.length
				? h("label", { for: "member-select" }, "Устройство и канал")
				: h("p", {}, "Нет доступных каналов с поддержкой групп."),
			candidates.length ? select : null,
		),
		h(
			"footer",
			{ class: "dialog-footer" },
			button("Назад", () => groupDetail(g), "button secondary"),
			submit,
		),
	);
}
function pairing() {
	modal(
		"Подключить устройство",
		"Откроем сеть на 60 секунд.",
		h(
			"div",
			{ class: "dialog-body" },
			h(
				"ol",
				{ class: "steps" },
				h(
					"li",
					{},
					"Поднесите устройство к месту первоначального подключения.",
				),
				h(
					"li",
					{},
					"Переведите его в режим сопряжения по инструкции производителя.",
				),
				h(
					"li",
					{},
					"Откройте подключение и дождитесь появления устройства в списке.",
				),
			),
			h(
				"p",
				{ class: "fine-print" },
				store.info?.permit_join
					? "Подключение уже открыто. Можно закрыть его сейчас."
					: "К сети смогут присоединяться устройства в режиме сопряжения.",
			),
		),
		h(
			"footer",
			{ class: "dialog-footer" },
			button("Отмена", () => dialog.close(), "button secondary"),
			button(
				store.info?.permit_join
					? "Закрыть подключение"
					: "Открыть на 60 секунд",
				(e) =>
					perform(
						"permit_join",
						{ time: store.info?.permit_join ? 0 : 60 },
						e.currentTarget,
						"Настройка подключения обновлена.",
					),
				"button primary",
				{ "data-live": "", disabled: !online() },
			),
		),
	);
}
function selfCheckPanel() {
	const result = store.selfCheck;
	return h(
		"section",
		{ class: "panel" },
		h("h2", {}, "Самопроверка после обновления"),
		result
			? dataRows([
					["Ответили", `${result.ok} из ${result.total}`],
					["Версия", result.version],
					["Когда", result.at],
					["Средний ответ", `${result.avgMs ?? 0} мс`],
					["Максимальный ответ", `${result.maxMs ?? 0} мс`],
					[
						"Не ответили",
						Array.isArray(result.failed)
							? result.failed.join(", ") || "Нет"
							: "Нет данных",
					],
				])
			: h(
					"p",
					{ class: "fine-print" },
					"Результат ещё не получен. Проверка выполняется дополнением после обновления.",
				),
		h(
			"p",
			{ class: "fine-print" },
			"Проверяется чтение атрибута у устройств с питанием от сети. Спящие батарейные устройства не входят в результат. Это результат на указанное время.",
		),
	);
}

function diagnostics() {
	const status = store.extensions?.status;
	const report = () => ({
		schema: 1,
		created_at: new Date().toISOString(),
		z2m: store.info?.version,
		herdsman: store.info?.zigbee_herdsman?.version,
		channel: store.info?.network?.channel,
		extensions: store.extensions?.status,
		observed_api_events: store.traffic,
		last_counters: store.counters,
		last_self_check: store.selfCheck,
		limits:
			"Счётчики относятся к последним полученным выборкам; UI-state не подтверждает физическое исполнение.",
	});
	return h(
		"div",
		{},
		heading(
			"ДИАГНОСТИКА",
			"Диагностика",
			"Подключение, счётчики и события выбранного хаба.",
			button(
				[icon("down"), "Скачать сводку"],
				() => {
					const url = URL.createObjectURL(
						new Blob([JSON.stringify(report(), null, 2)], {
							type: "application/json",
						}),
					);
					const a = h("a", { href: url, download: "bms-diagnostics.json" });
					a.click();
					setTimeout(() => URL.revokeObjectURL(url), 1000);
				},
				"button secondary",
			),
		),
		h(
			"div",
			{ class: "diagnostic-grid" },
			networkCard(),
			selfCheckPanel(),
			h(
				"section",
				{ class: "panel" },
				h("h2", {}, "На что обратить внимание"),
				h(
					"div",
					{ class: "diagnostic-item" },
					icon(online() ? "check" : "signal"),
					h(
						"div",
						{},
						h(
							"strong",
							{},
							online() ? "Интерфейс подключён" : "Нет подключения",
						),
						h(
							"p",
							{},
							online()
								? "Данные поступают от BMS Zigbee."
								: "Проверьте, запущено ли дополнение, и подключитесь заново.",
						),
					),
				),
				h(
					"div",
					{ class: "diagnostic-item" },
					icon(status === "ready" ? "check" : "settings"),
					h(
						"div",
						{},
						h(
							"strong",
							{},
							status === "ready"
								? "Расширения запущены"
								: status === "degraded"
									? "Ошибка загрузки расширений"
									: "Нет статуса расширений",
						),
						h(
							"p",
							{},
							status === "ready"
								? "Процедуры запуска завершились. Доступность Home Assistant проверяется отдельно."
								: "Проверьте журнал дополнения и версию установленного пакета.",
						),
					),
				),
				h(
					"div",
					{ class: "diagnostic-item" },
					icon("pulse"),
					h(
						"div",
						{},
						h(
							"strong",
							{},
							store.counters
								? "Получены счётчики NCP"
								: "Для вывода о радио нужны данные",
						),
						h(
							"p",
							{},
							store.counters
								? `В последней выборке CCA-отказов: ${store.counters.cca}; ошибок MAC: ${store.counters.mac_failed}. Это признаки для проверки, не установленная причина.`
								: "Штатные счётчики приходят раз в час. Отсутствие ошибок в коротком журнале не доказывает исправность сети.",
						),
					),
				),
			),
		),
		h(
			"section",
			{ class: "panel" },
			sectionTitle(
				"Наблюдения этой вкладки",
				"С момента её открытия. Не являются числом исполненных команд.",
			),
			h(
				"div",
				{ class: "event-metrics" },
				[
					["mqtt_intent", "Намерений MQTT"],
					["group_frame", "Групповых API-вызовов"],
					["unicast_frame", "Одноадресных API-вызовов"],
					["device_report", "Отчётов устройств"],
				].map(([key, title]) =>
					h(
						"div",
						{},
						h("strong", {}, store.traffic[key] ?? 0),
						h("span", {}, title),
					),
				),
			),
		),
		h(
			"a",
			{
				href: new URL("?advanced=1", baseLocation.href).href,
				class: "button secondary advanced-access",
			},
			icon("settings"),
			"Расширенные настройки",
		),
		h(
			"section",
			{ class: "panel log-panel" },
			sectionTitle(
				"Последние сообщения",
				"Ошибки и предупреждения, полученные этой вкладкой.",
			),
			store.logs.length
				? h(
						"ol",
						{},
						store.logs.map((row) =>
							h("li", {}, h("time", {}, row.time), h("span", {}, row.message)),
						),
					)
				: h(
						"p",
						{ class: "muted" },
						"Пока нет сообщений. Это не означает, что ошибок не было до открытия вкладки.",
					),
		),
	);
}
function dataRows(rows) {
	return h(
		"dl",
		{ class: "readings" },
		rows.map(([name, value]) =>
			h("div", {}, h("dt", {}, name), h("dd", {}, value ?? "Нет данных")),
		),
	);
}
function auth() {
	const input = h("input", {
		type: "password",
		id: "auth-token",
		autocomplete: "off",
		placeholder: "Токен веб-интерфейса",
	});
	modal(
		"Подключиться к BMS",
		"Если включена авторизация, введите frontend auth token.",
		h(
			"form",
			{
				onsubmit: (e) => {
					e.preventDefault();
					token = input.value;
					dialog.close();
					connect();
				},
			},
			h(
				"div",
				{ class: "dialog-body" },
				h("label", { for: "auth-token" }, "Токен доступа"),
				input,
				h(
					"p",
					{ class: "fine-print" },
					"Токен хранится только в памяти этой вкладки.",
				),
			),
			h(
				"footer",
				{ class: "dialog-footer" },
				h(
					"button",
					{ type: "submit", class: "button primary" },
					"Подключиться",
				),
			),
		),
	);
}
function receive({ topic, payload }) {
	store.messages.push(Date.now());
	store.messages = store.messages
		.filter((t) => Date.now() - t < 60000)
		.slice(-10000);
	if (topic.startsWith("bridge/response/")) {
		const item = pending.get(payload?.transaction);
		if (item && topic === `bridge/response/${item.action}`) {
			clearTimeout(item.timer);
			pending.delete(payload.transaction);
			payload.status === "ok"
				? item.resolve(payload.data)
				: item.reject(new Error(friendlyError()));
		}
		return;
	}
	if (topic === "bridge/info") {
		store.info = payload;
	} else if (topic === "bridge/state") {
		store.ready =
			(typeof payload === "string" ? payload : payload?.state) === "online";
	} else if (topic === "bridge/devices" && Array.isArray(payload)) {
		store.devices = payload.filter((d) => d.type !== "Coordinator");
		store.received = true;
	} else if (topic === "bridge/groups" && Array.isArray(payload))
		store.groups = payload;
	else if (topic === "bridge/bms/extensions") store.extensions = payload;
	else if (
		topic === "bms/self_check" &&
		Number.isInteger(payload?.total) &&
		Number.isInteger(payload?.ok)
	)
		store.selfCheck = payload;
	else if (
		topic === "bridge/bms/tx_event" &&
		payload.schema === 1 &&
		["mqtt_intent", "group_frame", "unicast_frame"].includes(payload.kind)
	)
		store.traffic[payload.kind] = (store.traffic[payload.kind] ?? 0) + 1;
	else if (topic === "bridge/bms/device_report" && payload.schema === 1)
		store.traffic.device_report = (store.traffic.device_report ?? 0) + 1;
	else if (topic === "bridge/logging") {
		if (["error", "warning"].includes(payload.level)) {
			store.logs.unshift({
				time: new Date().toLocaleTimeString("ru-RU"),
				message: String(payload.message).slice(0, 1500),
			});
			store.logs.length = Math.min(store.logs.length, 50);
		}
		const match = String(payload.message).match(/\[NCP COUNTERS\]\s*([\d,]+)$/);
		if (
			match &&
			["10.10.0", "10.10.0-bms.3"].includes(
				store.info?.zigbee_herdsman?.version,
			)
		) {
			const v = match[1].split(",").map(Number);
			if (
				v.length === 42 &&
				v.every((n) => Number.isInteger(n) && n >= 0 && n <= 65535)
			)
				store.counters = {
					received_at: new Date().toISOString(),
					cca: v[32],
					mac_failed: v[5],
					aps_failed: v[11],
					saturated: v.includes(65535),
				};
		}
	} else if (topic.endsWith("/availability"))
		store.availability[topic.slice(0, -13)] =
			typeof payload === "string" ? payload : payload?.state;
	else if (store.devices.some((d) => d.friendly_name === topic))
		store.states[topic] = payload;
	scheduleRender();
}
function connect() {
	if (demo) return;
	clearTimeout(retry);
	if (socket) {
		socket.onclose = null;
		socket.close();
	}
	store.connected = false;
	store.ready = false;
	render();
	socket = new WebSocket(wsURL(baseLocation, token));
	socket.onopen = () => {
		store.connected = true;
		render();
	};
	socket.onmessage = (e) => {
		try {
			const data = JSON.parse(e.data);
			if (typeof data.topic === "string") receive(data);
		} catch {
			toast("Получено некорректное сообщение от сервера.", true);
		}
	};
	socket.onclose = (e) => {
		store.connected = false;
		store.ready = false;
		for (const item of pending.values()) {
			clearTimeout(item.timer);
			item.reject(
				new Error("Соединение прервано. Проверьте результат перед повтором."),
			);
		}
		pending.clear();
		render();
		if (e.code === 4401) {
			toast("Требуется действующий токен доступа.", true);
			auth();
		} else retry = setTimeout(connect, 5000);
	};
	socket.onerror = () => {};
}
window.addEventListener("hashchange", () =>
	original?.openSection?.(location.hash.slice(1)),
);
setInterval(scheduleRender, 10000);
if (demo) {
	const sample = original?.demoData ?? (await import("./demo.mjs"));
	Object.assign(store, {
		devices: sample.devices,
		groups: sample.groups,
		states: sample.states,
		info: sample.info,
		connected: true,
		ready: true,
		received: true,
		extensions: { status: "ready" },
		availability: Object.fromEntries(
			sample.devices.map((d) => [d.friendly_name, "online"]),
		),
	});
	store.availability["Свет в прихожей"] = "offline";
	render();
} else {
	render();
	connect();
}

export {
	store,
	command,
	request,
	pairing,
	deviceDetail,
	groupDetail,
	groupPage,
	diagnostics,
	auth,
	modal,
	h,
	render,
	connect,
};
