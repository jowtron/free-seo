import type { AxiosInstance } from "axios";
import { assertPublicHttpUrl } from "./urlSafety.js";
import type { FetchTextOptions, FetchTextResult, RedirectEntry, } from "../types.js";

const redirectStatuses: Set<number> = new Set([301, 302, 303, 307, 308]);

export async function fetchTextWithRedirects(
	startUrl: string,
	client: AxiosInstance,
	options: FetchTextOptions = {},
): Promise<FetchTextResult> {
	const maxRedirects = options.maxRedirects ?? 5;
	let currentUrl = await assertPublicHttpUrl(
		startUrl,
		options.label || "URL",
	);
	const redirectChain: RedirectEntry[] = [];
	
	for (let index = 0 ; index <= maxRedirects ; index += 1) {
		const response = await client.get(currentUrl.href);
		const locationHeader = response.headers["location"] as
			| string
			| undefined;
		
		if (redirectStatuses.has(response.status) && locationHeader) {
			if (index === maxRedirects) {
				throw new Error("Too many redirects.");
			}
			
			const nextUrl = new URL(locationHeader, currentUrl.href);
			nextUrl.hash = "";
			await assertPublicHttpUrl(nextUrl, "Redirect target");
			
			redirectChain.push({
				from: currentUrl.href,
				to: nextUrl.href,
				statusCode: response.status,
			});
			currentUrl = nextUrl;
			continue;
		}
		
		return {
			url: currentUrl.href,
			statusCode: response.status,
			headers: response.headers as Record<
				string,
				string | string[] | undefined
			>,
			text:
				typeof response.data === "string"
					? response.data
					: String(response.data ?? ""),
			redirectChain,
		};
	}
	
	throw new Error("Too many redirects.");
}

// Like fetchTextWithRedirects, but only reads the status line and headers, then
// closes the connection. For "does this link work?" probes, where downloading
// the body is wasted work and a large page would trip maxContentLength and be
// misreported as broken.
export async function fetchStatusWithRedirects(
	startUrl: string,
	client: AxiosInstance,
	options: FetchTextOptions = {},
): Promise<{ url: string; statusCode: number }> {
	const maxRedirects = options.maxRedirects ?? 5;
	let currentUrl = await assertPublicHttpUrl(
		startUrl,
		options.label || "URL",
	);
	
	for (let index = 0 ; index <= maxRedirects ; index += 1) {
		const response = await client.get(currentUrl.href, {
			responseType: "stream",
			maxContentLength: -1,
		});
		const body = response.data as { destroy?: () => void } | undefined;
		body?.destroy?.();
		const locationHeader = response.headers["location"] as
			| string
			| undefined;
		
		if (redirectStatuses.has(response.status) && locationHeader) {
			if (index === maxRedirects) {
				throw new Error("Too many redirects.");
			}
			
			const nextUrl = new URL(locationHeader, currentUrl.href);
			nextUrl.hash = "";
			await assertPublicHttpUrl(nextUrl, "Redirect target");
			currentUrl = nextUrl;
			continue;
		}
		
		return { url: currentUrl.href, statusCode: response.status };
	}
	
	throw new Error("Too many redirects.");
}
