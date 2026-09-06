import { panic, Result } from "better-result";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import {
  LOOKUP_FORMAT_PREFERENCE,
  templateLookupFormats,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tPaginationCursor, tSafeId } from "@/api/lib/custom-schema";
import { LOOKUP_REGISTRIES } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedTemplateLookupFormatId } from "@/api/lib/safe-id-boundaries";

const FORMAT_LIMITS = {
  name: 120,
  format: 2000,
  pageDefault: 50,
  pageMax: 100,
} as const;

const listConfig = {
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "capability", reason: "template_authoring_ui" },
  query: t.Object({
    registry: t.UnionEnum(LOOKUP_REGISTRIES),
    limit: t.Optional(
      t.Integer({ minimum: 1, maximum: FORMAT_LIMITS.pageMax }),
    ),
    cursor: t.Optional(tPaginationCursor()),
  }),
} satisfies HandlerConfig;

const toResponse = ({
  id,
  registry,
  name,
  format,
  createdAt,
}: typeof templateLookupFormats.$inferSelect) => ({
  id,
  registry,
  name,
  format,
  createdAt: createdAt.toISOString(),
});

export const listLookupFormats = createSafeRootHandler(
  listConfig,
  async function* ({ safeDb, session, query }) {
    const limit = query.limit ?? FORMAT_LIMITS.pageDefault;
    const conditions = [
      eq(templateLookupFormats.organizationId, session.activeOrganizationId),
      eq(templateLookupFormats.registry, query.registry),
    ];
    if (query.cursor) {
      const parts = decodePaginationCursor(query.cursor);
      const id = parts?.at(0);
      if (
        parts?.length !== 2 ||
        !isUuidPaginationCursorPart(id) ||
        parts.at(1) !== query.registry
      ) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      conditions.push(
        lt(templateLookupFormats.id, brandPersistedTemplateLookupFormatId(id)),
      );
    }
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select()
          .from(templateLookupFormats)
          .where(and(...conditions))
          // IDs are server-minted UUIDv7: immutable newest-first pagination.
          .orderBy(desc(templateLookupFormats.id))
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (row) => encodePaginationCursor([row.id, row.registry]),
    });
    const defaults = yield* Result.await(
      safeDb((tx) =>
        tx
          .select()
          .from(templateLookupFormats)
          .where(
            and(
              eq(
                templateLookupFormats.organizationId,
                session.activeOrganizationId,
              ),
              eq(templateLookupFormats.registry, query.registry),
              eq(
                templateLookupFormats.preference,
                LOOKUP_FORMAT_PREFERENCE.DEFAULT,
              ),
            ),
          )
          .limit(1),
      ),
    );
    const defaultFormat = defaults.at(0);
    return Result.ok({
      ...page,
      items: page.items.map(toResponse),
      defaultFormat: defaultFormat ? toResponse(defaultFormat) : null,
    });
  },
);

const createConfig = {
  permissions: { template: ["create"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  body: t.Object(
    {
      registry: t.UnionEnum(LOOKUP_REGISTRIES),
      name: t.String({ minLength: 1, maxLength: FORMAT_LIMITS.name }),
      format: t.String({ minLength: 1, maxLength: FORMAT_LIMITS.format }),
    },
    { additionalProperties: false },
  ),
} satisfies HandlerConfig;

export const createLookupFormat = createSafeRootHandler(
  createConfig,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const name = body.name.trim();
    if (!name || !body.format.trim()) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Name and format must not be empty",
        }),
      );
    }
    const row = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .insert(templateLookupFormats)
          .values({
            organizationId: session.activeOrganizationId,
            registry: body.registry,
            name,
            format: body.format,
          })
          .returning();
        const created =
          rows.at(0) ?? panic("Lookup format insert returned no row");
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE_LOOKUP_FORMAT,
          resourceId: created.id,
          changes: {
            created: { old: null, new: { registry: created.registry } },
          },
        });
        return created;
      }),
    );
    return Result.ok(toResponse(row));
  },
);

export const setDefaultLookupFormat = createSafeRootHandler(
  {
    permissions: { template: ["update"] },
    mcp: { type: "capability", reason: "template_authoring_ui" },
    body: t.Object(
      {
        registry: t.UnionEnum(LOOKUP_REGISTRIES),
        formatId: t.Union([tSafeId("templateLookupFormat"), t.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        // Serialize default switches so concurrent teammates cannot leave two defaults.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${session.activeOrganizationId}), hashtext(${`lookup-format-default:${body.registry}`}))`,
        );
        const scope = and(
          eq(
            templateLookupFormats.organizationId,
            session.activeOrganizationId,
          ),
          eq(templateLookupFormats.registry, body.registry),
        );
        if (body.formatId !== null) {
          const target = await tx
            .select({ id: templateLookupFormats.id })
            .from(templateLookupFormats)
            .where(and(scope, eq(templateLookupFormats.id, body.formatId)))
            .limit(1)
            .for("update");
          if (target.length === 0) {
            throw new HandlerError({
              status: 404,
              message: "Saved format not found",
            });
          }
        }
        const previous = await tx
          .update(templateLookupFormats)
          .set({ preference: LOOKUP_FORMAT_PREFERENCE.SAVED })
          .where(
            and(
              scope,
              eq(
                templateLookupFormats.preference,
                LOOKUP_FORMAT_PREFERENCE.DEFAULT,
              ),
            ),
          )
          .returning({ id: templateLookupFormats.id });
        if (body.formatId !== null) {
          await tx
            .update(templateLookupFormats)
            .set({ preference: LOOKUP_FORMAT_PREFERENCE.DEFAULT })
            .where(and(scope, eq(templateLookupFormats.id, body.formatId)));
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          changes: {
            defaultLookupFormat: {
              old: {
                registry: body.registry,
                formatId: previous.at(0)?.id ?? null,
              },
              new: { registry: body.registry, formatId: body.formatId },
            },
          },
        });
      }),
    );
    return Result.ok({ success: true });
  },
);

const deleteConfig = {
  permissions: { template: ["delete"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: t.Object({ formatId: tSafeId("templateLookupFormat") }),
} satisfies HandlerConfig;

export const deleteLookupFormat = createSafeRootHandler(
  deleteConfig,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .delete(templateLookupFormats)
          .where(
            and(
              eq(
                templateLookupFormats.organizationId,
                session.activeOrganizationId,
              ),
              eq(templateLookupFormats.id, params.formatId),
            ),
          )
          .returning({ id: templateLookupFormats.id });
        const deleted = rows.at(0);
        if (deleted) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE_LOOKUP_FORMAT,
            resourceId: deleted.id,
          });
        }
      }),
    );
    return Result.ok({});
  },
);
