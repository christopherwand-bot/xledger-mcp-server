import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const children: ChildProcess[] = [];
let api: Server;
let url: string;
let oauthUrl: string;
const secret = "dummy-http-regression-secret";
const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

async function start(extra: Record<string, string> = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("OAUTH_")) delete env[name];
  const address = api.address() as { port: number };
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: { ...env, MCP_TRANSPORT: "http", PORT: "0", MCP_AUTH_TOKEN: secret, XLEDGER_GRAPHQL_TOKEN: "dummy-xledger-secret", XLEDGER_API_URL: `http://127.0.0.1:${address.port}/graphql`, XLEDGER_ENABLE_PERSONNEL_TOOLS: "", MCP_ALLOW_LEGACY_BEARER: "", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Local MCP did not start: ${output}`)), 5000);
    child.stdout!.on("data", chunk => {
      output += chunk;
      const match = /listening on port (\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.stderr!.on("data", chunk => { output += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Local MCP exited ${code}: ${output}`)); });
  });
}

async function rpc(body: unknown, session?: string) {
  const response = await fetch(url + "/mcp", { method: "POST", headers: { ...headers, ...(session ? { "Mcp-Session-Id": session } : {}) }, body: JSON.stringify(body) });
  const text = await response.text();
  const data = text.startsWith("event:") ? JSON.parse(text.split("\n").find(line => line.startsWith("data:"))!.slice(5)) : text ? JSON.parse(text) : null;
  return { response, data };
}

beforeAll(async () => {
  api = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const query = JSON.parse(Buffer.concat(chunks).toString()).query as string;
    const rows = [{ dbId: 1, invoiceNumber: "TEST-1", invoiceRemaining: "-100" }, { dbId: 2, invoiceNumber: "TEST-2", invoiceRemaining: "25" }]
      .map(row => ({ ...row, ownerDbId: 7, transactionHeaderDbId: 70, transactionHeader: { dbId: 70, ownerDbId: 7 } }));
    const nodes = query.includes("invoiceRemaining_lt") ? rows : rows.filter(row => Number(row.invoiceRemaining) > 0);
    res.writeHead(200, { "Content-Type": "application/json" });
    const data = query.includes("entities(") ? { entities: { edges: [{ node: { dbId: 7 } }] } }
      : { apTransactions: { pageInfo: { hasNextPage: false }, edges: nodes.map(node => ({ cursor: String(node.dbId), node })) } };
    res.end(JSON.stringify({ data }));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  url = await start();
  oauthUrl = await start({ OAUTH_ISSUER: "https://auth.example.test/", OAUTH_RESOURCE: "https://mcp.example.test", OAUTH_ALLOWED_SUBJECTS: "auth0|test-pilot" });
});

afterAll(async () => {
  await Promise.all(children.map(async child => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } }));
  await new Promise<void>(resolve => api.close(() => resolve()));
});

describe("real HTTP transport with isolated dummy credentials", () => {
  it("reports the deployed code version without exposing credentials", async () => {
    const response = await fetch(url + "/health");
    const data = await response.json();
    expect(data).toMatchObject({ status: "ok", version: "1.5.1" });
    expect(JSON.stringify(data)).not.toContain(secret);
  });

  it("requires authentication", async () => {
    expect((await fetch(url + "/mcp")).status).toBe(401);
  });

  it("initializes a session, lists read tools and reads open supplier balances end to end", async () => {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "http-regression-test", version: "1" } } });
    expect(init.response.status).toBe(200);
    const session = init.response.headers.get("mcp-session-id")!;
    expect(session).toBeTruthy();
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
    const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session);
    expect(listed.data.result.tools.some((tool: any) => tool.name === "get_connection_info")).toBe(true);
    expect(listed.data.result.tools.some((tool: any) => tool.name === "get_posted_transactions")).toBe(true);
    expect(listed.data.result.tools.some((tool: any) => tool.name === "reconcile_posted_period")).toBe(true);
    expect(listed.data.result.tools.some((tool: any) => tool.name === "get_employees")).toBe(false);
    const result = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_ap_transactions", arguments: { first: 10, outstandingOnly: true } } }, session);
    const payload = JSON.parse(result.data.result.content[0].text);
    expect(payload.items.map((row: any) => row.invoiceRemaining)).toEqual(["-100", "25"]);
    expect(payload.complete).toBe(true);
    const unknown = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, "unknown-session");
    expect(unknown.response.status).toBe(404);
  });

  it("does not accept the legacy static token when OAuth is configured", async () => {
    const response = await fetch(oauthUrl + "/mcp", { headers: { Authorization: `Bearer ${secret}` } });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  });
});
