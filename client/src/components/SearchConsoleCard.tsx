import { memo, useEffect, useState, type ReactNode } from "react";
import { getSearchConsoleReport, type SearchConsoleInspection, type SearchConsolePerformance, type SearchConsoleReport } from "../api/searchConsole";
import { categoryCheckStatusClasses } from "../utils/constants";

type Tone = "pass" | "warning" | "fail" | "not_applicable";

const VERDICTS: Record<string, { label: string; tone: Tone }> = {
	PASS: { label: "Indexed", tone: "pass" },
	PARTIAL: { label: "Indexed, with problems", tone: "warning" },
	FAIL: { label: "Not indexed", tone: "fail" },
	NEUTRAL: { label: "Not indexed", tone: "not_applicable" },
};

const FETCH_STATES: Record<string, string> = {
	SUCCESSFUL: "Fetched fine",
	SOFT_404: "Soft 404: the page looked empty or missing to Google",
	BLOCKED_ROBOTS_TXT: "Blocked by robots.txt",
	NOT_FOUND: "Not found (404)",
	ACCESS_DENIED: "Access denied (401)",
	ACCESS_FORBIDDEN: "Forbidden (403)",
	BLOCKED_4XX: "Blocked by another 4xx error",
	SERVER_ERROR: "Server error (5xx)",
	REDIRECT_ERROR: "Redirect error",
	INTERNAL_CRAWL_ERROR: "Google had an internal crawl error",
	INVALID_URL: "Invalid URL",
};

const INDEXING_STATES: Record<string, string> = {
	INDEXING_ALLOWED: "Allowed",
	BLOCKED_BY_META_TAG: "Blocked by a noindex meta tag",
	BLOCKED_BY_HTTP_HEADER: "Blocked by an X-Robots-Tag header",
	BLOCKED_BY_ROBOTS_TXT: "Blocked by robots.txt",
};

const pill = (tone: Tone) => `rounded-md px-2 py-0.5 text-xs font-semibold ${ categoryCheckStatusClasses[tone] }`;
const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });

function ago(iso: string): string {
	const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
	const date = new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
	return days <= 0 ? `${ date } (today)` : `${ date } (${ days } day${ days === 1 ? "" : "s" } ago)`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid grid-cols-[9rem_1fr] gap-2 py-1">
			<dt className="text-brand-muted">{ label }</dt>
			<dd className="min-w-0 wrap-break-word text-brand-headline">{ children }</dd>
		</div>
	);
}

function Inspection({ inspection, inspectedUrl }: { inspection: SearchConsoleInspection; inspectedUrl: string }) {
	const verdict = VERDICTS[inspection.verdict ?? ""] ?? { label: "Unknown to Google", tone: "not_applicable" as Tone };
	const canonicalMismatch = inspection.googleCanonical && inspection.userCanonical && inspection.googleCanonical !== inspection.userCanonical;
	const notCanonical = inspection.googleCanonical && inspection.googleCanonical !== inspectedUrl;
	return (
		<div className="rounded-lg border border-brand-border bg-brand-surface-soft p-3">
			<div className="flex flex-wrap items-center gap-2">
				<h4 className="text-xs font-semibold text-brand-headline">Google's index</h4>
				<span className={ pill(verdict.tone) }>{ verdict.label }</span>
			</div>
			<dl className="mt-2 text-xs">
				{ inspection.coverageState && <Row label="Status">{ inspection.coverageState }</Row> }
				<Row label="Last crawled">{ inspection.lastCrawlTime ? `${ ago(inspection.lastCrawlTime) }${ inspection.crawledAs ? `, as ${ inspection.crawledAs.toLowerCase() }` : "" }` : "Never" }</Row>
				{ inspection.pageFetchState && <Row label="Fetch">{ FETCH_STATES[inspection.pageFetchState] ?? inspection.pageFetchState }</Row> }
				{ inspection.indexingState && <Row label="Indexing">{ INDEXING_STATES[inspection.indexingState] ?? inspection.indexingState }</Row> }
				{ inspection.googleCanonical && (
					<Row label="Canonical">
						{ canonicalMismatch
							? <span className="text-brand-warning">Google chose { inspection.googleCanonical }, but the page declares { inspection.userCanonical }</span>
							: notCanonical
								? <span className="text-brand-warning">Google treats { inspection.googleCanonical } as the main version of this page</span>
								: "Google agrees this URL is the main version" }
					</Row>
				) }
				{ inspection.sitemaps.length > 0 && <Row label="Found in sitemap">{ inspection.sitemaps.join(", ") }</Row> }
				{ inspection.referringUrls.length > 0 && <Row label="Linked from">{ inspection.referringUrls.slice(0, 3).join(", ") }{ inspection.referringUrls.length > 3 ? ", …" : "" }</Row> }
			</dl>
			{ inspection.richResults && (
				<div className="mt-2 border-t border-brand-border pt-2 text-xs">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-semibold text-brand-headline">Rich results</span>
						<span className={ pill(VERDICTS[inspection.richResults.verdict ?? ""]?.tone ?? "not_applicable") }>
							{ inspection.richResults.verdict === "PASS" ? "Valid" : inspection.richResults.verdict === "FAIL" ? "Invalid" : inspection.richResults.verdict === "PARTIAL" ? "Valid, with warnings" : "None" }
						</span>
					</div>
					<ul className="mt-1 space-y-1">
						{ inspection.richResults.items.map((item, index) => (
							<li key={ index } className="text-brand-muted">
								<span className="text-brand-headline">{ item.type }</span>{ item.name ? `: ${ item.name }` : "" }
								{ item.issues.length > 0 && (
									<ul className="mt-0.5 list-disc pl-4">
										{ item.issues.map(issue => <li key={ issue.message } className={ issue.severity === "ERROR" ? "text-brand-danger" : "text-brand-warning" }>{ issue.message }</li>) }
									</ul>
								) }
							</li>
						)) }
					</ul>
				</div>
			) }
			<p className="mt-2 text-xs text-brand-muted">This is what Google saw on its last crawl, not the live page. After a fix, use the Rich Results Test or "Request indexing" in Search Console.</p>
		</div>
	);
}

