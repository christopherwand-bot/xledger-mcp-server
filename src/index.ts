#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { bearerToken, createOAuthAuthorizer, matchesStaticBearerToken, readOAuthConfig, legacyBearerAllowed } from "./oauth.js";
import { createMcpServer, VERSION } from "./server.js";

if (!process.env.XLEDGER_GRAPHQL_TOKEN) {
  console.error("ERROR: XLEDGER_GRAPHQL_TOKEN must be configured on the server");
  process.exit(1);
}

// ─── Start server ────────────────────────────────────────────────────────────

/**
 * The upstream project is designed for local MCP clients (stdio).  Setting
 * MCP_TRANSPORT=http exposes the same read-only tools over Streamable HTTP so
 * it can be connected as a remote MCP server in ChatGPT.
 *
 * Keep the Xledger token server-side. The HTTP endpoint can be protected by
 * an OAuth 2.1 access token (required by ChatGPT web), or by the legacy
 * MCP_AUTH_TOKEN while OAuth is being rolled out for non-web clients.
 */
const transportMode = process.env.MCP_TRANSPORT || "stdio";

if (transportMode === "http") {
  const mcpAuthToken = process.env.MCP_AUTH_TOKEN;
  const oauthConfig = readOAuthConfig();
  const oauthAuthorizer = oauthConfig ? createOAuthAuthorizer(oauthConfig) : undefined;

  if (!mcpAuthToken && !oauthAuthorizer) {
    console.error("ERROR: configure MCP_AUTH_TOKEN or OAuth (OAUTH_ISSUER and OAUTH_RESOURCE)");
    process.exit(1);
  }

  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; owner: string }>();

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  const port = Number(process.env.PORT || 3000);
  const httpServer = createServer(async (req, res) => {
    const path = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ status: "ok", service: "xledger-mcp", transport: "http", version: VERSION }));
      return;
    }

    if (path === "/.well-known/oauth-protected-resource" && oauthAuthorizer) {
      if (req.method !== "GET") {
        res.writeHead(405, { Allow: "GET" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(oauthAuthorizer.protectedResourceMetadata));
      return;
    }

    if (path !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id",
      });
      res.end();
      return;
    }

    const token = bearerToken(req.headers.authorization);
    const authorizedWithStaticToken = legacyBearerAllowed(Boolean(oauthAuthorizer)) && Boolean(token && matchesStaticBearerToken(token, mcpAuthToken));
    const oauthIdentity =
      !authorizedWithStaticToken && token && oauthAuthorizer
        ? await oauthAuthorizer.verifyAccessToken(token)
        : undefined;
    if (!authorizedWithStaticToken && !oauthIdentity) {
      const wwwAuthenticate = oauthAuthorizer
        ? `Bearer resource_metadata="${oauthAuthorizer.metadataUrl}", scope="${oauthAuthorizer.config.requiredScope}"`
        : "Bearer";
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": wwwAuthenticate,
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"];
      // Bind sessions to a user AND client, while allowing access-token refresh.
      const owner = authorizedWithStaticToken ? "legacy-bearer" : JSON.stringify(oauthIdentity);
      const existingSession =
        typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

      if (sessionId && (!existingSession || existingSession.owner !== owner)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "MCP session not found" }));
        return;
      }

      if (existingSession) {
        await existingSession.transport.handleRequest(req, res);
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "MCP session is required" }));
        return;
      }

      const body = await readJsonBody(req);
      if (!isInitializeRequest(body)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "MCP initialization is required" }));
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await createMcpServer().connect(transport);
      await transport.handleRequest(req, res, body);
      if (transport.sessionId) sessions.set(transport.sessionId, { transport, owner });
    } catch (error) {
      console.error("MCP HTTP request failed", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  httpServer.listen(port, "0.0.0.0", () => {
    const address = httpServer.address();
    console.log(`Xledger MCP HTTP server listening on port ${typeof address === "object" && address ? address.port : port}`);
  });
} else if (transportMode === "stdio") {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
} else {
  console.error(`ERROR: Unsupported MCP_TRANSPORT: ${transportMode}`);
  process.exit(1);
}
