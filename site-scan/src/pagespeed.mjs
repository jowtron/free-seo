// Lighthouse via Google's PageSpeed Insights API: Google runs Lighthouse on its
// own machines and returns the full report, so this box only collates. About
// 10-30 s a page, several at once, versus ~75 s a page one at a time locally.
// Free quota is 25,000 requests a day per key.

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CATEGORY_PARAMS = ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"];
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// Picks up to `count` pages spread across the site's sections, the way
// Unlighthouse's dynamic sampling does: pages are grouped by their parent path
// (/events/a/ and /events/b/ are one group), and groups are taken round-robin
// in crawl order, so 20 pages of a site with 3,000 event pages aren't all events.
export function samplePages(urls, count) {
	const groups = new Map();
	for (const url of urls) {
		const segments = new URL(url).pathname.split("/").filter(Boolean);
		const key = segments.length <= 1 ? url : `/${ segments.slice(0, -1).join("/") }/*`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(url);
	}
	const lists = [...groups.values()];
	const picked = [];
	for (let round = 0; picked.length < count && lists.some(list => list.length > round); round += 1) {
		for (const list of lists) {
			if (picked.length >= count) break;
			if (list[round]) picked.push(list[round]);
		}
	}
	return picked;
}

// The key is in the query string, so error messages are built from Google's
// JSON error, never from the request URL.
async function fetchReport(url, { apiKey, device, timeoutMs }) {
	const params = new URLSearchParams({ url, strategy: device === "desktop" ? "DESKTOP" : "MOBILE" });
	if (apiKey) params.set("key", apiKey);
	for (const category of CATEGORY_PARAMS) params.append("category", category);
	let response;
	try {
		response = await fetch(`${ ENDPOINT }?${ params }`, { signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		throw Object.assign(new Error(error.name === "TimeoutError" ? "PageSpeed Insights timed out" : "Couldn't reach PageSpeed Insights"), { retry: true });
	}
	const body = await response.json().catch(() => null);
	if (!response.ok) {
		const message = body?.error?.message?.replace(/\s+/g, " ").slice(0, 200) || `HTTP ${ response.status }`;
		// A spent daily quota won't come back in seconds; a per-minute one might.
		const dailyQuota = response.status === 429 && /per day/i.test(message);
		throw Object.assign(new Error(`PageSpeed Insights: ${ message }`), { retry: RETRYABLE.has(response.status) && !dailyQuota, dailyQuota });
	}
	if (!body?.lighthouseResult) throw new Error("PageSpeed Insights returned no Lighthouse report");
	return body.lighthouseResult;
}

export async function runPageSpeed({ urls, device, apiKey, concurrency = 4, timeoutMs = 120_000, onProgress = () => {}, log = () => {} }) {
	const reports = [];
	const failures = [];
	let next = 0;
	let done = 0;
	let quotaHit = false;

	const worker = async () => {
		while (next < urls.length && !quotaHit) {
			const url = urls[next++];
			for (let attempt = 1; ; attempt += 1) {
				try {
					const report = await fetchReport(url, { apiKey, device, timeoutMs });
					reports.push({ url, report });
					break;
				} catch (error) {
					if (error.dailyQuota) quotaHit = true;
					if (error.retry && attempt < 3) {
						await new Promise(resolve => setTimeout(resolve, attempt * 15_000));
						continue;
					}
					log(`PageSpeed failed for ${ url }: ${ error.message }`);
					failures.push({ url, error: error.message });
					break;
				}
			}
			done += 1;
			onProgress({ phase: "lighthouse", done, total: urls.length });
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
	for (const url of urls.slice(next)) failures.push({ url, error: "Skipped: the PageSpeed Insights quota ran out" });
	if (reports.length === 0) {
		throw new Error(failures[0]?.error || "PageSpeed Insights tested no pages");
	}
	return { reports, failures };
}