function Performance({ performance }: { performance: SearchConsolePerformance }) {
	const totals = performance.totals;
	const range = `${ new Date(performance.startDate).toLocaleDateString(undefined, { dateStyle: "medium" }) } to ${ new Date(performance.endDate).toLocaleDateString(undefined, { dateStyle: "medium" }) }`;
	return (
		<div className="rounded-lg border border-brand-border bg-brand-surface-soft p-3">
			<h4 className="text-xs font-semibold text-brand-headline">Google search, last 4 weeks</h4>
			<p className="text-xs text-brand-muted">{ range }</p>
			{ !totals ? (
				<p className="mt-2 text-xs text-brand-muted">This page didn't appear in Google search results in that time.</p>
			) : (
				<>
					<div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
						{ ([
							["Clicks", number(totals.clicks)],
							["Impressions", number(totals.impressions)],
							["Click rate", `${ (totals.ctr * 100).toFixed(1) }%`],
							["Avg position", totals.position.toFixed(1)],
						] as const).map(([label, value]) => (
							<div key={ label } className="rounded-lg bg-brand-surface px-3 py-2">
								<div className="text-xs text-brand-muted">{ label }</div>
								<div className="text-lg font-bold text-brand-headline">{ value }</div>
							</div>
						)) }
					</div>
					{ performance.queries.length > 0 && (
						<table className="mt-3 w-full text-left text-xs">
							<thead className="text-brand-muted">
								<tr><th className="py-1 font-semibold">Top searches</th><th className="py-1 text-right font-semibold">Clicks</th><th className="py-1 text-right font-semibold">Impr.</th><th className="py-1 text-right font-semibold">Pos.</th></tr>
							</thead>
							<tbody className="text-brand-headline">
								{ performance.queries.map(row => (
									<tr key={ row.query } className="border-t border-brand-border">
										<td className="py-1 pr-2 wrap-break-word">{ row.query }</td>
										<td className="py-1 text-right">{ number(row.clicks) }</td>
										<td className="py-1 text-right">{ number(row.impressions) }</td>
										<td className="py-1 text-right">{ row.position.toFixed(1) }</td>
									</tr>
								)) }
							</tbody>
						</table>
					) }
				</>
			) }
		</div>
	);
}

export default memo(function SearchConsoleCard({ url }: { url: string }) {
	const [report, setReport] = useState<SearchConsoleReport | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setReport(null);
		setError(null);
		getSearchConsoleReport(url)
			.then(result => { if (!cancelled) setReport(result); })
			.catch(loadError => { if (!cancelled) setError((loadError as Error).message); });
		return () => { cancelled = true; };
	}, [url]);

	if (report?.status === "not_configured") return null;

	return (
		<section className="rounded-xl border border-brand-border bg-brand-surface p-4 shadow-panel">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold text-brand-headline">Search Console</h3>
					<p className="mt-1 text-xs leading-relaxed text-brand-muted">
						{ report?.status === "ok" ? `From your Search Console property ${ report.property }.` : "Google's own data, for sites you've verified in Search Console." }
					</p>
				</div>
				{ report?.status === "ok" && report.inspection?.link && (
					<a href={ report.inspection.link } target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-lg border border-brand-border-strong bg-brand-card-header px-3 py-2 text-xs font-semibold text-brand-accent transition-opacity hover:opacity-85">
						Open in Search Console
					</a>
				) }
			</div>

			{ !report && !error && <p className="mt-3 text-xs text-brand-muted">Asking Google…</p> }
			{ error && <p className="mt-3 rounded-lg bg-brand-danger-soft px-3 py-2 text-xs text-brand-danger">{ error }</p> }
			{ report?.status === "error" && <p className="mt-3 rounded-lg bg-brand-danger-soft px-3 py-2 text-xs text-brand-danger">{ report.message }</p> }
			{ report?.status === "not_verified" && (
				<p className="mt-3 text-xs text-brand-muted">{ report.host } isn't one of the sites verified in your Search Console, so there's no Google data for it here.</p>
			) }
			{ report?.status === "ok" && (
				<div className="mt-3 grid gap-3 lg:grid-cols-2">
					{ report.inspection
						? <Inspection inspection={ report.inspection } inspectedUrl={ report.inspectedUrl }/>
						: <p className="rounded-lg bg-brand-warning-soft px-3 py-2 text-xs text-brand-warning">URL inspection failed: { report.inspectionError }</p> }
					{ report.performance
						? <Performance performance={ report.performance }/>
						: <p className="rounded-lg bg-brand-warning-soft px-3 py-2 text-xs text-brand-warning">Search performance failed: { report.performanceError }</p> }
				</div>
			) }
		</section>
	);
});
