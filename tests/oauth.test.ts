import { describe, expect, it } from "vitest";
import {
  bearerToken,
  createOAuthAuthorizer,
  matchesStaticBearerToken,
  readOAuthConfig,
} from "../src/oauth.js";

describe("OAuth configuration", () => {
  it("creates protected-resource metadata without exposing any credential", () => {
    const config = readOAuthConfig({
      OAUTH_ISSUER: "https://kraftgutta.eu.auth0.com/",
      OAUTH_RESOURCE: "https://xledger-mcp.example.com/",
      OAUTH_REQUIRED_SCOPE: "xledger:read",
    });

    expect(config).toEqual({
      issuer: "https://kraftgutta.eu.auth0.com",
      resource: "https://xledger-mcp.example.com",
      audience: "https://xledger-mcp.example.com",
      requiredScope: "xledger:read",
      jwksUrl: "https://kraftgutta.eu.auth0.com/.well-known/jwks.json",
    });
    expect(createOAuthAuthorizer(config!).protectedResourceMetadata).toEqual({
      resource: "https://xledger-mcp.example.com",
      authorization_servers: ["https://kraftgutta.eu.auth0.com"],
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
});

describe("bearer parsing", () => {
  it("accepts only an exact static bearer token", () => {
    expect(bearerToken("Bearer correct-token")).toBe("correct-token");
    expect(bearerToken("Basic correct-token")).toBeUndefined();
    expect(matchesStaticBearerToken("correct-token", "correct-token")).toBe(true);
    expect(matchesStaticBearerToken("wrong-token", "correct-token")).toBe(false);
  });
});
