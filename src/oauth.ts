import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export type OAuthConfig = {
  issuer: string;
  resource: string;
  audience: string;
  requiredScope: string;
  jwksUrl: string;
};

export type OAuthAuthorizer = {
  config: OAuthConfig;
  metadataUrl: string;
  protectedResourceMetadata: Record<string, unknown>;
  verifyAccessToken: (token: string) => Promise<boolean>;
};

/**
 * Load OAuth configuration for a remote MCP server.  The identity provider is
 * deliberately external: this server only verifies access tokens and never
 * handles end-user credentials itself.
 */
export function readOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig | undefined {
  const issuer = env.OAUTH_ISSUER;
  const otherValues = [env.OAUTH_RESOURCE, env.OAUTH_AUDIENCE, env.OAUTH_REQUIRED_SCOPE, env.OAUTH_JWKS_URL];

  if (!issuer) {
    if (otherValues.some(Boolean)) {
      throw new Error("OAUTH_ISSUER must be set when configuring OAuth for the HTTP MCP endpoint");
    }
    return undefined;
  }

  const resource = env.OAUTH_RESOURCE;
  if (!resource) {
    throw new Error("OAUTH_RESOURCE must be set when OAUTH_ISSUER is configured");
  }

  const requiredScope = env.OAUTH_REQUIRED_SCOPE || "xledger:read";
  if (/\s/.test(requiredScope)) {
    throw new Error("OAUTH_REQUIRED_SCOPE must contain one scope value");
  }

  return {
    issuer: validateHttpsUrl(issuer, "OAUTH_ISSUER"),
    resource: validateHttpsUrl(resource, "OAUTH_RESOURCE"),
    audience: validateHttpsUrl(env.OAUTH_AUDIENCE || resource, "OAUTH_AUDIENCE"),
    requiredScope,
    jwksUrl: validateHttpsUrl(
      env.OAUTH_JWKS_URL || `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`,
      "OAUTH_JWKS_URL"
    ),
  };
}

export function createOAuthAuthorizer(config: OAuthConfig): OAuthAuthorizer {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl), {
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });
  const metadataUrl = new URL("/.well-known/oauth-protected-resource", config.resource).toString();

  return {
    config,
    metadataUrl,
    protectedResourceMetadata: {
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: [config.requiredScope],
      resource_documentation: "https://github.com/christopherwand-bot/xledger-mcp-server",
    },
    async verifyAccessToken(token: string): Promise<boolean> {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ["RS256"],
          requiredClaims: ["exp", "iat", "sub"],
        });
        return tokenHasScope(payload, config.requiredScope);
      } catch {
        // Do not expose token parsing or signature failures to callers.
        return false;
      }
    },
  };
}

export function matchesStaticBearerToken(token: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const actualBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1];
}

function tokenHasScope(payload: JWTPayload, requiredScope: string): boolean {
  const scopeClaim = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
  const permissionsClaim = Array.isArray(payload.permissions)
    ? payload.permissions.filter((value): value is string => typeof value === "string")
    : [];
  return [...scopeClaim, ...permissionsClaim].includes(requiredScope);
}

function validateHttpsUrl(value: string, variableName: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid HTTPS URL`);
  }

  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${variableName} must be a canonical HTTPS URL without credentials, query, or fragment`);
  }
  return value.replace(/\/$/, "");
}
