import type { USER_SESSION_CREDENTIAL_ISSUERS } from "@/api/lib/synthetic-principal/credential-policy";

/**
 * Every place where a presented credential becomes a user principal, and the
 * revocations each one must honour on its very next verification.
 *
 * Two inputs keep this list complete:
 *
 * - `ISSUED_CREDENTIAL_VERIFIERS` is total over the credential issuers in
 *   `USER_SESSION_CREDENTIAL_ISSUERS`, so a new issuer does not type-check
 *   until it names the verifier that accepts what it issues.
 * - `credential-verifiers.test.ts` scans the API sources for verification
 *   primitives (signature and token checks, session reads, key lookups). A
 *   file that uses one belongs to a verifier below or to
 *   `NON_PRINCIPAL_CREDENTIAL_SOURCES`, with the reason it yields no user
 *   principal. An entry whose file no longer exists fails.
 *
 * `credential-verifier-revocation.db.test.ts` then issues a real credential
 * for each verifier, checks it is accepted, applies each revocation listed
 * here and asserts the next verification is refused.
 */

/**
 * - `memberRemoved`: the organization removes the member.
 * - `accountDeleted`: the user deletes their account.
 * - `sessionRevoked`: the user signs the session out from another device.
 * - `grantRevoked`: the user revokes the token they granted a client.
 */
export const CREDENTIAL_REVOCATIONS = [
  "memberRemoved",
  "accountDeleted",
  "sessionRevoked",
  "grantRevoked",
] as const;
export type CredentialRevocation = (typeof CREDENTIAL_REVOCATIONS)[number];

type CredentialVerifier = {
  /** Repository paths of the code that accepts or mints this credential. */
  sources: readonly string[];
  revocations: readonly CredentialRevocation[];
  /**
   * The test that proves the revocations, when it needs a lane the shared
   * revocation suite does not run in. The title must exist in the file.
   */
  proof?: { file: string; test: string };
};

export const CREDENTIAL_VERIFIERS = {
  /** Session cookie on an organization route (`validateAuth`). */
  browserSession: {
    sources: [
      "apps/api/src/lib/auth.ts",
      "apps/api/src/lib/auth/session-lifetime.ts",
      "apps/api/src/lib/auth/session-lifetime-store.ts",
    ],
    revocations: ["memberRemoved", "accountDeleted", "sessionRevoked"],
  },
  /** Session cookie on an account route (`validateSession`). */
  accountSession: {
    sources: ["apps/api/src/lib/auth.ts"],
    revocations: ["accountDeleted", "sessionRevoked"],
  },
  /** Signed session token in the Authorization header (desktop, extension). */
  bearerSession: {
    sources: ["apps/api/src/lib/auth.ts"],
    revocations: ["memberRemoved", "accountDeleted", "sessionRevoked"],
  },
  /** OAuth access token a client holds for MCP and the legal-resolve API. */
  mcpAccessToken: {
    sources: ["apps/api/src/mcp/auth.ts"],
    revocations: ["memberRemoved", "accountDeleted", "grantRevoked"],
  },
  /** Token an agent run carries to MCP on its owner's behalf. */
  agentRunToken: {
    sources: ["apps/api/src/mcp/auth.ts"],
    revocations: ["memberRemoved", "accountDeleted"],
  },
  /** Signed user token without a client (no `client_id`/`azp`). */
  delegatedUserToken: {
    sources: ["apps/api/src/mcp/auth.ts"],
    revocations: ["memberRemoved", "accountDeleted"],
  },
  /** Machine and personal API keys. */
  apiKey: {
    sources: ["apps/api/src/mcp/api-key-auth.ts"],
    revocations: ["memberRemoved", "accountDeleted"],
  },
  /**
   * Desktop account key with its device proof. Desktop edit handoffs are
   * redeemed only under this credential.
   */
  desktopAccountKey: {
    sources: [
      "apps/api/src/lib/business-registries/desktop/auth.ts",
      "apps/api/src/lib/business-registries/desktop/proof.ts",
      "apps/api/src/lib/desktop-edit-handoffs.ts",
      "apps/api/src/handlers/entities/desktop-edit-handoffs.ts",
    ],
    revocations: ["memberRemoved", "accountDeleted"],
  },
  /** Collaborative editing room token. */
  collabRoom: {
    sources: ["apps/api/src/lib/folio-collab-rooms.ts"],
    revocations: ["memberRemoved", "accountDeleted"],
  },
  /** Desktop edit session token. */
  desktopEditSession: {
    sources: [
      "apps/api/src/lib/desktop-edit-sessions.ts",
      "apps/api/src/handlers/entities/open-desktop-edit-session.ts",
      "apps/api/src/handlers/entities/checkpoint-desktop-edit-session.ts",
      "apps/api/src/handlers/entities/finalize-desktop-edit-session.ts",
      "apps/api/src/handlers/entities/respond-desktop-edit-takeover.ts",
    ],
    revocations: ["memberRemoved", "accountDeleted"],
  },
  /** PDF signing session token. */
  pdfSigningSession: {
    sources: [
      "apps/api/src/lib/files/pdf-signing/sessions.ts",
      "apps/api/src/handlers/entities/pdf-signing-handoffs.ts",
    ],
    revocations: ["memberRemoved", "accountDeleted"],
  },
  /** An open event stream, re-authorized on every delivery. */
  realtimeStream: {
    sources: ["apps/api/src/lib/sse.ts"],
    revocations: ["memberRemoved", "accountDeleted", "sessionRevoked"],
  },
  /** A sender filing mail into a matter through its inbound address. */
  inboundMailSender: {
    sources: ["apps/api/src/lib/email/inbound/store.ts"],
    revocations: ["memberRemoved"],
    proof: {
      file: "apps/api/src/lib/email/inbound/store.db.test.ts",
      test: "a verified alias follows its owner's current organization and matter membership",
    },
  },
  /** Presigned object storage URL; the storage service verifies it. */
  signedObjectUrl: {
    sources: ["apps/api/src/lib/s3-presign.ts"],
    revocations: ["memberRemoved", "accountDeleted"],
  },
} as const satisfies Record<string, CredentialVerifier>;

