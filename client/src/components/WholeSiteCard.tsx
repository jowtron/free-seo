import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getScan, getSiteScanUrl, listScans, startScan, type Scan, type ScanOptions, type ScanSummary } from "../api/siteScan";
import { categoryCheckStatusClasses } from "../utils/constants";
import { copyText } from "../utils/clipboard";
import { buildSiteScanPrompt, countSiteScanProblems } from "../utils/siteScanPrompt";

const CATEGORY_LABELS = { performance: "Performance", accessibility: "Accessibility", "best-practices": "Best practices", seo: "SEO" } as const;
const POLL_MS = 5000;

const buttonClass = "shrink-0 rounded-lg border border-brand-border-strong bg-brand-card-header px-3 py-2 text-xs font-semibold text-brand-accent transition-opacity hover:opacity-85 focus:outline-none focus:ring-2 focus:ring-brand-accent/30 disabled:opacity-50";
const selectClass = "rounded-lg border border-brand-border bg-brand-surface-soft px-2 py-1.5 text-xs text-brand-headline";

const scoreClass = (score: number) => categoryCheckStatusClasses[score >= 0.9 ? "pass" : score >= 0.5 ? "warning" : "fail"];
const percent = (score: number) => Math.round(score * 100);
const pathOf = (url: string) => {
	try {
		const parsed = new URL(url);
		return `${ parsed.pathname }${ parsed.search }`;
	} catch {
		return url;
	}
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function describeProgress(scan: Scan): string {
	if (scan.status === "queued") return scan.queuePosition ? `Queued, position ${ scan.queuePosition }.` : "Queued.";
	const progress = scan.progress;
	if (!progress) return "Starting…";
	if (progress.phase === "crawl") return `Crawling: ${ progress.crawled ?? 0 } pages so far.`;
	if (progress.phase === "links") return `Checking links found on ${ progress.crawled ?? 0 } pages.`;
	return `Lighthouse: ${ progress.done ?? 0 } of up to ${ progress.total ?? "?" } pages. Each takes about a minute on this box.`;
}

function Findings({ title, count, note, children }: { title: string; count: number; note?: string; children: ReactNode }) {
	if (count === 0) return null;
	return (
		<details className="rounded-lg border border-brand-border bg-brand-surface-soft">
			<summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-brand-headline">
				{ title } <span className="font-normal text-brand-muted">({ count })</span>
			</summary>
			<div className="border-t border-brand-border px-3 py-2 text-xs leading-relaxed text-brand-muted">
				{ note && <p className="mb-2">{ note }</p> }
				<ul className="space-y-1.5 wrap-break-word">{ children }</ul>
			</div>
		</details>
	);
}

const Link = ({ href }: { href: string }) => (
	<a href={ href } target="_blank" rel="noopener noreferrer" className="text-brand-accent hover:underline">{ pathOf(href) }</a>
);

function ScanResults({ scan, base }: { scan: Scan; base: string }) {
	const prompt = useMemo(() => buildSiteScanPrompt(scan), [scan]);
	const problemCount = useMemo(() => countSiteScanProblems(scan), [scan]);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
	useEffect(() => {
		if (copyState === "idle") return;
		const timer = window.setTimeout(() => setCopyState("idle"), 2500);
		return () => window.clearTimeout(timer);
	}, [copyState]);
	const crawl = scan.crawl;
	const lighthouse = scan.lighthouse;

	return (
		<div className="mt-3 space-y-3">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<p className="text-xs leading-relaxed text-brand-muted">
					{ crawl && `Crawled ${ crawl.pagesCrawled } pages${ crawl.sitemapUrls ? ` of ${ crawl.sitemapUrls } in the sitemap` : "" }${ crawl.crawlComplete ? " (all of them)" : "" }. ` }
					{ lighthouse && `Lighthouse ran on ${ lighthouse.routesScanned } sampled pages. ` }
					{ problemCount === 0 ? "No problems found." : `${ problemCount } ${ problemCount === 1 ? "problem" : "problems" } found.` }
				</p>
				<div className="flex gap-2">
					{ scan.reportPath && (
						<a href={ `${ base }${ scan.reportPath }` } target="_blank" rel="noopener noreferrer" className={ buttonClass }>Full Unlighthouse report</a>
					) }
					{ problemCount > 0 && (
						<button type="button" className={ buttonClass } onClick={ async () => setCopyState(await copyText(prompt) ? "copied" : "failed") }>
							{ copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy Claude prompt" }
						</button>
					) }
				</div>
			</div>

			{ scan.lighthouseError && (
				<p className="rounded-lg bg-brand-warning-soft px-3 py-2 text-xs text-brand-warning">The crawl finished but Lighthouse failed: { scan.lighthouseError }</p>
			) }

			{ lighthouse && (
				<>
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
						{ (Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[]).map(id => {
							const value = lighthouse.categoryAverages[id];
							return (
								<div key={ id } className={ `rounded-lg px-3 py-2 ${ value ? scoreClass(value.average) : categoryCheckStatusClasses.not_applicable }` }>
									<div className="text-xs font-semibold">{ CATEGORY_LABELS[id] }</div>
									<div className="text-lg font-bold">{ value ? percent(value.average) : "—" }</div>
									{ value && <div className="text-xs opacity-80">lowest { percent(value.min) }</div> }
								</div>
							);
						}) }
					</div>
					<p className="text-xs leading-relaxed text-brand-muted">
						Averages across the sampled pages. Performance is measured on a low-power box, so it reads lower than PageSpeed Insights: compare pages with each other, and use PageSpeed Insights for the absolute numbers.
					</p>
				</>
			) }

			<div className="space-y-2">
				{ crawl && (
					<>
						<Findings title="Broken internal links" count={ crawl.brokenInternal.length }>
							{ crawl.brokenInternal.map(item => (
								<li key={ item.url }><Link href={ item.url }/> { item.status ? `HTTP ${ item.status }` : item.error }, linked from { item.linkCount }: { item.linkedFrom.slice(0, 3).map(url => <span key={ url } className="mr-1"><Link href={ url }/></span>) }</li>
							)) }
						</Findings>
						<Findings title="Broken external links" count={ crawl.brokenExternal.length }>
							{ crawl.brokenExternal.map(item => (
								<li key={ item.url }><a href={ item.url } target="_blank" rel="noopener noreferrer" className="text-brand-accent hover:underline">{ item.url }</a> { item.status ? `HTTP ${ item.status }` : item.error }, on { item.linkedFrom.slice(0, 3).map(url => <span key={ url } className="mr-1"><Link href={ url }/></span>) }</li>
							)) }
						</Findings>
						<Findings title="Internal links that redirect" count={ crawl.redirectingLinks.length } note="Link straight to the final URL to save a round trip.">
							{ crawl.redirectingLinks.map(item => (
								<li key={ item.url }><Link href={ item.url }/> → { item.finalUrl && <Link href={ item.finalUrl }/> } ({ item.linkCount } { item.linkCount === 1 ? "link" : "links" })</li>
							)) }
						</Findings>
						<Findings title="Duplicate titles" count={ crawl.duplicateTitles.length }>
							{ crawl.duplicateTitles.map(group => (
								<li key={ group.value }>“{ group.value }” on { group.count } pages: { group.pages.slice(0, 4).map(url => <span key={ url } className="mr-1"><Link href={ url }/></span>) }</li>
							)) }
						</Findings>
						<Findings title="Duplicate meta descriptions" count={ crawl.duplicateDescriptions.length }>
							{ crawl.duplicateDescriptions.map(group => (
								<li key={ group.value }>“{ group.value.slice(0, 140) }” on { group.count } pages: { group.pages.slice(0, 4).map(url => <span key={ url } className="mr-1"><Link href={ url }/></span>) }</li>
							)) }
						</Findings>
						{ ([
							["Pages with no title", crawl.missingTitles],
							["Pages with no meta description", crawl.missingDescriptions],
							["Pages with no H1", crawl.missingH1],
							["Pages marked noindex", crawl.noindexPages],
						] as const).map(([title, urls]) => (
							<Findings key={ title } title={ title } count={ urls.length }>
								{ urls.slice(0, 50).map(url => <li key={ url }><Link href={ url }/></li>) }
							</Findings>
						)) }
						<Findings title="Sitemap entries that don't resolve cleanly" count={ crawl.sitemapProblems.length } note="A sitemap should list only final, indexable URLs.">
							{ crawl.sitemapProblems.map(item => (
								<li key={ item.url }><Link href={ item.url }/> { item.error || (item.finalUrl !== item.url ? <>redirects to <Link href={ item.finalUrl }/></> : `HTTP ${ item.status }`) }</li>
							)) }
						</Findings>
						{ crawl.orphanPages && (
							<Findings title="Orphan pages" count={ crawl.orphanPages.length } note="In the sitemap, but no page links to them.">
								{ crawl.orphanPages.slice(0, 50).map(url => <li key={ url }><Link href={ url }/></li>) }
							</Findings>
						) }
						<Findings title="External links that refused the scanner" count={ crawl.unverifiedExternal.length } note="Usually bot protection (HTTP 401, 403, 429). Probably fine; check by hand if one matters.">
							{ crawl.unverifiedExternal.map(item => (
								<li key={ item.url }><a href={ item.url } target="_blank" rel="noopener noreferrer" className="text-brand-accent hover:underline">{ item.url }</a> HTTP { item.status }</li>
							)) }
						</Findings>
					</>
				) }
				{ lighthouse && (
					<>
						<Findings title="Lighthouse issues across the site" count={ lighthouse.issues.length } note="Sorted by how many of the sampled pages each one affects.">
							{ lighthouse.issues.map(issue => (
								<li key={ issue.id }>
									<span className="font-semibold text-brand-headline">{ issue.title }</span>{ " " }
									({ CATEGORY_LABELS[issue.category] }, { issue.pageCount } of { lighthouse.routesScanned } pages)
									{ issue.examples.length > 0 && (
										<ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono">
											{ issue.examples.map(example => <li key={ example.text }>{ example.text }</li>) }
										</ul>
									) }
								</li>
							)) }
						</Findings>
						<Findings title="Pages by performance score" count={ lighthouse.routes.length } note="Slowest first.">
							{ lighthouse.routes.map(route => (
								<li key={ route.path }>
									<Link href={ new URL(route.path, scan.site).href }/>{ " " }
									{ route.categories.performance !== null && `performance ${ percent(route.categories.performance) }` }
									{ route.lcp && `, LCP ${ route.lcp }` }
									{ route.categories.accessibility !== null && `, accessibility ${ percent(route.categories.accessibility) }` }
								</li>
							)) }
						</Findings>
					</>
				) }
			</div>
		</div>
	);
}

export default memo(function WholeSiteCard({ url }: { url: string }) {
	const site = useMemo(() => {
		try {
			return `${ new URL(url).origin }/`;
		} catch {
			return null;
		}
	}, [url]);
	const [base, setBase] = useState<string | null | undefined>(undefined);
	const [scan, setScan] = useState<Scan | null>(null);
	const [history, setHistory] = useState<ScanSummary[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);
	const [options, setOptions] = useState<ScanOptions>({ crawlPages: 300, lighthousePages: 20, device: "mobile" });

	useEffect(() => {
		getSiteScanUrl().then(setBase);
	}, []);

	const load = useCallback(async (id: string) => {
		if (!base) return;
		try {
			setScan(await getScan(base, id));
			setError(null);
		} catch (loadError) {
			setError((loadError as Error).message);
		}
	}, [base]);

	// Show the newest scan of this site, if there is one.
	useEffect(() => {
		if (!base || !site) return;
		setScan(null);
		listScans(base, site)
			.then(scans => {
				setHistory(scans);
				if (scans[0]) return load(scans[0].id);
			})
			.catch(listError => setError((listError as Error).message));
	}, [base, site, load]);

	const active = scan?.status === "queued" || scan?.status === "running";
	useEffect(() => {
		if (!active || !scan) return;
		const timer = window.setTimeout(() => load(scan.id), POLL_MS);
		return () => window.clearTimeout(timer);
	}, [active, scan, load]);

	if (!base || !site) return null;

	const handleStart = async () => {
		setStarting(true);
		try {
			const { id } = await startScan(base, site, options);
			await load(id);
			setHistory(await listScans(base, site));
		} catch (startError) {
			setError((startError as Error).message);
		} finally {
			setStarting(false);
		}
	};

	return (
		<section className="rounded-xl border border-brand-border bg-brand-surface p-4 shadow-panel">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold text-brand-headline">Whole site</h3>
					<p className="mt-1 text-xs leading-relaxed text-brand-muted">
						This audit checks one page. A site scan crawls { site } for broken links, redirects and duplicate titles, and runs Lighthouse on a sample of pages. It runs on another box and takes from a few minutes to over an hour, so you can leave this page and come back.
					</p>
				</div>
			</div>

			<div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-brand-muted">
				<label className="flex items-center gap-1">Crawl up to
					<select className={ selectClass } value={ options.crawlPages } disabled={ active } onChange={ event => setOptions({ ...options, crawlPages: Number(event.target.value) }) }>
						{ [100, 300, 1000, 2000].map(value => <option key={ value } value={ value }>{ value } pages</option>) }
					</select>
				</label>
				<label className="flex items-center gap-1">Lighthouse on
					<select className={ selectClass } value={ options.lighthousePages } disabled={ active } onChange={ event => setOptions({ ...options, lighthousePages: Number(event.target.value) }) }>
						<option value={ 0 }>no pages (crawl only)</option>
						{ [5, 10, 20, 50, 100].map(value => <option key={ value } value={ value }>{ value } pages</option>) }
					</select>
				</label>
				<select className={ selectClass } value={ options.device } disabled={ active } onChange={ event => setOptions({ ...options, device: event.target.value as ScanOptions["device"] }) }>
					<option value="mobile">Mobile</option>
					<option value="desktop">Desktop</option>
				</select>
				<button type="button" className={ buttonClass } disabled={ active || starting } onClick={ handleStart }>
					{ active ? "Scanning…" : scan ? "Run a new scan" : "Scan the whole site" }
				</button>
			</div>

			{ error && <p className="mt-3 rounded-lg bg-brand-danger-soft px-3 py-2 text-xs text-brand-danger">{ error }</p> }

			{ scan && (
				<div className="mt-3 border-t border-brand-border pt-3">
					<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-brand-muted">
						<span>
							Scan started { when(scan.createdAt) }
							{ scan.options && `: ${ scan.options.crawlPages } crawl pages, Lighthouse on ${ scan.options.lighthousePages }, ${ scan.options.device }` }
						</span>
						{ history.length > 1 && (
							<select className={ selectClass } value={ scan.id } onChange={ event => load(event.target.value) }>
								{ history.map(item => <option key={ item.id } value={ item.id }>{ when(item.createdAt) } ({ item.status })</option>) }
							</select>
						) }
					</div>
					{ active && <p className="mt-2 text-xs text-brand-headline">{ describeProgress(scan) }</p> }
					{ scan.status === "failed" && <p className="mt-2 rounded-lg bg-brand-danger-soft px-3 py-2 text-xs text-brand-danger">The scan failed: { scan.error }</p> }
					{ scan.status === "done" && <ScanResults scan={ scan } base={ base }/> }
				</div>
			) }
		</section>
	);
});
