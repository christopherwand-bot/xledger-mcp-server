import { describe, it, expect, vi } from "vitest";
import { createGraphqlClient, connectionInfo } from "../src/graphql.js";

function client(fetcher: ReturnType<typeof vi.fn>) {
  const delay = vi.fn(async () => {});
  const run = createGraphqlClient({ url: "https://demo.xledger.net/graphql", token: "dummy-test-token", fetcher: fetcher as typeof fetch, delay });
  return { run, delay };
}

describe("bounded Xledger reads", () => {
  it("recovers once from a transient 502", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { result: 1 } })));
    const { run, delay } = client(fetcher);
    expect(await run("{ result }")).toEqual({ result: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(1000);
  });

  it("stops after two failures and avoids returning upstream HTML", async () => {
    const fetcher = vi.fn(async () => new Response("<html>private provider output</html>", { status: 502 }));
    const { run } = client(fetcher);
    await expect(run("{ result }")).rejects.toThrow("Upstream service unavailable");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry permission errors or return partial GraphQL data", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { result: 0 }, errors: [{ message: "No permission" }] })));
    await expect(client(fetcher).run("{ result }")).rejects.toThrow("No permission");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects writes before a request is sent", async () => {
    const fetcher = vi.fn();
    await expect(client(fetcher).run("mutation { addSuppliers { dbId } }")).rejects.toThrow("read queries");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("caps network/timeout failures at two attempts", async () => {
    const fetcher = vi.fn().mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    await expect(client(fetcher).run("{ result }")).rejects.toThrow("two bounded attempts");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports configured environment without exposing token or URL credentials", () => {
    expect(connectionInfo({ XLEDGER_API_URL: "https://user:password@demo.xledger.net/graphql?secret=hidden", XLEDGER_GRAPHQL_TOKEN: "secret" }))
      .toEqual({ apiEndpoint: "https://demo.xledger.net/graphql", environment: "demo", credentialConfigured: true });
  });
});
