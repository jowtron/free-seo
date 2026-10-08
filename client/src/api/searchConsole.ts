// Search Console data for the audited URL, from the free-seo server, which
// holds the Google sign-in. Mirrors SearchConsoleReport in
// server/src/services/searchConsole.ts.

export interface SearchConsoleInspection {
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
}

export interface SearchMetrics {
	clicks: number;
	impressions: number;
	ctr: number;
	position: number;
}

export interface SearchConsolePerformance {
	startDate: string;
	endDate: string;
	totals: SearchMetrics | null;
	queries: (SearchMetrics & { query: string })[];
}

export type SearchConsoleReport =
	| { status: "not_configured" }
	| { status: "not_verified"; host: string }
	| { status: "error"; property: string | null; message: string }
	| {
		status: "ok";
		property: string;
		inspectedUrl: string;
		inspection: SearchConsoleInspection | null;
		inspectionError: string | null;
		performance: SearchConsolePerformance | null;
		performanceError: string | null;
	};

export async function getSearchConsoleReport(url: string): Promise<SearchConsoleReport> {
	const response = await fetch(`/api/search-console?url=${ encodeURIComponent(url) }`);
	const body = await response.json().catch(() => ({})) as SearchConsoleReport & { error?: string };
	if (!response.ok) throw new Error(body.error || `Search Console lookup failed (HTTP ${ response.status }).`);
	return body;
}
