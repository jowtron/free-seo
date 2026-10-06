import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "../node_modules/@unlighthouse/cli/bin/unlighthouse-ci.mjs");
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
const SKIP_MODES = new Set(["informative", "notApplicable", "manual", "error"]);

async function countReports(dir) {
	let count = 0;
	const walk = async (current) => {
		for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
			if (entry.isDirectory()) await walk(path.join(current, entry.name));
			else if (entry.name === "lighthouse.html") count += 1;
		}
	};
	await walk(dir);
	return count;
}

// Runs unlighthouse-ci as a child process, so a Chromium crash or hang takes
// down only that process. Writes the static Unlighthouse report into outDir.
export async function runLighthouse({ site, outDir, routerPrefix, maxRoutes, device, onProgress = () => {}, log = () => {}, timeoutMs = 3 * 60 * 60 * 1000 }) {
	await fs.mkdir(outDir, { recursive: true });
	const config = {
		site,
		outputPath: outDir,
		routerPrefix,
		cache: false,
		scanner: { maxRoutes, samples: 1, device, dynamicSampling: 5, throttle: true },
		chrome: { useSystem: true, useDownloadFallback: false },
		puppeteerOptions: {
			executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
			headless: true,
			// Chromium's own sandbox can't start without CAP_SYS_CHROOT, which the
			// container drops. The nft fence and the user namespace are the boundary.
			args: process.env.SITE_SCAN_DISABLE_SANDBOX === "0" ? ["--disable-dev-shm-usage"] : ["--no-sandbox", "--disable-dev-shm-usage"],
		},
		puppeteerClusterOptions: { maxConcurrency: 1, timeout: 5 * 60 * 1000 },
		ci: { reporter: "jsonExpanded", buildStatic: true, budget: 0 },
	};
	const configPath = path.join(outDir, "..", "unlighthouse.config.mjs");
	await fs.writeFile(configPath, `export default ${ JSON.stringify(config, null, 2) };\n`);

	const child = spawn(process.execPath, [CLI, "--config-file", configPath], {
		cwd: path.dirname(configPath),
		env: { ...process.env, CI: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const tail = [];
	const keep = chunk => {
		for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
			tail.push(line);
			if (tail.length > 40) tail.shift();
			log(line);
		}
	};
	child.stdout.on("data", keep);
	child.stderr.on("data", keep);
	const progress = setInterval(async () => {
		onProgress({ phase: "lighthouse", done: await countReports(path.join(outDir, "reports")), total: maxRoutes });
	}, 10_000);
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	const code = await new Promise(resolve => child.on("close", resolve));
	clearInterval(progress);
	clearTimeout(timer);
	if (code !== 0) {
		throw new Error(`Unlighthouse exited with code ${ code }: ${ tail.slice(-5).join(" | ") }`);
	}
	return summarize(outDir);
}

function extractLighthouseJson(html) {
	const match = html.match(/window\.__LIGHTHOUSE_JSON__ = (\{.*?\});<\/script>/s);
	return match ? JSON.parse(match[1]) : null;
}

// One short, human-readable pointer per detail item: the element or file.
function describeItem(item) {
	if (!item || typeof item !== "object") return null;
	if (item.node?.selector) return item.node.snippet ? `${ item.node.selector} — ${ item.node.snippet.slice(0, 160) }` : item.node.selector;
	if (typeof item.url === "string") return item.url;
	if (typeof item.source?.url === "string") return item.source.url;
	if (item.node?.nodeLabel) return item.node.nodeLabel;
	return null;
}

// Local runs: Unlighthouse's own result list, plus the full report extracted
// from each page's lighthouse.html (its payload.js keeps only 20 audits).
export async function summarize(outDir) {
	const result = JSON.parse(await fs.readFile(path.join(outDir, "ci-result.json"), "utf8"));
	const reportsDir = path.join(outDir, "reports");
	const entries = [];
	for (const route of result.routes || []) {
		const routeDir = route.path === "/" ? reportsDir : path.join(reportsDir, route.path.replace(/^\/|\/$/g, ""));
		const html = await fs.readFile(path.join(routeDir, "lighthouse.html"), "utf8").catch(() => null);
		entries.push({
			path: route.path,
			report: html ? extractLighthouseJson(html) : null,
			fallback: {
				categories: Object.fromEntries(CATEGORIES.map(id => [id, route.categories?.[id]?.score ?? null])),
				lcp: route.metrics?.["largest-contentful-paint"]?.displayValue ?? null,
				cls: route.metrics?.["cumulative-layout-shift"]?.displayValue ?? null,
			},
		});
	}
	return { engine: "local", ...summarizeReports(entries) };
}

// Rolls full Lighthouse reports up into site-wide scores and failing audits.
// entries: [{ path, report, fallback? }], where report is a Lighthouse result
// (LHR) or null, and fallback supplies scores when the report is missing.
export function summarizeReports(entries) {
	const routes = [];
	const audits = new Map();
	let benchmarkIndex = null;

	for (const { path: routePath, report, fallback } of entries) {
		const categories = report
			? Object.fromEntries(CATEGORIES.map(id => [id, report.categories?.[id]?.score ?? null]))
			: fallback?.categories ?? Object.fromEntries(CATEGORIES.map(id => [id, null]));
		const scores = Object.values(categories).filter(score => typeof score === "number");
		routes.push({
			path: routePath,
			score: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
			categories,
			lcp: report ? report.audits?.["largest-contentful-paint"]?.displayValue ?? null : fallback?.lcp ?? null,
			cls: report ? report.audits?.["cumulative-layout-shift"]?.displayValue ?? null : fallback?.cls ?? null,
		});
		if (!report) continue;
		benchmarkIndex ??= report.environment?.benchmarkIndex ?? null;
		const categoryOf = new Map();
		for (const id of CATEGORIES) {
			for (const ref of report.categories?.[id]?.auditRefs || []) {
				if (ref.weight > 0 || !categoryOf.has(ref.id)) categoryOf.set(ref.id, id);
			}
		}
		for (const audit of Object.values(report.audits || {})) {
			if (audit.score === null || audit.score === undefined || audit.score >= 0.9) continue;
			if (SKIP_MODES.has(audit.scoreDisplayMode) || !categoryOf.has(audit.id)) continue;
			let entry = audits.get(audit.id);
			if (!entry) {
				entry = {
					id: audit.id,
					title: audit.title,
					description: audit.description?.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").slice(0, 400) ?? "",
					category: categoryOf.get(audit.id),
					worstScore: audit.score,
					pages: [],
					examples: [],
				};
				audits.set(audit.id, entry);
			}
			entry.worstScore = Math.min(entry.worstScore, audit.score);
			entry.pages.push(routePath);
			for (const item of audit.details?.items || []) {
				const text = describeItem(item);
				if (text && entry.examples.length < 5 && !entry.examples.some(example => example.text === text)) {
					entry.examples.push({ page: routePath, text });
				}
			}
		}
	}

	const categoryAverages = Object.fromEntries(CATEGORIES.map(id => {
		const scores = routes.map(route => route.categories[id]).filter(score => typeof score === "number");
		return [id, scores.length === 0 ? null : {
			average: scores.reduce((sum, score) => sum + score, 0) / scores.length,
			min: Math.min(...scores),
		}];
	}));

	return {
		routesScanned: routes.length,
		benchmarkIndex,
		categoryAverages,
		routes: routes.sort((a, b) => (a.categories.performance ?? 1) - (b.categories.performance ?? 1)),
		issues: [...audits.values()]
			.map(entry => ({ ...entry, pageCount: entry.pages.length, pages: entry.pages.slice(0, 10) }))
			.sort((a, b) => b.pageCount - a.pageCount || a.worstScore - b.worstScore),
	};
}
