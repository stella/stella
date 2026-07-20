import { Result } from "better-result";
import * as v from "valibot";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { getAuth } from "@/api/lib/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  MACHINE_API_KEY_CONFIG_ID,
  machineApiKeyMetadataSchema,
  machineApiKeyPermissionsSchema,
} from "@/api/lib/machine-api-key-config";
import type { MachineApiKeyScope } from "@/api/lib/machine-api-key-config";

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "provider_secret" },
} satisfies HandlerConfig;

type MachineApiKeySummary = {
  id: string;
  name: string;
  /**
   * The stored leading characters of the credential, not the credential. Enough
   * to recognize a key in a log or a CI secret store, useless as one.
   */
  start: string | null;
  scopes: MachineApiKeyScope[];
  permissions: Record<string, string[]>;
  enabled: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  lastRequest: Date | null;
};

const listUserMachineApiKeys = async (headers: Headers) => {
  const listed = await Result.tryPromise({
    try: async () =>
      await getAuth().api.listApiKeys({
        query: { configId: MACHINE_API_KEY_CONFIG_ID },
        headers,
      }),
    catch: (error: unknown) => error,
  });

  if (listed.isErr()) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Could not list API keys",
        cause: listed.error,
      }),
    );
  }

  return Result.ok(listed.value);
};

/**
 * List the caller's machine API keys in their active organization.
 *
 * The plugin's list is scoped by the owning **user**, so it is filtered here by
 * the organization id in each key's server-written metadata: a member of two
 * organizations must not see the keys they minted in one while acting in the
 * other. A key whose metadata does not parse is dropped for the same reason
 * `mcp/api-key-auth.ts` refuses it — an unreadable scope record is not a key we
 * can describe accurately.
 *
 * No plaintext is returned and no endpoint returns it after creation.
 */
const listMachineApiKeys = createSafeRootHandler(
  config,
  async function* ({ session, request }) {
    const listed = yield* Result.await(listUserMachineApiKeys(request.headers));

    const items: MachineApiKeySummary[] = [];

    for (const apiKey of listed.apiKeys) {
      const metadata = v.safeParse(
        machineApiKeyMetadataSchema,
        apiKey.metadata,
      );
      if (
        !metadata.success ||
        metadata.output.organizationId !== session.activeOrganizationId
      ) {
        continue;
      }

      const permissions = v.safeParse(
        machineApiKeyPermissionsSchema,
        apiKey.permissions,
      );
      if (!permissions.success) {
        continue;
      }

      const { name } = apiKey;
      if (name === null) {
        continue;
      }

      items.push({
        id: apiKey.id,
        name,
        start: apiKey.start,
        scopes: metadata.output.scopes,
        permissions: permissions.output,
        enabled: apiKey.enabled,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
        lastRequest: apiKey.lastRequest,
      });
    }

    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return Result.ok({ items });
  },
);

export default listMachineApiKeys;
