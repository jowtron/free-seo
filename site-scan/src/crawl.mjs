import * as cheerio from "cheerio";
import { fetchWithRedirects } from "./fetch.mjs";

// A deliberately small crawler: follows same-site links from the start page,
// then fills up from the sitemap, up to maxPages HTML pages. It records what a
// single-page audit can't see: links that break or redirect, titles and
// descriptions shared across pages, sitemap entries that don't resolve, and
// sitemap pages nothing links to.

const sameSite = (a, b) => a.replace(/^www\./, "") === b.replace(/^www\./, "");
const isHtml = contentType => /text\/html|application\/xhtml\+xml/i.test(contentType);
// Status codes that mean "the server refuses bots", not "the link is broken".
const BOT_BLOCK = new Set([401, 403, 405, 406, 429, 451, 999]);
const SKIP_EXTENSIONS = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|mp3|mp4|m4a|wav|ogg|webm|mov|woff2?|ttf|otf|css|js|json|xml|ics|txt)$/i;

function normalize(raw, base) {
	try {
		const url = new URL(raw, base);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		return url.href;
	} catch {
		return null;
	}
}

async function mapLimit(items, limit, fn) {
	let index = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (index < items.length) {
			const item = items[index++];
			await fn(item);
		}
	}));
}

function parseRobots(text) {
	const disallow = [];
	const sitemaps = [];
	let applies = false;
	for (const rawLine of String(text).split(/\r?\n/)) {
		const line = rawLine.replace(/#.*/, "").trim();
		const match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
		if (!match) continue;
		const [, key, value] = match;
		const field = key.toLowerCase();
		if (field === "sitemap") sitemaps.push(value);
		else if (field === "user-agent") applies = value === "*";
		else if (field === "disallow" && applies && value) disallow.push(value);
	}
	return { disallow, sitemaps };
}

async function readSitemaps(urls, limit, log) {
	const pages = [];
	const seen = new Set();
	const queue = [...urls];
	while (queue.length > 0 && pages.length < limit && seen.size < 50) {
		const sitemapUrl = queue.shift();
		if (seen.has(sitemapUrl)) continue;
		seen.add(sitemapUrl);
		try {
			const response = await fetchWithRedirects(sitemapUrl, { readBody: true, maxBytes: 20_000_000 });
			if (response.status !== 200) continue;
			const $ = cheerio.load(response.body, { xmlMode: true });
			$("sitemap > loc").each((_i, el) => { queue.push($(el).text().trim()); });
			$("url > loc").each((_i, el) => { if (pages.length < limit) pages.push($(el).text().trim()); });
		} catch (error) {
			log(`sitemap ${ sitemapUrl }: ${ error.message }`);
		}
	}
	return pages;
}

export async function crawlSite(startUrl, { maxPages = 300, maxExternal = 300, concurrency = 3, onProgress = () => {}, log = () => {} } = {}) {
	const start = new URL(startUrl);
	const host = start.hostname;
	const origin = start.origin;

	let robots = { disallow: [], sitemaps: [] };
	try {
		const response = await fetchWithRedirects(`${ origin }/robots.txt`, { readBody: true, maxBytes: 500_000 });
		if (response.status === 200) robots = parseRobots(response.body);
	} catch (error) {
		log(`robots.txt: ${ error.message }`);
	}
	const disallowed = url => {
		const path = new URL(url).pathname;
		return robots.disallow.some(rule => path.startsWith(rule.replace(/\*.*$/, "")));
	};
	const sitemapPages = await readSitemaps(robots.sitemaps.length > 0 ? robots.sitemaps : [`${ origin }/sitemap.xml`], 50_000, log);
	const sitemapSet = new Set(sitemapPages.map(url => normalize(url, origin)).filter(Boolean));

	const pages = new Map();      // url -> page record (HTML pages we fetched)
	const linkTargets = new Map(); // url -> { from: Set, kind: "internal"|"external"|"image" }
	const queued = new Set([start.href]);
	const queue = [start.href];
	let skippedByRobots = 0;

	const addLink = (target, from, kind) => {
		// Cloudflare's own endpoints (e.g. /cdn-cgi/l/email-protection, which page
		// JavaScript rewrites into a mailto:) 404 for anything but a browser.
		if (new URL(target).pathname.startsWith("/cdn-cgi/")) return;
		let entry = linkTargets.get(target);
		if (!entry) {
			entry = { from: new Set(), kind };
			linkTargets.set(target, entry);
		}
		entry.from.add(from);
	};

	const visit = async (url) => {
		const record = { url, status: null, finalUrl: url, redirects: [], error: null, title: null, description: null, canonical: null, noindex: false, h1Count: 0 };
		pages.set(url, record);
		try {
			const response = await fetchWithRedirects(url, { readBody: true });
			record.status = response.status;
			record.finalUrl = response.url;
			record.redirects = response.chain;
			record.error = response.error;
			if (response.status !== 200 || !isHtml(response.contentType)) {
				record.html = false;
				return;
			}
			record.html = true;
			const $ = cheerio.load(response.body);
			record.title = $("head > title").first().text().trim() || null;
			record.description = $('meta[name="description" i]').attr("content")?.trim() || null;
			record.canonical = normalize($('link[rel="canonical" i]').attr("href") || "", response.url);
			record.noindex = /noindex/i.test($('meta[name="robots" i]').attr("content") || "");
			record.h1Count = $("h1").length;
			$("a[href]").each((_i, el) => {
				const target = normalize($(el).attr("href"), response.url);
				if (!target) return;
				const internal = sameSite(new URL(target).hostname, host);
				addLink(target, url, internal ? "internal" : "external");
				if (internal && !queued.has(target) && !SKIP_EXTENSIONS.test(new URL(target).pathname)) {
					if (disallowed(target)) {
						skippedByRobots += 1;
						return;
					}
					queued.add(target);
					queue.push(target);
				}
			});
			$("img[src]").each((_i, el) => {
				const target = normalize($(el).attr("src"), response.url);
				if (target && sameSite(new URL(target).hostname, host)) addLink(target, url, "image");
			});
		} catch (error) {
			record.error = error.message;
		}
	};

	// Breadth-first from the start page; sitemap URLs join the end of the queue so
	// linked pages are covered first and the sitemap fills any remaining budget.
	let sitemapIndex = 0;
	while (pages.size < maxPages) {
		if (queue.length === 0) {
			while (sitemapIndex < sitemapPages.length && queue.length < concurrency * 4) {
				const url = normalize(sitemapPages[sitemapIndex++], origin);
				if (url && !queued.has(url) && sameSite(new URL(url).hostname, host)) {
					queued.add(url);
					queue.push(url);
				}
			}
			if (queue.length === 0) break;
		}
		const batch = queue.splice(0, Math.min(concurrency, maxPages - pages.size));
		await Promise.all(batch.map(visit));
		onProgress({ phase: "crawl", crawled: pages.size, queued: queue.length });
	}
	const crawlComplete = queue.length === 0 && sitemapIndex >= sitemapPages.length;

	// Check links we didn't crawl as pages: images, files, external links.
	const unchecked = [...linkTargets.entries()].filter(([url]) => !pages.has(url));
	const internalTargets = unchecked.filter(([, entry]) => entry.kind !== "external");
	const externalTargets = unchecked.filter(([, entry]) => entry.kind === "external").slice(0, maxExternal);
	const checked = new Map();
	const check = async ([url]) => {
		try {
			const response = await fetchWithRedirects(url, { timeoutMs: 10_000 });
			checked.set(url, { status: response.status, finalUrl: response.url, redirects: response.chain, error: response.error });
		} catch (error) {
			checked.set(url, { status: null, finalUrl: url, redirects: [], error: error.message });
		}
	};
	await mapLimit(internalTargets, concurrency, check);
	onProgress({ phase: "links", crawled: pages.size, queued: 0 });
	await mapLimit(externalTargets, 4, check);

	const resultFor = url => pages.get(url) || checked.get(url);
	const examplesFrom = entry => [...entry.from].slice(0, 5);
	const brokenInternal = [];
	const brokenExternal = [];
	const unverifiedExternal = [];
	const redirectingLinks = [];
	for (const [url, entry] of linkTargets) {
		const result = resultFor(url);
		if (!result) continue;
		const item = { url, status: result.status, error: result.error, linkedFrom: examplesFrom(entry), linkCount: entry.from.size };
		const external = entry.kind === "external";
		if (result.status !== null && result.status >= 200 && result.status < 300) {
			if (!external && result.redirects.length > 0) {
				redirectingLinks.push({ ...item, finalUrl: result.finalUrl, hops: result.redirects.length });
			}
		} else if (external && result.status !== null && BOT_BLOCK.has(result.status)) {
			unverifiedExternal.push(item);
		} else {
			(external ? brokenExternal : brokenInternal).push(item);
		}
	}

	const htmlPages = [...pages.values()].filter(page => page.html);
	const groupBy = (field) => {
		const groups = new Map();
		for (const page of htmlPages) {
			const value = page[field];
			if (!value || page.noindex) continue;
			// Pages that canonicalise elsewhere are meant to duplicate their target.
			if (page.canonical && page.canonical !== page.finalUrl) continue;
			if (!groups.has(value)) groups.set(value, []);
			groups.get(value).push(page.finalUrl);
		}
		return [...groups.entries()].filter(([, urls]) => urls.length > 1)
			.map(([value, urls]) => ({ value, count: urls.length, pages: urls.slice(0, 10) }))
			.sort((a, b) => b.count - a.count);
	};

	const linkedInternally = new Set([...linkTargets.entries()].filter(([, entry]) => entry.kind === "internal").map(([url]) => url));
	const sitemapProblems = [];
	for (const url of sitemapSet) {
		const result = resultFor(url);
		if (!result) continue;
		if (result.status !== 200 || result.redirects.length > 0) {
			sitemapProblems.push({ url, status: result.status, finalUrl: result.finalUrl, error: result.error });
		} else if (pages.get(url)?.noindex) {
			sitemapProblems.push({ url, status: result.status, finalUrl: result.finalUrl, error: "Listed in the sitemap but marked noindex" });
		}
	}

	const sortByLinks = list => list.sort((a, b) => b.linkCount - a.linkCount);
	return {
		origin,
		pagesCrawled: pages.size,
		htmlPages: htmlPages.length,
		sitemapUrls: sitemapSet.size,
		crawlComplete,
		skippedByRobots,
		externalChecked: externalTargets.length,
		externalTotal: unchecked.filter(([, entry]) => entry.kind === "external").length,
		brokenInternal: sortByLinks(brokenInternal),
		brokenExternal: sortByLinks(brokenExternal),
		unverifiedExternal: sortByLinks(unverifiedExternal),
		redirectingLinks: sortByLinks(redirectingLinks),
		duplicateTitles: groupBy("title"),
		duplicateDescriptions: groupBy("description"),
		missingTitles: htmlPages.filter(page => !page.title).map(page => page.finalUrl),
		missingDescriptions: htmlPages.filter(page => !page.description && !page.noindex).map(page => page.finalUrl),
		missingH1: htmlPages.filter(page => page.h1Count === 0).map(page => page.finalUrl),
		noindexPages: htmlPages.filter(page => page.noindex).map(page => page.finalUrl),
		sitemapProblems,
		// Only meaningful when the crawl reached every page it could find.
		orphanPages: crawlComplete
			? [...sitemapSet].filter(url => !linkedInternally.has(url) && url !== start.href && pages.get(url)?.status === 200)
			: null,
		// Indexable pages in crawl order, for sampling Lighthouse pages. jobs.mjs
		// takes this off before saving, so it never lands in job.json.
		samplePool: [...new Set(htmlPages
			.filter(page => !page.noindex && (!page.canonical || page.canonical === page.finalUrl) && new URL(page.finalUrl).origin === origin)
			.map(page => page.finalUrl))],
	};
}
