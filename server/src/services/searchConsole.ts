// Google Search Console for sites the signed-in account has verified: what
// Google's index says about a URL (URL Inspection API) and how it performs in
// search (Search Analytics). Read-only (webmasters.readonly). Credentials come
// from scripts/search-console-signin.mjs: GSC_CLIENT_ID, GSC_CLIENT_SECRET,
// GSC_REFRESH_TOKEN. Only Google's own endpoints are called, never the audited
// URL, so this adds no SSRF surface. Free; URL inspection is capped at 2,000 a
// day and 600 a minute per property.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://searchconsole.googleapis.com";
const SITES_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 20_000;

type Token = { value: string; expiresAt: number };
let token: Token | null = null;
let sites: { list: { siteUrl: string; permissionLevel: string }[]; fetchedAt: number } | null = null;

export function isSearchConsoleConfigured(): boolean {
	return Boolean(process.env.GSC_CLIENT_ID && process.env.GSC_CLIENT_SECRET && process.env.GSC_REFRESH_TOKEN);
}

class SearchConsoleError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
	}
}

async function googleJson<T>(url: string, init: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
	} catch {
		throw new SearchConsoleError("Couldn't reach Google's Search Console API.");
	}
	const body = await response.json().catch(() => null) as (T & { error?: { message?: string } | string; error_description?: string }) | null;
	if (!response.ok || !body) {
		const detail = typeof body?.error === "string" ? body.error_description || body.error : body?.error?.message;
		throw new SearchConsoleError(`Search Console: ${ detail || `HTTP ${ response.status }` }`, response.status);
	}
	return body;
}

async function accessToken(): Promise<string> {
	if (token && token.expiresAt > Date.now() + 60_000) return token.value;
	const body = await googleJson<{ access_token: string; expires_in: number }>(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: process.env.GSC_CLIENT_ID!,
			client_secret: process.env.GSC_CLIENT_SECRET!,
			refresh_token: process.env.GSC_REFRESH_TOKEN!,
			grant_type: "refresh_token",
		}),
	}).catch(error => {
		// invalid_grant = the sign-in was revoked or expired: rerun the script.
		if (error instanceof SearchConsoleError && /invalid_grant/i.test(error.message)) {
			throw new SearchConsoleError("The Search Console sign-in has expired or been revoked. Run scripts/search-console-signin.mjs again.");
		}
		throw error;
	});
	token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
	return token.value;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
	return googleJson<T>(`${ API }${ path }`, {
		method: body ? "POST" : "GET",
		headers: { Authorization: `Bearer ${ await accessToken() }`, ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function listSites() {
	if (sites && Date.now() - sites.fetchedAt < SITES_TTL_MS) return sites.list;
	const body = await api<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>("/webmasters/v3/sites");
	sites = { list: (body.siteEntry ?? []).filter(site => site.permissionLevel !== "siteUnverifiedUser"), fetchedAt: Date.now() };
	return sites.list;
}

// The most specific property covering the URL: a URL-prefix property it starts
// with, else a domain property (sc-domain:) for its host or a parent domain.
export function findProperty(url: URL, list: { siteUrl: string }[]): string | null {
	let best: { siteUrl: string; rank: number } | null = null;
	const host = url.hostname.toLowerCase();
	for (const { siteUrl } of list) {
		let rank = -1;
		if (siteUrl.startsWith("sc-domain:")) {
			const domain = siteUrl.slice("sc-domain:".length).toLowerCase();
			if (host === domain || host.endsWith(`.${ domain }`)) rank = domain.length;
		} else if (url.href.startsWith(siteUrl)) {
			rank = 1000 + siteUrl.length;
		}
		if (rank >= 0 && (!best || rank > best.rank)) best = { siteUrl, rank };
	}
	return best?.siteUrl ?? null;
}

type InspectionResult = {
	inspectionResultLink?: string;
	indexStatusResult?: {
		verdict?: string;
		coverageState?: string;
		robotsTxtState?: string;
		indexingState?: string;
		lastCrawlTime?: string;
		pageFetchState?: string;
		googleCanonical?: string;
		userCanonical?: string;
		crawledAs?: string;
		sitemap?: string[];
		referringUrls?: string[];
	};
	richResultsResult?: {
		verdict?: string;
		detectedItems?: { richResultType?: string; items?: { name?: string; issues?: { issueMessage?: string; severity?: string }[] }[] }[];
	};
};

type AnalyticsRow = { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number };

export type SearchConsoleReport =
	| { status: "not_configured" }
	| { status: "not_verified"; host: string }
	| { status: "error"; property: string | null; message: string }
	| {
		status: "ok";
		property: string;
		inspectedUrl: string;
		inspection: {
			verdict: string | null;
			coverageState: string | null;
			indexingState: string | null;
			robotsTxtState: string | null;
			pageFetchState: string | null;
			lastCrawlTime: string | null;
			crawledAs: string | null;
			googleCanonical: string | null;
			userCanonical: string | null;
			sitemaps: string[];
			referringUrls: string[];
			richResults: { verdict: string | null; items: { type: string; name: string | null; issues: { message: string; severity: string }[] }[] } | null;
			link: string | null;
		} | null;
		inspectionError: string | null;
		performance: {
			startDate: string;
			endDate: string;
			totals: { clicks: number; impressions: number; ctr: number; position: number } | null;
			queries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
		} | null;
		performanceError: string | null;
	};

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function pagePerformance(property: string, pageUrl: string) {
	// Search data lags by 2-3 days, so the window ends 3 days ago.
	const startDate = day(-31);
	const endDate = day(-3);
	const path = `/webmasters/v3/sites/${ encodeURIComponent(property) }/searchAnalytics/query`;
	const filter = { dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "equals", expression: pageUrl }] }] };
	const [totals, queries] = await Promise.all([
		api<{ rows?: AnalyticsRow[] }>(path, { startDate, endDate, ...filter }),
		api<{ rows?: AnalyticsRow[] }>(path, { startDate, endDate, dimensions: ["query"], rowLimit: 10, ...filter }),
	]);
	const total = totals.rows?.[0];
	return {
		startDate,
		endDate,
		totals: total ? { clicks: total.clicks, impressions: total.impressions, ctr: total.ctr, position: total.position } : null,
		queries: (queries.rows ?? []).map(row => ({ query: row.keys?.[0] ?? "", clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position })),
	};
}

