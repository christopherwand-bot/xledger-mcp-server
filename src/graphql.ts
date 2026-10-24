/** Bounded read requests to Xledger. Secrets stay in the server environment. */
export type GqlRunner = (query: string) => Promise<Record<string, any>>;

export class XledgerApiError extends Error {
  constructor(message: string, public readonly code: string) { super(message); }
}

export function connectionInfo(env: NodeJS.ProcessEnv = process.env) {
  const url = new URL(env.XLEDGER_API_URL || "https://www.xledger.net/graphql");
  return {
    apiEndpoint: `${url.origin}${url.pathname}`,
    environment: url.hostname === "demo.xledger.net" ? "demo" : url.hostname === "www.xledger.net" ? "production" : "custom_or_test",
    credentialConfigured: Boolean(env.XLEDGER_GRAPHQL_TOKEN),
  };
}

export function createGraphqlClient(options: {
  url: string; token: string; fetcher?: typeof fetch;
  timeoutMs?: number; delay?: (ms: number) => Promise<void>;
}): GqlRunner {
  const fetcher = options.fetcher || fetch;
  const delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  return async query => {
    if (!options.token) throw new Error("XLEDGER_GRAPHQL_TOKEN is not configured");
    if (!/^(?:\s*\{|\s*query\b)/.test(query)) throw new Error("Only GraphQL read queries are permitted");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetcher(options.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `token ${options.token}` },
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(options.timeoutMs || 12_000),
        });
        if (!res.ok) {
          if (attempt === 0 && [429, 502, 503, 504].includes(res.status)) {
            await res.body?.cancel();
            await delay(1_000);
            continue;
          }
          const raw = await res.text();
          const detail = /<html|<body|<!doctype/i.test(raw) ? "Upstream service unavailable" : raw.slice(0, 400);
          throw new XledgerApiError(`Xledger API error HTTP ${res.status}: ${detail}`, `HTTP_${res.status}`);
        }
        const json = await res.json() as { data?: Record<string, any>; errors?: Array<{ message: string; extensions?: { code?: string } }> };
        if (json.errors?.length) {
          const retryDelays = json.errors.map(e => {
            if (String(e.extensions?.code || "").toUpperCase().includes("CONCURRENCY_LIMIT_REACHED")) return 1_000;
            // Xledger can return its burst limit as GraphQL errors with HTTP 200.
            // Wait out the stated window, once; never retry permission/unknown errors.
            const burst = /^Too many requests in the last (\d{1,3}) seconds?\b/i.exec(e.message);
            return burst ? Math.min(30_000, Math.max(1_000, Number(burst[1]) * 1_000 + 250)) : null;
          });
          if (attempt === 0 && retryDelays.every((ms): ms is number => ms !== null)) {
            await delay(Math.max(...retryDelays));
            continue;
          }
          throw new XledgerApiError(`Xledger GraphQL errors: ${JSON.stringify(json.errors.map(e => ({ message: e.message })))}`, "GRAPHQL_ERROR");
        }
        if (!json.data || typeof json.data !== "object") throw new XledgerApiError("Xledger returned no data object", "NO_DATA");
        return json.data;
      } catch (error) {
        const transient = error instanceof Error && ["TypeError", "AbortError", "TimeoutError"].includes(error.name);
        if (attempt === 0 && transient) { await delay(1_000); continue; }
        if (transient) throw new XledgerApiError("Xledger request failed or timed out after two bounded attempts", "UPSTREAM_UNAVAILABLE");
        throw error;
      }
    }
    throw new XledgerApiError("Xledger request failed after two attempts", "UPSTREAM_UNAVAILABLE");
  };
}

export async function gql(query: string): Promise<Record<string, any>> {
  return createGraphqlClient({
    url: process.env.XLEDGER_API_URL || "https://www.xledger.net/graphql",
    token: process.env.XLEDGER_GRAPHQL_TOKEN || "",
  })(query);
}
