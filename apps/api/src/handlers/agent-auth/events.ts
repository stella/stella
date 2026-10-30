import { Result } from "better-result";
import * as v from "valibot";

import { status } from "@/api/http/status";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
} from "@/api/lib/api-handlers";

/**
 * RFC 8935 Security Event Token (SET) receiver. Full SET signature
 * verification and event handling (e.g. identity-assertion revocation)
 * land with the identity_assertion phase. For now we accept a
 * well-formed SET and acknowledge it without acting on it, so the
 * endpoint is safe to expose: it does no privileged work and cannot be
 * abused to mutate state.
 */
const config = {
  contract: "patch",
  // A SET is a signed JWT delivered as application/secevent+jwt. We accept
  // the compact serialization as an opaque string and bound its size.
  body: v.pipe(v.string(), v.minLength(1), v.maxLength(16_384)),
  bodyMode: "text",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  cache: { kind: "none" },
  // RFC 8935: a SET receiver acknowledges with 202 Accepted and nothing else.
  response: { 202: v.object({ accepted: v.literal(true) }) },
} satisfies PublicHandlerConfig;

const agentEventsHandler = createSafePublicHandler(
  config,
  // oxlint-disable-next-line typescript/require-await -- safe handlers must remain async generators for Result.gen error capture.
  async function* () {
    // TODO(agent-auth identity_assertion phase): verify the SET signature
    // against the issuer's JWKS, validate `iss`/`aud`/`events`, then act on
    // recognised event types (assertion revocation). Until then this is an
    // intentional no-op acknowledgement.
    return Result.ok(status(202, { accepted: true }));
  },
);

export default agentEventsHandler;
