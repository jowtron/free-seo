import { assertPublicUrl } from "./urlSafety.mjs";

export const USER_AGENT = "FreeSEOSiteScan/0.1 (+https://github.com/jowtron/free-seo)";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// Follows redirects by hand so every hop is checked and the chain is recorded.
// With readBody, reads up to maxBytes of the final response; otherwise only the
// status and headers are read and the connection is dropped.
export async function fetchWithRedirects(startUrl, { readBody = false, maxBytes = 5_000_000, maxRedirects = 5, timeoutMs = 15_000 } = {}) {
	let current = await assertPublicUrl(startUrl);
	const chain = [];
	for (let hop = 0 ; hop <= maxRedirects ; hop += 1) {
		const response = await fetch(current, {
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
			headers: { "User-Agent": USER_AGENT, "Accept": readBody ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5" : "*/*" },
		});
		const location = response.headers.get("location");
		if (REDIRECTS.has(response.status) && location) {
			await response.body?.cancel().catch(() => {});
			const next = new URL(location, current);
			next.hash = "";
			chain.push({ from: current.href, to: next.href, status: response.status });
			if (hop === maxRedirects) {
				return { url: current.href, status: response.status, chain, contentType: "", body: "", error: "Too many redirects" };
			}
			current = await assertPublicUrl(next);
			continue;
		}
		const contentType = response.headers.get("content-type") || "";
		let body = "";
		let truncated = false;
		if (readBody && response.body) {
			const reader = response.body.getReader();
			const chunks = [];
			let size = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > maxBytes) {
					truncated = true;
					await reader.cancel().catch(() => {});
					break;
				}
				chunks.push(value);
			}
			body = Buffer.concat(chunks).toString("utf8");
		} else {
			await response.body?.cancel().catch(() => {});
		}
		return { url: current.href, status: response.status, chain, contentType, body, truncated, error: null };
	}
	throw new Error("unreachable");
}
