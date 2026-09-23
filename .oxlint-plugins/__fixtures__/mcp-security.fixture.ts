// Passive regression fixture for both `mcp-security` rules.

import * as schema from "@/api/db/schema";
import {
  mcpOAuthClients,
  mcpOAuthClients as oauthClients,
} from "@/api/db/schema";
import { redactMcpOAuthRegistrationResponse as redact } from "@/api/lib/mcp-upstream/oauth-registration-response";
import * as registration from "@/api/lib/mcp-upstream/oauth-registration-response";

declare const db: {
  innerJoin: (table: unknown, predicate: unknown) => unknown;
  leftJoin: (table: unknown, predicate: unknown) => unknown;
};
declare const organizations: unknown;
declare const predicate: unknown;
declare const registrationResponse: unknown;
declare const stored: { registrationResponse: unknown };

export const unsafePersistence = {
  // Raw DCR responses can contain client credentials.
  // oxlint-disable-next-line mcp-security/redact-oauth-registration-response -- fixture: registrationResponse must be redacted before persistence
  registrationResponse,
};

export const localRedactor = () => {
  const redactMcpOAuthRegistrationResponse = (value: unknown) => value;
  return {
    // A same-named local function is not the shared redactor.
    // oxlint-disable-next-line mcp-security/redact-oauth-registration-response -- fixture: only the owning module's redactor counts
    registrationResponse:
      redactMcpOAuthRegistrationResponse(registrationResponse),
  };
};

export const aliasedRedactor = {
  // Aliased import of the canonical redactor.
  // expect-clean: mcp-security/redact-oauth-registration-response
  registrationResponse: redact(registrationResponse),
};

export const namespaceRedactor = {
  // Namespace member of the canonical redactor module.
  // expect-clean: mcp-security/redact-oauth-registration-response
  registrationResponse:
    registration.redactMcpOAuthRegistrationResponse(registrationResponse),
};

// Destructuring reads the field; it does not persist it.
// expect-clean: mcp-security/redact-oauth-registration-response
export const { registrationResponse: readBack } = stored;

// Direct OAuth client joins skip the typed connection loader.
// oxlint-disable-next-line mcp-security/no-direct-oauth-client-join -- fixture: MCP OAuth joins must stay behind the typed loader
export const directOAuthJoin = db.leftJoin(mcpOAuthClients, predicate);

// Inner joins carry the same row-normalization risk.
// oxlint-disable-next-line mcp-security/no-direct-oauth-client-join -- fixture: both supported Drizzle join shapes are protected
export const directOAuthInnerJoin = db.innerJoin(mcpOAuthClients, predicate);

// Aliased import of the table.
// oxlint-disable-next-line mcp-security/no-direct-oauth-client-join -- fixture: aliased import
export const aliasedTableJoin = db.leftJoin(oauthClients, predicate);

// Namespace member of the schema barrel.
// oxlint-disable-next-line mcp-security/no-direct-oauth-client-join -- fixture: namespace import
export const namespaceTableJoin = db.innerJoin(
  schema.mcpOAuthClients,
  predicate,
);

// Computed member method.
// oxlint-disable-next-line typescript/dot-notation, mcp-security/no-direct-oauth-client-join -- fixture: computed member
export const computedJoin = db["leftJoin"](mcpOAuthClients, predicate);

// Joins to unrelated tables are outside the MCP invariant.
// expect-clean: mcp-security/no-direct-oauth-client-join
export const organizationJoin = db.leftJoin(organizations, predicate);