export type CredentialVerifierKind = keyof typeof CREDENTIAL_VERIFIERS;

/** The verifiers that accept what each credential issuer hands out. */
export const ISSUED_CREDENTIAL_VERIFIERS = {
  session: ["browserSession", "accountSession", "bearerSession"],
  cookieCache: ["browserSession", "accountSession"],
  collabRoom: ["collabRoom"],
  oauth: ["mcpAccessToken"],
  // Accepted only inside a signed-in request.
  invitation: ["accountSession"],
  inboundEmail: ["inboundMailSender"],
  // Accepted only inside a signed-in request.
  confirmationCode: ["browserSession", "accountSession"],
  apiKey: ["apiKey"],
  desktopAccount: ["desktopAccountKey"],
  desktopEdit: ["desktopEditSession"],
  desktopHandoff: ["desktopAccountKey"],
  pdfSigning: ["pdfSigningSession"],
  signedDownload: ["signedObjectUrl"],
  signedUpload: ["signedObjectUrl"],
  agentRun: ["agentRunToken"],
  agentDelegation: ["mcpAccessToken", "delegatedUserToken"],
  realtime: ["realtimeStream"],
} as const satisfies Record<
  keyof typeof USER_SESSION_CREDENTIAL_ISSUERS,
  readonly CredentialVerifierKind[]
>;

/**
 * Files that use a verification primitive without turning a credential into
 * a user principal.
 */
export const NON_PRINCIPAL_CREDENTIAL_SOURCES = {
  "apps/api/src/agent-auth/id-jag.ts":
    "verifies an identity provider's assertion; the token it leads to is an mcpAccessToken",
  "apps/api/src/lib/agent-auth-idjag.ts":
    "verifies an agent's service assertion before a token exchange; the token is an mcpAccessToken",
  "apps/api/src/lib/agent-auth.ts":
    "digests agent registration claim codes; the tokens it leads to are mcpAccessToken or browserSession",
  "apps/api/src/handlers/chat/chat-secret-retry.ts":
    "compares a connector secret inside a signed-in chat request",
  "apps/api/src/handlers/search-history/import-clock.ts":
    "checks a signed import cursor inside a signed-in request",
  "apps/api/src/handlers/smoke/routes.ts":
    "compares a deployment smoke secret; no user principal",
  "apps/api/src/handlers/synthetic/routes.ts":
    "compares a monitoring key; the session it mints is a browserSession",
  "apps/api/src/lib/auth/email-otp-reset-confirmation.ts":
    "compares a sign-in code before any session exists",
  "apps/api/src/lib/auth/social-link-hint.ts":
    "digests a sign-in attempt for a linking hint; no principal",
  "apps/api/src/lib/client-ip.ts":
    "compares the edge's origin header secret; no user principal",
  "apps/api/src/lib/configured-bearer-access.ts":
    "compares an operator-configured bearer secret; no user principal",
  "apps/api/src/lib/files/email-attachment-token.ts":
    "checks an attachment handle inside an authorized file read",
  "apps/api/src/lib/hosted-usage-provider/verify-signature.ts":
    "verifies a provider webhook signature; no user principal",
  "apps/api/src/lib/rate-limit/auth-request-budget.ts":
    "digests a token to key a rate limit; no principal",
  "apps/api/src/lib/security-canary.ts":
    "compares a canary secret; no user principal",
  "apps/api/src/lib/selfhost-auth.ts":
    "compares the self-host bootstrap token before any account exists",
  "apps/api/src/mcp/feedback-approval.ts":
    "binds a feedback approval inside an authenticated MCP request",
} as const satisfies Record<string, string>;

/**
 * Verifier and revocation pairs that still accept the credential after the
 * revocation, pending a decision on their design. `acceptedForSeconds` is the
 * bound the revocation suite proves; `null` means no time bound (accepted
 * until the connection closes). A pair that starts refusing at once fails
 * the suite until its entry is removed.
 */
export const OPEN_REVOCATION_DECISIONS = {
  // The signed cookie snapshot is served without a storage read until it
  // expires; the member lookup still runs live on every request.
  browserSession: {
    sessionRevoked: { acceptedForSeconds: 60 },
  },
  // Access tokens are verified by signature; the grant is not read.
  mcpAccessToken: {
    grantRevoked: { acceptedForSeconds: 15 * 60 },
  },
  // Deliveries re-check membership, not the session that opened the stream.
  realtimeStream: {
    sessionRevoked: { acceptedForSeconds: null },
  },
  // The storage service checks only the URL's signature and expiry.
  signedObjectUrl: {
    memberRemoved: { acceptedForSeconds: 15 * 60 },
    accountDeleted: { acceptedForSeconds: 15 * 60 },
  },
} as const satisfies {
  [Kind in CredentialVerifierKind]?: Partial<
    Record<
      (typeof CREDENTIAL_VERIFIERS)[Kind]["revocations"][number],
      {
        acceptedForSeconds: number | null;
      }
    >
  >;
};
