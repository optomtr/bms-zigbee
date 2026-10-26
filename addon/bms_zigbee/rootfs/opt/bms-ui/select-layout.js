// Сохраняем два исходных макета, вместо повторной вёрстки «по мотивам».
const layout = matchMedia("(max-width: 600px)").matches ? "iphone" : "desktop";
location.replace(
	new URL(
		`./bms-ui/${layout}.html${location.search}${location.hash}`,
		location.href,
	),
);
