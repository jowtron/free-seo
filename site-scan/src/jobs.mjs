import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { crawlSite } from "./crawl.mjs";
import { runLighthouse } from "./lighthouse.mjs";

// One scan at a time: the box is a 4-core Celeron shared with a TV kiosk, and
// Lighthouse timings are meaningless when two Chromiums fight for the CPU.
const MAX_QUEUED = 5;
const KEEP_SCANS = Number(process.env.SITE_SCAN_KEEP || 30);

export class JobStore {
	constructor(dataDir) {
		this.dataDir = dataDir;
		this.jobs = new Map();
		this.queue = [];
		this.running = null;
	}

	dir(id) {
		return path.join(this.dataDir, "scans", id);
	}

	async load() {
		await fs.mkdir(path.join(this.dataDir, "scans"), { recursive: true });
		for (const id of await fs.readdir(path.join(this.dataDir, "scans"))) {
			try {
				const job = JSON.parse(await fs.readFile(path.join(this.dir(id), "job.json"), "utf8"));
				if (job.status === "queued" || job.status === "running") {
					job.status = "failed";
					job.error = "Interrupted by a restart of the scan service.";
					job.finishedAt = new Date().toISOString();
					await this.save(job);
				}
				this.jobs.set(job.id, job);
			} catch {
				// A half-written scan directory; ignore it.
			}
		}
	}

	async save(job) {
		await fs.mkdir(this.dir(job.id), { recursive: true });
		const file = path.join(this.dir(job.id), "job.json");
		await fs.writeFile(`${ file }.tmp`, JSON.stringify(job));
		await fs.rename(`${ file }.tmp`, file);
	}

	list(site) {
		return [...this.jobs.values()]
			.filter(job => !site || job.site === site)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map(({ id, site, status, phase, createdAt, finishedAt, options, error }) => ({ id, site, status, phase, createdAt, finishedAt, options, error }));
	}

	get(id) {
		return this.jobs.get(id) || null;
	}

	async create(site, options) {
		const active = [...this.jobs.values()].find(job => job.site === site && (job.status === "queued" || job.status === "running"));
		if (active) return active;
		if (this.queue.length >= MAX_QUEUED) {
			throw Object.assign(new Error("The scan queue is full. Try again later."), { statusCode: 429 });
		}
		const job = {
			id: `${ new Date().toISOString().slice(0, 10) }-${ crypto.randomBytes(4).toString("hex") }`,
			site,
			options,
			status: "queued",
			phase: null,
			progress: null,
			createdAt: new Date().toISOString(),
			startedAt: null,
			finishedAt: null,
			error: null,
			crawl: null,
			lighthouse: null,
			lighthouseError: null,
		};
		this.jobs.set(job.id, job);
		this.queue.push(job.id);
		await this.save(job);
		this.pump();
		return job;
	}

	pump() {
		if (this.running || this.queue.length === 0) return;
		const job = this.jobs.get(this.queue.shift());
		this.running = job.id;
		this.run(job)
			.catch(error => {
				job.status = "failed";
				job.error = error.message;
			})
			.finally(async () => {
				job.finishedAt = new Date().toISOString();
				job.phase = null;
				await this.save(job).catch(() => {});
				this.running = null;
				await this.prune().catch(() => {});
				this.pump();
			});
	}

	async run(job) {
		const log = line => console.log(`[${ job.id }] ${ line }`);
		job.status = "running";
		job.startedAt = new Date().toISOString();
		const progress = async (update) => {
			job.phase = update.phase;
			job.progress = update;
			await this.save(job).catch(() => {});
		};

		await progress({ phase: "crawl", crawled: 0, queued: 1 });
		job.crawl = await crawlSite(job.site, { maxPages: job.options.crawlPages, onProgress: progress, log });
		await this.save(job);

		if (job.options.lighthousePages > 0) {
			await progress({ phase: "lighthouse", done: 0, total: job.options.lighthousePages });
			try {
				job.lighthouse = await runLighthouse({
					site: job.site,
					outDir: path.join(this.dir(job.id), "report"),
					routerPrefix: `/scans/${ job.id }/report/`,
					maxRoutes: job.options.lighthousePages,
					device: job.options.device,
					onProgress: progress,
					log,
				});
			} catch (error) {
				// Keep the crawl results; report the Lighthouse half as failed.
				job.lighthouseError = error.message;
			}
		}
		job.status = "done";
	}

	async prune() {
		const finished = [...this.jobs.values()]
			.filter(job => job.status === "done" || job.status === "failed")
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		for (const job of finished.slice(KEEP_SCANS)) {
			await fs.rm(this.dir(job.id), { recursive: true, force: true });
			this.jobs.delete(job.id);
		}
	}
}
