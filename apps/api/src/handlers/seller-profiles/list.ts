import { Result } from "better-result";
import { and, desc, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { sellerProfiles } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedSellerProfileId } from "@/api/lib/safe-id-boundaries";

const config = {
  description:
    "List active issuer profiles for the active organization, newest first, " +
    "with cursor pagination. Bank details are included for billing setup.",
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "billing_admin" },
  access: "read",
  query: t.Object({
    limit: t.Optional(
      t.Integer({ minimum: 1, maximum: LIMITS.sellerProfilesPageSizeMax }),
    ),
    cursor: t.Optional(tPaginationCursor()),
  }),
} satisfies HandlerConfig;

const cursorCodec = createTimestampIdCursorCodec({
  column: sellerProfiles.createdAt,
  brandId: brandPersistedSellerProfileId,
});

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, query }) {
    const limit = query.limit ?? LIMITS.sellerProfilesPageSizeDefault;
    const conditions = [
      eq(sellerProfiles.organizationId, session.activeOrganizationId),
      isNull(sellerProfiles.archivedAt),
    ];
    if (query.cursor) {
      const cursor = cursorCodec.decode(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const after = cursorCodec.keysetAfter({
        cursor,
        idColumn: sellerProfiles.id,
        direction: "descending",
      });
      if (after) {
        conditions.push(after);
      }
    }
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: sellerProfiles.id,
            legalName: sellerProfiles.legalName,
            registrationId: sellerProfiles.registrationId,
            vatId: sellerProfiles.vatId,
            addressLine1: sellerProfiles.addressLine1,
            addressLine2: sellerProfiles.addressLine2,
            city: sellerProfiles.city,
            postalCode: sellerProfiles.postalCode,
            country: sellerProfiles.country,
            iban: sellerProfiles.iban,
            bic: sellerProfiles.bic,
            accountNumber: sellerProfiles.accountNumber,
            defaultCurrency: sellerProfiles.defaultCurrency,
            footerNotes: sellerProfiles.footerNotes,
            isDefault: sellerProfiles.isDefault,
            createdAt: sellerProfiles.createdAt,
            updatedAt: sellerProfiles.updatedAt,
            createdAtCursor: cursorCodec.cursorValue.as("created_at_cursor"),
          })
          .from(sellerProfiles)
          .where(and(...conditions))
          .orderBy(desc(sellerProfiles.createdAt), desc(sellerProfiles.id))
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (row) => cursorCodec.encode(row.createdAtCursor, row.id),
    });
    return Result.ok({
      ...page,
      items: page.items.map(({ createdAtCursor: _cursor, ...row }) => row),
    });
  },
);
