import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import {
  bearerToken,
  createOAuthAuthorizer,
  matchesStaticBearerToken,
  readOAuthConfig,
  legacyBearerAllowed,
} from "../src/oauth.js";

const environment = {
  OAUTH_ISSUER: "https://kraftgutta.eu.auth0.com/",
  OAUTH_RESOURCE: "https://xledger-mcp.example.com",
  OAUTH_REQUIRED_SCOPE: "xledger:read",
  OAUTH_ALLOWED_SUBJECTS: "auth0|pilot-user",
};

describe("OAuth configuration", () => {
  it("creates protected-resource metadata without exposing any credential", () => {
    const config = readOAuthConfig({
      ...environment,
      OAUTH_RESOURCE: "https://xledger-mcp.example.com/",
    });

    expect(config).toEqual({
      issuer: "https://kraftgutta.eu.auth0.com/",
      resource: "https://xledger-mcp.example.com/",
      audience: "https://xledger-mcp.example.com/",
      requiredScope: "xledger:read",
      allowedSubjects: ["auth0|pilot-user"],
      jwksUrl: "https://kraftgutta.eu.auth0.com/.well-known/jwks.json",
    });
    expect(createOAuthAuthorizer(config!).protectedResourceMetadata).toEqual({
      resource: "https://xledger-mcp.example.com/",
      authorization_servers: ["https://kraftgutta.eu.auth0.com/"],
      scopes_supported: ["xledger:read"],
      resource_documentation: "https://github.com/christopherwand-bot/xledger-mcp-server",
    });
  });

  it("requires an issuer and canonical protected resource together", () => {
    expect(() => readOAuthConfig({ OAUTH_RESOURCE: "https://xledger-mcp.example.com" })).toThrow(
      "OAUTH_ISSUER"
    );
    expect(() => readOAuthConfig({ OAUTH_ISSUER: "https://tenant.auth0.com" })).toThrow(
      "OAUTH_RESOURCE"
    );
  });

  it("keeps OAuth disabled when no OAuth settings are supplied", () => {
    expect(readOAuthConfig({})).toBeUndefined();
  });

  it.each(["", "*", "auth0|pilot-user,*"])("requires an explicit user allowlist: %s", value => {
    expect(() => readOAuthConfig({ ...environment, OAUTH_ALLOWED_SUBJECTS: value })).toThrow("OAUTH_ALLOWED_SUBJECTS");
  });

  it.each(['read write', 'read"injection', 'read\\injection', 'read\r\nheader', 'les:æ'])
    ("rejects invalid scope tokens: %s", value => {
      expect(() => readOAuthConfig({ ...environment, OAUTH_REQUIRED_SCOPE: value })).toThrow("OAUTH_REQUIRED_SCOPE");
    });

  it.each(["http://tenant.example/", "https://user:pass@tenant.example/", "https://tenant.example/?q=1", "https://tenant.example/#x", " https://tenant.example/"])
    ("rejects unsafe issuer URLs: %s", value => {
      expect(() => readOAuthConfig({ ...environment, OAUTH_ISSUER: value })).toThrow("OAUTH_ISSUER");
    });
});

describe("signed OAuth access tokens", () => {
  const config = readOAuthConfig(environment)!;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
  let publicJwk: JWK;

  beforeAll(async () => {
    keys = await generateKeyPair("RS256");
    otherKeys = await generateKeyPair("RS256");
    publicJwk = { ...await exportJWK(keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  });

  beforeEach(() => {
    // Exercise jose's real JWKS resolver and signature checks without sending
    // credentials to a network service. Test keys exist only in memory.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(String(url)).toBe(config.jwksUrl);
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function sign(overrides: JWTPayload = {}, privateKey = keys.privateKey) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: config.issuer, aud: config.audience, sub: "auth0|pilot-user",
      azp: "chatgpt-client", scope: "openid xledger:read", iat: now, exp: now + 120,
      ...overrides,
    }).setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" }).sign(privateKey);
  }

  it("accepts a signed token for the exact issuer, resource, pilot user and scope", async () => {
    expect(await createOAuthAuthorizer(config).verifyAccessToken(await sign())).toEqual({
      issuer: config.issuer, subject: "auth0|pilot-user", clientId: "chatgpt-client",
    });
  });

  it("supports the RFC 9068 client_id claim", async () => {
    expect(await createOAuthAuthorizer(config).verifyAccessToken(await sign({ azp: undefined, client_id: "chatgpt-client" })))
      .toMatchObject({ clientId: "chatgpt-client" });
  });

  it.each([
    ["wrong issuer", { iss: "https://another.example/" }],
    ["missing issuer slash", { iss: config.issuer.slice(0, -1) }],
    ["wrong audience", { aud: "https://another-api.example" }],
    ["extra audience slash", { aud: config.audience + "/" }],
    ["expired", { exp: 1 }],
    ["not yet valid", { nbf: 9999999999 }],
    ["missing expiry", { exp: undefined }],
    ["missing issued-at", { iat: undefined }],
    ["unapproved user", { sub: "auth0|another-user" }],
    ["missing subject", { sub: undefined }],
    ["missing client", { azp: undefined }],
    ["missing scope", { scope: undefined }],
    ["wrong scope", { scope: "xledger:read-all" }],
    ["permissions without delegation", { scope: "openid", permissions: ["xledger:read"] }],
  ])("rejects %s", async (_label, claims) => {
    expect(await createOAuthAuthorizer(config).verifyAccessToken(await sign(claims as JWTPayload))).toBeUndefined();
  });

  it("rejects an invalid signature", async () => {
    expect(await createOAuthAuthorizer(config).verifyAccessToken(await sign({}, otherKeys.privateKey))).toBeUndefined();
  });

  it("rejects malformed tokens", async () => {
    expect(await createOAuthAuthorizer(config).verifyAccessToken("not-a-jwt")).toBeUndefined();
  });

  it("fails closed if signing keys cannot be retrieved", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("JWKS unavailable")));
    expect(await createOAuthAuthorizer(config).verifyAccessToken(await sign())).toBeUndefined();
  });
});

describe("bearer parsing", () => {
  it("disables static-token fallback with OAuth unless explicitly allowed", () => {
    expect(legacyBearerAllowed(true, {})).toBe(false);
    expect(legacyBearerAllowed(true, { MCP_ALLOW_LEGACY_BEARER: "1" })).toBe(true);
    expect(legacyBearerAllowed(false, {})).toBe(true);
  });
  it("accepts only an exact static bearer token", () => {
    expect(bearerToken("Bearer correct-token")).toBe("correct-token");
    expect(bearerToken("Basic correct-token")).toBeUndefined();
    expect(matchesStaticBearerToken("correct-token", "correct-token")).toBe(true);
    expect(matchesStaticBearerToken("wrong-token", "correct-token")).toBe(false);
  });
});
