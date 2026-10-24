import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";

export const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Permit only global unicast IPv6; reject mapped IPv4, local, multicast,
  // documentation and transition ranges. DNS addresses are pinned below.
  if (version === 6) return /^[23]/i.test(address) && !/^2001:(?:db8|0|10|20):/i.test(address) && !/^2002:/i.test(address);
  return false;
}

export function validateDocumentUrl(input: string, apiOrigin: string, extraOrigins: string[] = []): URL {
  let url: URL;
  try { url = new URL(input, apiOrigin); } catch { throw new Error("Invalid document URL"); }
  const allowed = new Set([new URL(apiOrigin).origin, ...extraOrigins.map(value => new URL(value).origin)]);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || !allowed.has(url.origin))
    throw new Error("Document origin is not allowed; configure an exact trusted HTTPS origin if Xledger uses external file storage");
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("IP literal document hosts are not allowed");
  return url;
}

/** Only URLs supplied by a scoped Xledger invoice are passed here. Never user URLs.
 * No API/OAuth credentials are sent to files, including on redirects. */
export async function downloadInvoiceDocument(input: string, options: { apiOrigin: string; extraOrigins?: string[] }): Promise<Buffer> {
  const deadline = Date.now() + 25_000;
  let next = input;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const url = validateDocumentUrl(next, options.apiOrigin, options.extraOrigins);
    const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Document DNS lookup timed out")), Math.max(1, deadline - Date.now()));
      lookup(url.hostname, { all: true }).then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(new Error("Document host could not be resolved")); });
    });
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error("Document host resolves to a disallowed network address");
    const pinned = addresses[0];
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Document download timed out");
    const response = await new Promise<{ redirect?: string; bytes?: Buffer }>((resolve, reject) => {
      const req = request(url, { method: "GET", headers: { Accept: "application/pdf, application/xml, text/xml, application/octet-stream", "Accept-Encoding": "identity" },
        family: pinned.family,
        // A fixed lookup prevents DNS rebinding between validation and connect.
        lookup: ((_host: string, _options: unknown, callback: any) => callback(null, pinned.address, pinned.family)) as any,
      }, res => {
        const code = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(code)) {
          const location = res.headers.location;
          res.resume();
          if (!location) reject(new Error("Document redirect has no location"));
          else resolve({ redirect: new URL(location, url).href });
          return;
        }
        if (code !== 200) { res.resume(); reject(new Error(`Document download returned HTTP ${code}`)); return; }
        if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") { res.destroy(); reject(new Error("Compressed HTTP document responses are not accepted")); return; }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > MAX_DOCUMENT_BYTES) { res.destroy(); reject(new Error("Document exceeds the 30 MiB limit")); return; }
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_DOCUMENT_BYTES) { res.destroy(); reject(new Error("Document exceeds the 30 MiB limit")); }
          else chunks.push(chunk);
        });
        res.on("error", () => reject(new Error("Document download failed")));
        res.on("end", () => resolve({ bytes: Buffer.concat(chunks) }));
      });
      const timer = setTimeout(() => req.destroy(new Error("Document download timed out")), remaining);
      req.once("close", () => clearTimeout(timer));
      req.once("error", error => reject(new Error(error.message === "Document download timed out" ? error.message : "Document download failed")));
      req.end();
    });
    if (response.bytes) return response.bytes;
    next = response.redirect!;
  }
  throw new Error("Too many document redirects");
}
