// Client for the separate site-scan service (site-scan/ in this repo). The
// browser calls it directly; the free-seo server only says where it is.

export interface LinkProblem {
	url: string;
	status: number | null;
	error: string | null;
	linkedFrom: string[];
	linkCount: number;
	finalUrl?: string;
	hops?: number;
}

export interface DuplicateGroup {
	value: string;
	count: number;
	pages: string[];
}

export interface SitemapProblem {
	url: string;
	status: number | null;
	finalUrl: string;
	error: string | null;
}

export interface CrawlResult {
	origin: string;
	pagesCrawled: number;
	htmlPages: number;
	sitemapUrls: number;
	crawlComplete: boolean;
	skippedByRobots: number;
	externalChecked: number;
	externalTotal: number;
	brokenInternal: LinkProblem[];
	brokenExternal: LinkProblem[];
	unverifiedExternal: LinkProblem[];
	redirectingLinks: LinkProblem[];
	duplicateTitles: DuplicateGroup[];
	duplicateDescriptions: DuplicateGroup[];
	missingTitles: string[];
	missingDescriptions: string[];
	missingH1: string[];
	noindexPages: string[];
	sitemapProblems: SitemapProblem[];
	orphanPages: string[] | null;
}

export type LighthouseCategoryId = "performance" | "accessibility" | "best-practices" | "seo";

export interface LighthouseIssue {
	id: string;
	title: string;
	description: string;
	category: LighthouseCategoryId;
	worstScore: number;
	pageCount: number;
	pages: string[];
	examples: { page: string; text: string }[];
}

export interface LighthouseRoute {
	path: string;
	score: number;
	categories: Record<LighthouseCategoryId, number | null>;
	lcp: string | null;
	cls: string | null;
}

export interface LighthouseResult {
	routesScanned: number;
	benchmarkIndex: number | null;
	categoryAverages: Record<LighthouseCategoryId, { average: number; min: number } | null>;
	routes: LighthouseRoute[];
	issues: LighthouseIssue[];
}

export interface ScanOptions {
	crawlPages: number;
	lighthousePages: number;
	device: "mobile" | "desktop";
}

export interface ScanSummary {
	id: string;
	site: string;
	status: "queued" | "running" | "done" | "failed";
	phase: "crawl" | "links" | "lighthouse" | null;
	createdAt: string;
	finishedAt: string | null;
	options: ScanOptions;
	error: string | null;
}

export interface ScanProgress {
	phase: "crawl" | "links" | "lighthouse";
	crawled?: number;
	queued?: number;
	done?: number;
	total?: number;
}

export interface Scan extends ScanSummary {
	progress: ScanProgress | null;
	queuePosition: number | null;
	crawl: CrawlResult | null;
	lighthouse: LighthouseResult | null;
	lighthouseError: string | null;
	reportPath: string | null;
}

let configPromise: Promise<string | null> | null = null;

export function getSiteScanUrl(): Promise<string | null> {
	configPromise ??= fetch("/api/config")
		.then(response => (response.ok ? response.json() : {}))
		.then((config: { siteScanUrl?: string | null }) => config.siteScanUrl?.replace(/\/+$/, "") || null)
		.catch(() => null);
	return configPromise;
}

async function call<T>(base: string, path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${ base }${ path }`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
	} catch {
		throw new Error("Couldn't reach the site-scan service. Is it running, and are you on the tailnet?");
	}
	const payload = await response.json().catch(() => ({})) as T & { error?: string };
	if (!response.ok) throw new Error(payload.error || `The site-scan service answered ${ response.status }.`);
	return payload;
}

export const listScans = (base: string, site: string) =>
	call<{ scans: ScanSummary[] }>(base, `/api/scans?site=${ encodeURIComponent(site) }`).then(result => result.scans);

export const getScan = (base: string, id: string) => call<Scan>(base, `/api/scans/${ encodeURIComponent(id) }`);

export const startScan = (base: string, url: string, options: ScanOptions) =>
	call<{ id: string }>(base, "/api/scans", { method: "POST", body: JSON.stringify({ url, ...options }) });
