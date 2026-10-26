// Адрес брокера показываем без учётных данных и query-параметров.
export function safeServer(value) {
	if (!value) return "Адрес не получен";
	try {
		const url = new URL(value);
		return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
	} catch {
		return "Адрес скрыт: неизвестный формат";
	}
}
// Рисуем только связи из ответа networkmap. Близость узлов и LQI не создают маршрутов.
export function mapGraph(raw) {
	if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.links))
		throw new Error("Хаб вернул неизвестный формат карты.");
	const nodes = raw.nodes
		.filter((n) => typeof n.ieeeAddr === "string")
		.slice(0, 200);
	const byAddress = new Map(
		nodes.map((n, i) => [
			n.ieeeAddr,
			{
				id: n.ieeeAddr,
				name: String(n.friendlyName ?? n.ieeeAddr),
				type: n.type,
				x:
					50 +
					Math.cos(
						(i * 2 * Math.PI) / Math.max(nodes.length, 1) - Math.PI / 2,
					) *
						35,
				y:
					50 +
					Math.sin(
						(i * 2 * Math.PI) / Math.max(nodes.length, 1) - Math.PI / 2,
					) *
						35,
			},
		]),
	);
	const address = (v) => (typeof v === "string" ? v : v?.ieeeAddr);
	return {
		nodes: [...byAddress.values()],
		links: raw.links.flatMap((l) => {
			const from = byAddress.get(address(l.source)),
				to = byAddress.get(address(l.target));
			return from && to
				? [
						{
							from,
							to,
							lqi: Number.isFinite(l.linkquality) ? l.linkquality : null,
						},
					]
				: [];
		}),
		truncated: raw.nodes.length > 200,
	};
}
