import dns from "node:dns/promises";
import net from "node:net";

// Application-level check, for clean error messages only. The real boundary is
// the nft fence around the container (scan-guard): Chromium resolves names on
// its own, so a DNS-rebinding page could still pass this check and then point
// at a private address. The fence drops that; this just stops the obvious cases
// from ever starting a scan.
const blocked = new net.BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
	["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
	["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
	["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64],
	["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blocked.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address) {
	// IPv4-mapped IPv6 (::ffff:10.0.0.1): judge the IPv4 inside. Not done with a
	// ::ffff:0:0/96 rule, because BlockList applies that to every plain IPv4 too.
	const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
	if (mapped) return isPublicAddress(mapped[1]);
	const mappedHex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (mappedHex) {
		const high = Number.parseInt(mappedHex[1], 16);
		const low = Number.parseInt(mappedHex[2], 16);
		return isPublicAddress(`${ high >> 8 }.${ high & 255 }.${ low >> 8 }.${ low & 255 }`);
	}
	const family = net.isIP(address);
	if (family === 0) return false;
	return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export async function assertPublicUrl(input) {
	let url;
	try {
		url = input instanceof URL ? new URL(input.href) : new URL(String(input));
	} catch {
		throw new Error("Not a valid URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only http and https URLs can be scanned.");
	}
	if (url.username || url.password) {
		throw new Error("URLs with credentials can't be scanned.");
	}
	if (url.port && url.port !== "80" && url.port !== "443") {
		throw new Error("Only the standard ports (80 and 443) can be scanned.");
	}
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".ts.net")) {
		throw new Error("That host isn't public.");
	}
	const addresses = net.isIP(host)
		? [host]
		: (await dns.lookup(host, { all: true, verbatim: true }).catch(() => [])).map(entry => entry.address);
	if (addresses.length === 0) {
		throw new Error(`Couldn't resolve ${ host }.`);
	}
	if (!addresses.every(isPublicAddress)) {
		throw new Error("That host resolves to a private address.");
	}
	url.hash = "";
	return url;
}
