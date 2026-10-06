# site-scan

Whole-site scan service for free-seo. free-seo audits one URL; this covers the site:

- **Unlighthouse**: Lighthouse (performance, accessibility, best practices, SEO) on up to 100 pages, sampled by route pattern, with Unlighthouse's own static report kept for each scan. Failing audits are rolled up site-wide with the pages they affect and the elements or files responsible.
- **Crawl**: follows same-site links from the start page, then fills up from the sitemap (default 300 pages). Reports broken internal and external links with the pages that link to them, internal links that redirect, duplicate titles and descriptions, missing titles/descriptions/H1s, noindex pages, sitemap entries that don't resolve, and (when the crawl finishes) sitemap pages nothing links to.

One scan runs at a time, with up to 5 queued. Results persist in `/data/scans/<id>/` and the newest 30 are kept.

## API

- `POST /api/scans` `{ "url": "https://example.com/", "crawlPages": 300, "lighthousePages": 20, "device": "mobile" }` → `202 { id }`. A scan already queued or running for the same site is returned instead of a new one.
- `GET /api/scans/<id>` → status (`queued`, `running`, `done`, `failed`), phase, progress, `crawl`, `lighthouse`, `reportPath`.
- `GET /api/scans?site=https://example.com/` → recent scans.
- `GET /scans/<id>/report/` → the Unlighthouse report.
- `GET /healthz`

## Settings

| Variable | Default | |
|---|---|---|
| `SITE_SCAN_ALLOWED_ORIGINS` | none | Comma-separated origins allowed to call the API from a browser (the free-seo front end) |
| `SITE_SCAN_DATA` | `/data` | |
| `SITE_SCAN_KEEP` | `30` | Scans to keep |
| `SITE_SCAN_DISABLE_SANDBOX` | `--no-sandbox` on | Set to `0` only where Chromium's sandbox can start (it needs `CAP_SYS_CHROOT`) |
| `PORT` / `HOST` | `8096` / `0.0.0.0` | |

## ⚠️ Run it behind an egress fence

It loads whatever site it's given in a real browser. The URL check in `src/urlSafety.mjs` rejects private addresses for clean errors, but Chromium resolves names itself, so DNS rebinding can get past it. The real boundary has to be the network: give the container its own network and drop everything from it to RFC1918, CGNAT/tailnet (100.64/10), link-local, loopback, ULA and the host itself. Our deployment does that with an nft table keyed on the container network's interface.

## Build

```
podman build -t site-scan site-scan/
```