export async function searchConsoleReport(input: string): Promise<SearchConsoleReport> {
	if (!isSearchConsoleConfigured()) return { status: "not_configured" };
	let url: URL;
	try {
		url = new URL(input);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
	} catch {
		throw new SearchConsoleError("Not a valid http(s) URL.", 400);
	}
	url.hash = "";

	let property: string | null = null;
	try {
		property = findProperty(url, await listSites());
		if (!property) return { status: "not_verified", host: url.hostname };

		const [inspection, performance] = await Promise.allSettled([
			api<{ inspectionResult?: InspectionResult }>("/v1/urlInspection/index:inspect", { inspectionUrl: url.href, siteUrl: property, languageCode: "en-GB" }),
			pagePerformance(property, url.href),
		]);
		const result = inspection.status === "fulfilled" ? inspection.value.inspectionResult ?? {} : null;
		const index = result?.indexStatusResult;
		const rich = result?.richResultsResult;
		return {
			status: "ok",
			property,
			inspectedUrl: url.href,
			inspection: result ? {
				verdict: index?.verdict ?? null,
				coverageState: index?.coverageState ?? null,
				indexingState: index?.indexingState ?? null,
				robotsTxtState: index?.robotsTxtState ?? null,
				pageFetchState: index?.pageFetchState ?? null,
				lastCrawlTime: index?.lastCrawlTime ?? null,
				crawledAs: index?.crawledAs ?? null,
				googleCanonical: index?.googleCanonical ?? null,
				userCanonical: index?.userCanonical ?? null,
				sitemaps: index?.sitemap ?? [],
				referringUrls: (index?.referringUrls ?? []).slice(0, 10),
				richResults: rich ? {
					verdict: rich.verdict ?? null,
					items: (rich.detectedItems ?? []).flatMap(group => (group.items ?? []).map(item => ({
						type: group.richResultType ?? "Unknown",
						name: item.name ?? null,
						issues: (item.issues ?? []).map(issue => ({ message: issue.issueMessage ?? "", severity: issue.severity ?? "" })),
					}))),
				} : null,
				link: result.inspectionResultLink ?? null,
			} : null,
			inspectionError: inspection.status === "rejected" ? (inspection.reason as Error).message : null,
			performance: performance.status === "fulfilled" ? performance.value : null,
			performanceError: performance.status === "rejected" ? (performance.reason as Error).message : null,
		};
	} catch (error) {
		return { status: "error", property, message: (error as Error).message };
	}
}

export { SearchConsoleError };
