/**
 * The URL a source video is downloaded from (REELS-1124). Pure leaf: no I/O.
 *
 * - https only; share links of the two usual hosts are rewritten to their direct download.
 * - `isForbiddenAddress` is the SSRF rule applied AFTER the DNS lookup (download.ts): a public
 *   name pointing at a private address, or an internal docker name, is never fetched.
 */
import { ReelsError } from "./errors.js";

/** 6 GiB: a 2 h 1080p recording is 1-2 GB; three times that is not an interview. */
export const MAX_SOURCE_BYTES = 6 * 1024 * 1024 * 1024;

const DRIVE_FILE = /^\/file\/d\/([A-Za-z0-9_-]+)/;

/** The URL to fetch for `raw`, or SOURCE_URL_INVALID. */
export function resolveSourceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ReelsError("SOURCE_URL_INVALID", "sourceUrl is not a URL", 400);
  }
  if (url.protocol !== "https:") {
    throw new ReelsError("SOURCE_URL_INVALID", `sourceUrl must be https (got ${url.protocol.replace(":", "")})`, 400);
  }
  if (url.username || url.password) {
    throw new ReelsError("SOURCE_URL_INVALID", "sourceUrl must not carry credentials", 400);
  }
  const host = url.hostname.toLowerCase();

  if (host === "drive.google.com" || host === "docs.google.com") {
    const id = DRIVE_FILE.exec(url.pathname)?.[1] ?? ((url.pathname === "/open" || url.pathname === "/uc") ? url.searchParams.get("id") : null);
    if (id && /^[A-Za-z0-9_-]+$/.test(id)) {
      return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
    }
  }
  if (host === "dropbox.com" || host === "www.dropbox.com") {
    url.searchParams.set("dl", "1");
    return url.toString();
  }
  return url.toString();
}

function ipv4Forbidden(a: number, b: number): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 + TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved + broadcast
  );
}

/** True when `address` (an IP literal as dns.lookup returns it) must never be fetched. */
export function isForbiddenAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) return ipv4Forbidden(Number(v4[1]), Number(v4[2]));
  if (!ip.includes(":")) return true; // not an IP at all
  if (ip === "::" || ip === "::1") return true;
  // IPv4-mapped / -compatible (::ffff:a.b.c.d, ::ffff:hhhh:hhhh, 64:ff9b::a.b.c.d)
  const dotted = /:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (dotted) return ipv4Forbidden(Number(dotted[1]), Number(dotted[2]));
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(ip);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    return ipv4Forbidden(hi >> 8, hi & 0xff);
  }
  const first = parseInt(ip.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

const KNOWN_EXTENSIONS = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "mpg", "mpeg", "ts", "wmv", "flv"];
const TYPE_EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv", "video/x-msvideo": "avi", "video/mpeg": "mpg",
};

/** A safe extension for the stored file: the content-disposition name's, the URL path's, the content type's, else `bin` (ffprobe reads content, not names). */
export function sourceExtension(finalUrl: string, contentType: string | null, contentDisposition: string | null): string {
  const fromName = (name: string | undefined | null) => {
    const ext = /\.([A-Za-z0-9]{2,5})$/.exec(name ?? "")?.[1]?.toLowerCase();
    return ext && KNOWN_EXTENSIONS.includes(ext) ? ext : null;
  };
  const dispositionName = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition ?? "")?.[1];
  let pathName: string | null = null;
  try { pathName = new URL(finalUrl).pathname; } catch { /* keep null */ }
  return fromName(dispositionName) ?? fromName(pathName) ?? TYPE_EXTENSIONS[(contentType ?? "").split(";")[0].trim().toLowerCase()] ?? "bin";
}
