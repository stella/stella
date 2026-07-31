import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSsoConnection } from "@/api/lib/sso-connections";

const commonFields = {
  domain: t.String({ minLength: 3, maxLength: 253 }),
  issuer: t.String({ minLength: 1, maxLength: 2048 }),
};

const createSsoConnectionBody = t.Union([
  t.Object({
    protocol: t.Literal("oidc"),
    ...commonFields,
    clientId: t.String({ minLength: 1, maxLength: 1024 }),
    clientSecret: t.String({ minLength: 1, maxLength: 4096 }),
  }),
  t.Object({
    protocol: t.Literal("saml"),
    ...commonFields,
    entryPoint: t.String({ minLength: 1, maxLength: 2048 }),
    certificate: t.String({ minLength: 1, maxLength: 50_000 }),
  }),
]);

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "provider_secret" },
  body: createSsoConnectionBody,
} satisfies HandlerConfig;

const create = createSafeRootHandler(
  config,
  async function* ({ session, user, body, recordAuditEvent }) {
    const connection = yield* Result.await(
      createSsoConnection({
        organizationId: session.activeOrganizationId,
        userId: user.id,
        input: body,
        recordAuditEvent,
      }),
    );
    return Result.ok(connection);
  },
);

export default create;
