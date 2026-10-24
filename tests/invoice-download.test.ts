import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPublicAddress, validateDocumentUrl, downloadInvoiceDocument, MAX_DOCUMENT_BYTES } from "../src/invoice-download.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  mocks.request.mockReset();
});
function respond(status: number, body = Buffer.from("%PDF-synthetic"), headers: Record<string, string> = {}) {
  return (_url: URL, _options: any, callback: any) => {
    const req = new EventEmitter() as any;
    req.end = () => {
      const res = new PassThrough() as any; res.statusCode = status; res.headers = headers;
      callback(res);
      queueMicrotask(() => { if (!res.destroyed) res.end(body); req.emit("close"); });
    };
    req.destroy = (error: Error) => { req.emit("error", error); req.emit("close"); };
    return req;
  };
}

describe("invoice download boundary", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1", "2001:db8::1"])("blocks private/special address %s", ip => expect(isPublicAddress(ip)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("accepts global address %s", ip => expect(isPublicAddress(ip)).toBe(true));
  it.each(["http://demo.xledger.net/file", "https://demo.xledger.net.evil.test/file", "https://evil.test/file", "https://user:secret@demo.xledger.net/file", "https://demo.xledger.net:8443/file", "https://127.0.0.1/file", "file:///etc/passwd"])("rejects an unsafe or untrusted original/redirect URL %s", u => {
    expect(() => validateDocumentUrl(u, "https://demo.xledger.net/graphql")).toThrow();
  });
  it("permits only the configured Xledger origin or an exact configured storage origin", () => {
    expect(validateDocumentUrl("/Files2/test.pdf?signature=redacted", "https://demo.xledger.net/graphql").hostname).toBe("demo.xledger.net");
    expect(validateDocumentUrl("https://files.example.com/a.pdf", "https://demo.xledger.net/graphql", ["https://files.example.com"]).origin).toBe("https://files.example.com");
    expect(() => validateDocumentUrl("https://files.example.com.evil.test/a", "https://demo.xledger.net/graphql", ["https://files.example.com"])).toThrow();
  });
  it("downloads with a pinned public address and never sends an API/OAuth token", async () => {
    mocks.request.mockImplementation(respond(200));
    const file = await downloadInvoiceDocument("https://demo.xledger.net/Files2/a.pdf?signature=test", { apiOrigin: "https://demo.xledger.net/graphql" });
    expect(file.toString()).toBe("%PDF-synthetic");
    const options = mocks.request.mock.calls[0][1];
    expect(options.headers.Authorization).toBeUndefined();
    const callback = vi.fn(); options.lookup("demo.xledger.net", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(options.family).toBe(4);
  });
  it("rejects an external redirect before connecting to the new host", async () => {
    mocks.request.mockImplementation(respond(302, Buffer.alloc(0), { location: "https://evil.example/a.pdf" }));
    await expect(downloadInvoiceDocument("https://demo.xledger.net/a.pdf", { apiOrigin: "https://demo.xledger.net/graphql" })).rejects.toThrow("origin");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("blocks mixed public/private DNS results before making an HTTP request", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    await expect(downloadInvoiceDocument("https://demo.xledger.net/a.pdf", { apiOrigin: "https://demo.xledger.net/graphql" })).rejects.toThrow("network address");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("enforces the streamed byte limit even without Content-Length", async () => {
    mocks.request.mockImplementation(respond(200, Buffer.alloc(MAX_DOCUMENT_BYTES + 1)));
    await expect(downloadInvoiceDocument("https://demo.xledger.net/a.pdf", { apiOrigin: "https://demo.xledger.net/graphql" })).rejects.toThrow("30 MiB");
  });
  it("returns a useful 404 without exposing the signed link", async () => {
    mocks.request.mockImplementation(respond(404));
    await expect(downloadInvoiceDocument("https://demo.xledger.net/a.pdf?signature=secret", { apiOrigin: "https://demo.xledger.net/graphql" })).rejects.toThrow(/^Document download returned HTTP 404$/);
  });
});
