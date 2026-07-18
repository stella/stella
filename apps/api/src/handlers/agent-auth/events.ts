import { Result } from "better-result";
import { t } from "elysia";

import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { createSafePublicHandler } from "@/api/lib/api-handlers";

/**
 * RFC 8935 Security Event Token (SET) receiver. Full SET signature
 * verification and event handling (e.g. identity-assertion revocation)
 * land with the identity_assertion phase. For now we accept a
 * well-formed SET and acknowledge it without acting on it, so the
 * endpoint is safe to expose: it does no privileged work and cannot be
 * abused to mutate state.
 */
const config = {
  // A SET is a signed JWT delivered as application/secevent+jwt. We accept
  // the compact serialization as an opaque string and bound its size.
  body: t.String({ minLength: 1, maxLength: 16_384 }),
  mcp: { type: "internal", reason: "auth_plumbing" },
} satisfies PublicHandlerConfig;

const agentEventsHandler = createSafePublicHandler(
  config,
  // eslint-disable-next-line require-yield -- no-op acknowledgement; SET verification is a later phase
  async function* () {
    // TODO(agent-auth identity_assertion phase): verify the SET signature
    // against the issuer's JWKS, validate `iss`/`aud`/`events`, then act on
    // recognised event types (assertion revocation). Until then this is an
    // intentional no-op acknowledgement.
    return Result.ok({ accepted: true });
  },
);

export default agentEventsHandler;
