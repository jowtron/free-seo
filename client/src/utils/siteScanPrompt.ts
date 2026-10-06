import type { CrawlResult, LighthouseResult, Scan } from "../api/siteScan";

const CATEGORY_LABELS: Record<string, string> = {
	performance: "Performance",
	accessibility: "Accessibility",
	"best-practices": "Best practices",
	seo: "SEO",
};

const percent = (score: number) => `${ Math.round(score * 100) }`;
const status = (code: number | null, error: string | null) => (code ? `HTTP ${ code }` : error || "no response");

export function countSiteScanProblems(scan: Scan): number {
	const crawl = scan.crawl;
	const crawlCount = crawl
		? crawl.brokenInternal.length + crawl.brokenExternal.length + crawl.redirectingLinks.length
			+ crawl.duplicateTitles.length + crawl.duplicateDescriptions.length + crawl.missingTitles.length
			+ crawl.missingDescriptions.length + crawl.missingH1.length + crawl.sitemapProblems.length
			+ (crawl.orphanPages?.length ?? 0)
		: 0;
	return crawlCount + (scan.lighthouse?.issues.length ?? 0);
}

function pushList(lines: string[], heading: string, intro: string, items: string[], limit = 25) {
	if (items.length === 0) return;
	lines.push("", `### ${ heading } (${ items.length })`, "", intro, "");
	for (const item of items.slice(0, limit)) lines.push(`- ${ item }`);
	if (items.length > limit) lines.push(`- …and ${ items.length - limit } more`);
}

function crawlSection(lines: string[], crawl: CrawlResult) {
	lines.push("", "## Crawl findings", "", `Crawled ${ crawl.pagesCrawled } pages${ crawl.sitemapUrls ? ` (the sitemap lists ${ crawl.sitemapUrls })` : "" }${ crawl.crawlComplete ? ", which covered every page found" : ", so pages beyond that weren't checked" }.`);
	const linkLine = (item: CrawlResult["brokenInternal"][number]) =>
		`${ item.url } (${ status(item.status, item.error) }), linked from ${ item.linkCount } page${ item.linkCount === 1 ? "" : "s" }, e.g. ${ item.linkedFrom.slice(0, 3).join(", ") }`;
	pushList(lines, "Broken internal links", "Fix or remove each link, or restore the missing page (or redirect it).", crawl.brokenInternal.map(linkLine));
	pushList(lines, "Broken external links", "Update or remove each link.", crawl.brokenExternal.map(linkLine));
	pushList(lines, "Internal links that redirect", "Point each link straight at its final URL.", crawl.redirectingLinks.map(item =>
		`${ item.url } → ${ item.finalUrl } (${ item.hops } hop${ item.hops === 1 ? "" : "s" }), linked from ${ item.linkCount } page${ item.linkCount === 1 ? "" : "s" }, e.g. ${ item.linkedFrom.slice(0, 2).join(", ") }`));
	pushList(lines, "Duplicate titles", "Give each page its own title, unless the pages really are duplicates (then canonicalise them).", crawl.duplicateTitles.map(group =>
		`"${ group.value }" on ${ group.count } pages, e.g. ${ group.pages.slice(0, 3).join(", ") }`));
	pushList(lines, "Duplicate meta descriptions", "Write a description for each page, or generate one from its content.", crawl.duplicateDescriptions.map(group =>
		`"${ group.value.slice(0, 120) }" on ${ group.count } pages, e.g. ${ group.pages.slice(0, 3).join(", ") }`));
	pushList(lines, "Pages with no title", "Add a <title>.", crawl.missingTitles);
	pushList(lines, "Pages with no meta description", "Add a meta description, likely in the page template.", crawl.missingDescriptions);
	pushList(lines, "Pages with no H1", "Add one H1 describing the page.", crawl.missingH1);
	pushList(lines, "Sitemap entries that don't resolve cleanly", "Remove them from the sitemap or fix the pages; the sitemap should list only final, indexable URLs.", crawl.sitemapProblems.map(item =>
		`${ item.url } (${ item.error || (item.finalUrl !== item.url ? `redirects to ${ item.finalUrl }` : status(item.status, null)) })`));
	if (crawl.orphanPages) {
		pushList(lines, "Orphan pages", "These are in the sitemap but no page links to them. Link them from somewhere sensible, or drop them if they're obsolete.", crawl.orphanPages);
	}
}

function lighthouseSection(lines: string[], lighthouse: LighthouseResult) {
	const averages = Object.entries(lighthouse.categoryAverages)
		.filter(([, value]) => value)
		.map(([id, value]) => `${ CATEGORY_LABELS[id] } ${ percent(value!.average) } (lowest ${ percent(value!.min) })`);
	const where = lighthouse.engine === "pagespeed"
		? "Lighthouse ran on Google's PageSpeed Insights servers, so the scores match what pagespeed.web.dev reports."
		: "Performance was measured on a low-power box, so treat those numbers as relative.";
	lines.push("", "## Lighthouse findings", "", `Lighthouse ran on ${ lighthouse.routesScanned } sampled pages. Average scores: ${ averages.join(", ") }. ${ where }`);
	lighthouse.issues.forEach((issue, index) => {
		lines.push("", `### ${ index + 1 }. ${ issue.title } (${ CATEGORY_LABELS[issue.category] }, on ${ issue.pageCount } of ${ lighthouse.routesScanned } pages)`);
		if (issue.description) lines.push("", issue.description);
		lines.push("", `- **Pages:** ${ issue.pages.join(", ") }${ issue.pageCount > issue.pages.length ? ", …" : "" }`);
		if (issue.examples.length > 0) {
			lines.push("- **Where:**");
			for (const example of issue.examples) lines.push(`  - ${ example.text } (on ${ example.page })`);
		}
	});
}

export function buildSiteScanPrompt(scan: Scan): string {
	const lines = [
		`# Whole-site SEO fixes for ${ scan.site }`,
		"",
		`Scanned with free-seo's site scan on ${ (scan.finishedAt || scan.createdAt).slice(0, 10) }.`,
		"",
		"A crawl of the site above and Lighthouse runs on a sample of its pages found the problems below. Please work through them in this site's code:",
		"",
		"1. Check each finding against the actual code before changing anything. The scan only saw the live site from outside, so some findings may be wrong or may not apply.",
		"2. Many of these come from one shared template or layout. Fix the cause there rather than page by page.",
		"3. Fix broken links and missing pages first, then the rest.",
		"4. When you're done, list what you changed, and anything you skipped with the reason.",
	];
	if (scan.crawl) crawlSection(lines, scan.crawl);
	if (scan.lighthouse) lighthouseSection(lines, scan.lighthouse);
	if (countSiteScanProblems(scan) === 0) lines.push("", "No problems were found, so there is nothing to fix.");
	if (scan.crawl && scan.crawl.unverifiedExternal.length > 0) {
		lines.push("", "## Couldn't verify", "", `${ scan.crawl.unverifiedExternal.length } external links refused the scanner (HTTP 401/403/429 and similar, usually bot protection). They're probably fine; leave them unless you know otherwise.`);
	}
	return `${ lines.join("\n") }\n`;
}
