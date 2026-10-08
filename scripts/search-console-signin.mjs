#!/usr/bin/env node
// One-time Google sign-in for free-seo's Search Console section.
//
//   node scripts/search-console-signin.mjs <client_secret_….json> <ssh-target> [env-file]
//
// Reads the OAuth "Desktop app" client file downloaded from Google Cloud, opens
// Google's sign-in in the browser (loopback redirect + PKCE), and writes
// GSC_CLIENT_ID, GSC_CLIENT_SECRET and GSC_REFRESH_TOKEN into the server's env
// file over SSH (default /etc/free-seo/free-seo.env, via sudo). The values go
// over SSH stdin, never on a command line, and are never printed. Re-running it
// replaces the old GSC_ lines. Scope: webmasters.readonly (read-only).

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";

const [clientFile, sshTarget, envFile = "/etc/free-seo/free-seo.env"] = process.argv.slice(2);
if (!clientFile || !sshTarget) {
	console.error("Usage: node scripts/search-console-signin.mjs <client_secret_….json> <ssh-target> [env-file]");
	process.exit(2);
}

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const client = JSON.parse(fs.readFileSync(clientFile, "utf8")).installed;
if (!client?.client_id || !client?.client_secret) {
	console.error("That file isn't a Desktop app OAuth client (no \"installed\" section).");
	process.exit(1);
}

const verifier = crypto.randomBytes(48).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const state = crypto.randomBytes(16).toString("hex");

// Wait for Google to redirect the browser back to a loopback port.
let redirectUri;
const code = await new Promise((resolve, reject) => {
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		if (url.pathname !== "/") return res.writeHead(404).end();
		const error = url.searchParams.get("error");
		const ok = !error && url.searchParams.get("state") === state && url.searchParams.get("code");
		res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8" });
		res.end(ok ? "Signed in. You can close this tab and go back to the terminal." : `Sign-in failed: ${ error || "bad state" }`);
		server.close();
		if (ok) resolve(url.searchParams.get("code"));
		else reject(new Error(`Sign-in failed: ${ error || "the state didn't match" }`));
	});
	server.listen(0, "127.0.0.1", () => {
		redirectUri = `http://127.0.0.1:${ server.address().port }/`;
		const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		auth.search = new URLSearchParams({
			client_id: client.client_id,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: SCOPE,
			access_type: "offline",
			prompt: "consent",
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		});
		console.log("Opening Google sign-in in your browser…");
		console.log("If it warns that Google hasn't verified this app: Advanced → Go to free-seo (unsafe) → Continue.");
		spawn("open", [auth.href], { stdio: "ignore" });
		setTimeout(() => { server.close(); reject(new Error("Timed out after 5 minutes waiting for the sign-in.")); }, 5 * 60 * 1000).unref();
	});
});

const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
	method: "POST",
	headers: { "Content-Type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({
		code,
		client_id: client.client_id,
		client_secret: client.client_secret,
		redirect_uri: redirectUri,
		grant_type: "authorization_code",
		code_verifier: verifier,
	}),
});
const tokens = await tokenResponse.json();
if (!tokenResponse.ok || !tokens.refresh_token) {
	console.error(`Google didn't return a refresh token: ${ tokens.error_description || tokens.error || tokenResponse.status }`);
	process.exit(1);
}

// Prove the token works before saving it.
const sitesResponse = await fetch("https://searchconsole.googleapis.com/webmasters/v3/sites", {
	headers: { Authorization: `Bearer ${ tokens.access_token }` },
});
const sites = await sitesResponse.json();
if (!sitesResponse.ok) {
	console.error(`Signed in, but Search Console refused: ${ sites.error?.message || sitesResponse.status }`);
	process.exit(1);
}
const entries = sites.siteEntry ?? [];
console.log(`Signed in. Search Console lists ${ entries.length } properties for this account:`);
for (const entry of entries) console.log(`  ${ entry.siteUrl }  (${ entry.permissionLevel })`);

// Replace any old GSC_ lines in the env file; keep a backup of the previous one.
const lines = [
	"# Google Search Console (read-only), written by scripts/search-console-signin.mjs",
	`GSC_CLIENT_ID=${ client.client_id }`,
	`GSC_CLIENT_SECRET=${ client.client_secret }`,
	`GSC_REFRESH_TOKEN=${ tokens.refresh_token }`,
	"",
].join("\n");
const remote = `sudo sh -c 'set -e; umask 077; f=${ envFile }; cp -p "$f" "$f.bak-gsc"; grep -v -e "^GSC_" -e "^# Google Search Console (read-only)" "$f" > "$f.new" || true; cat >> "$f.new"; chmod 600 "$f.new"; mv "$f.new" "$f"'`;
await new Promise((resolve, reject) => {
	const child = spawn("ssh", ["-o", "ConnectTimeout=15", sshTarget, remote], { stdio: ["pipe", "inherit", "inherit"] });
	child.on("error", reject);
	child.on("close", code => (code === 0 ? resolve() : reject(new Error(`Writing ${ envFile } on ${ sshTarget } failed (ssh exit ${ code })`))));
	child.stdin.end(lines);
});
console.log(`Saved to ${ envFile } on ${ sshTarget } (previous copy at ${ envFile }.bak-gsc).`);
console.log(`You can delete ${ clientFile } now: the box has what it needs.`);
