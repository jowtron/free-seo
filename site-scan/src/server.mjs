import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { JobStore } from "./jobs.mjs";
import { assertPublicUrl } from "./urlSafety.mjs";

const PORT = Number(process.env.PORT || 8096);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.SITE_SCAN_DATA || "/data";
// Origins allowed to call the API from a browser (the free-seo front end).
const ALLOWED_ORIGINS = new Set((process.env.SITE_SCAN_ALLOWED_ORIGINS || "").split(",").map(origin => origin.trim()).filter(Boolean));
const LIMITS = {
	crawlPages: { default: 300, max: 2000 },
	lighthousePages: { default: 20, max: 100 },
};

const store = new JobStore(DATA_DIR);
await store.load();

const MIME = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".json": "application/json", ".svg": "image/svg+xml", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png",
	".webp": "image/webp", ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

function send(res, status, body, headers = {}) {
	const payload = typeof body === "string" ? body : JSON.stringify(body);
	res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store", ...headers });
	res.end(payload);
}

function clampInt(value, { default: fallback, max }) {
	const number = Number.parseInt(value, 10);
	if (!Number.isFinite(number)) return fallback;
	return Math.max(0, Math.min(max, number));
}

async function readJson(req) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 16_384) throw Object.assign(new Error("Request too large."), { statusCode: 413 });
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	} catch {
		throw Object.assign(new Error("Body must be JSON."), { statusCode: 400 });
	}
}

// Serves the static Unlighthouse report for one scan. Paths are resolved and
// checked against the scan's report directory so ../ can't escape it.
function serveReport(res, id, rest) {
	if (!/^[\w-]+$/.test(id)) return send(res, 404, "Not found");
	const root = path.join(store.dir(id), "report");
	const target = path.resolve(root, decodeURIComponent(rest || "index.html"));
	if (target !== root && !target.startsWith(root + path.sep)) return send(res, 404, "Not found");
	let file = target;
	try {
		if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
	} catch {
		// Unlighthouse's client routes (e.g. /about/) aren't files: fall back to its index.
		file = path.join(root, "index.html");
	}
	fs.stat(file, (error, stat) => {
		if (error || !stat.isFile()) return send(res, 404, "Not found");
		res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Content-Length": stat.size, "Cache-Control": "private, max-age=3600" });
		fs.createReadStream(file).pipe(res);
	});
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	const origin = req.headers.origin;
	const cors = origin && ALLOWED_ORIGINS.has(origin)
		? { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" }
		: {};
	for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);

	try {
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			return res.end();
		}
		if (url.pathname === "/healthz") return send(res, 200, { ok: true, running: store.running, queued: store.queue.length });

		if (url.pathname === "/api/scans" && req.method === "GET") {
			const site = url.searchParams.get("site");
			return send(res, 200, { scans: store.list(site) });
		}
		if (url.pathname === "/api/scans" && req.method === "POST") {
			const body = await readJson(req);
			let site;
			try {
				site = (await assertPublicUrl(body.url)).origin + "/";
			} catch (error) {
				return send(res, 400, { error: error.message });
			}
			const job = await store.create(site, {
				crawlPages: clampInt(body.crawlPages, LIMITS.crawlPages),
				lighthousePages: clampInt(body.lighthousePages, LIMITS.lighthousePages),
				device: body.device === "desktop" ? "desktop" : "mobile",
			});
			return send(res, 202, { id: job.id, status: job.status });
		}
		const scanMatch = url.pathname.match(/^\/api\/scans\/([\w-]+)$/);
		if (scanMatch && req.method === "GET") {
			const job = store.get(scanMatch[1]);
			if (!job) return send(res, 404, { error: "No such scan." });
			const queuePosition = store.queue.indexOf(job.id);
			return send(res, 200, {
				...job,
				queuePosition: queuePosition === -1 ? null : queuePosition + 1,
				reportPath: job.lighthouse ? `/scans/${ job.id }/report/` : null,
			});
		}
		const reportMatch = url.pathname.match(/^\/scans\/([\w-]+)\/report(?:\/(.*))?$/);
		if (reportMatch && req.method === "GET") {
			if (reportMatch[2] === undefined) return send(res, 301, "", { Location: `${ url.pathname }/` });
			return serveReport(res, reportMatch[1], reportMatch[2]);
		}
		return send(res, 404, { error: "Not found." });
	} catch (error) {
		console.error(error);
		return send(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Internal error." });
	}
});

server.listen(PORT, HOST, () => {
	console.log(`site-scan listening on ${ HOST }:${ PORT }, data in ${ DATA_DIR }, CORS: ${ [...ALLOWED_ORIGINS].join(", ") || "(none)" }`);
});
