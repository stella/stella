import { Result } from "better-result";
import { t } from "elysia";

import { toMachineApiKeySummary } from "@/api/handlers/api-keys/mint";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { MachineApiKeyScope } from "@/api/lib/machine-api-key-config";
import {
  listOrganizationMachineApiKeys,
  machineApiKeyCursor,
} from "@/api/lib/machine-api-key-queries";
import { createCursorPage } from "@/api/lib/pagination";

const MACHINE_API_KEY_PAGE_SIZE_DEFAULT = 50;
const MACHINE_API_KEY_PAGE_SIZE_MAX = 200;

const listMachineApiKeysQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: MACHINE_API_KEY_PAGE_SIZE_MAX }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

const config = {
  query: listMachineApiKeysQuerySchema,
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

/**
 * List the machine API keys belonging to the caller's active organization.
 *
 * Organization-scoped, not caller-scoped: an admin has to be able to see (and
 * therefore revoke) a key a colleague minted, otherwise a departing employee's
 * credential is unrevokable. The organization predicate is applied in SQL by
 * `listOrganizationMachineApiKeys` — see `machine-api-key-queries.ts` for why
 * that filter is the tenant boundary for this table and must not move into JS.
 *
 * Rows written by anything other than these handlers (unparseable metadata or
 * permissions, missing name) are dropped: a key we cannot describe accurately
 * is not one to render. That is a rendering decision applied after the page is
 * cut, not the tenant filter.
 *
 * No plaintext is returned, and no endpoint returns it after creation.
 */
export const createListMachineApiKeysHandler = (
  listMachineApiKeys: typeof listOrganizationMachineApiKeys = listOrganizationMachineApiKeys,
) =>
  createSafeRootHandler(config, async function* ({ session, query }) {
    const limit = query.limit ?? MACHINE_API_KEY_PAGE_SIZE_DEFAULT;

    // A malformed cursor is rejected rather than silently treated as "first
    // page", so a client bug surfaces instead of quietly re-reading page one.
    const cursor = query.cursor
      ? machineApiKeyCursor.decode(query.cursor)
      : null;
    if (query.cursor !== undefined && cursor === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    const rows = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await listMachineApiKeys({
            cursor,
            limit,
            organizationId: session.activeOrganizationId,
          }),
        catch: (error: unknown) =>
          new HandlerError({
            status: 500,
            message: "Could not list API keys",
            cause: error,
          }),
      }),
    );

    // Paginate first, then render. Cutting the page before dropping
    // undescribable rows keeps `nextCursor` anchored to a real row's
    // `(created_at, id)`. The cursor carries the database's own
    // microsecond-precision rendering of `created_at`, not a JS `Date`, so
    // the boundary comparison cannot skip the keys that share the boundary's
    // truncated millisecond.
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (row) =>
        machineApiKeyCursor.encode(row.createdAtCursor, row.id),
    });

    const items: MachineApiKeySummary[] = [];
    for (const row of page.items) {
      const summary = toMachineApiKeySummary(row);
      if (summary === null) {
        continue;
      }
      items.push({
        id: summary.id,
        name: summary.name,
        start: row.start,
        scopes: summary.scopes,
        permissions: summary.permissions,
        enabled: summary.enabled,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        lastRequest: row.lastRequest,
      });
    }

    return Result.ok({
      items,
      limit: page.limit,
      nextCursor: page.nextCursor,
    });
  });

const listMachineApiKeys = createListMachineApiKeysHandler();
export default listMachineApiKeys;
