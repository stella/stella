import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { workspaces } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage, encodePaginationCursor } from "@/api/lib/pagination";

import { WIP_LIMITS, wipQuerySchema } from "./config";
import { buildWipCurrencyQuery, buildWipMatterPageQuery } from "./query";
import {
  readWipInput,
  tooManyWipCurrencies,
  toWipCurrency,
} from "./read-input";

const listWip = createSafeRootHandler(
  {
    description:
      "List approved, unbilled client time at its recorded resolved rates and unbilled billable expenses, by accessible matter. Amounts and aged buckets are exact minor-unit integer strings, with no FX conversion. Expense values include recorded markup. Future work dates have age zero; asOf pins aging, not a historical snapshot. WIP is live and can change between requests. totalsByCurrency covers the entire matching scope, independent of the matter page. unpricedTimeEntryCount explicitly identifies entries without a priced snapshot. Reuse asOf and filters with nextCursor; use billing.wip.clients.list for complete client totals. Filter matterId for a per-matter view.",
    permissions: { workspace: ["read"], timeEntry: ["read"] },
    mcp: { type: "capability", reason: "billing_admin" },
    access: "read",
    query: wipQuerySchema,
  },
  async function* ({ safeDb, session, query }) {
    const input = yield* readWipInput(query, "matter");
    const scope = {
      organizationId: session.activeOrganizationId,
      ...(query.matterId ? { matterId: query.matterId } : {}),
      ...(query.clientId ? { clientId: query.clientId } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
    };
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        if (query.matterId) {
          const [matter] = await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(
              and(
                eq(workspaces.id, query.matterId),
                eq(workspaces.organizationId, session.activeOrganizationId),
              ),
            )
            .limit(1);
          if (!matter) {
            return Result.err(
              new HandlerError({
                status: 404,
                code: "wip_matter_not_found",
                message: "Matter not found",
                hint: "Call list_matters and choose an accessible matterId before billing.wip.list.",
              }),
            );
          }
        }
        const totals = await buildWipCurrencyQuery(tx, {
          ...scope,
          asOf: input.asOf,
        });
        if (totals.length > WIP_LIMITS.currenciesMax) {
          return Result.err(tooManyWipCurrencies());
        }
        const amounts = await buildWipMatterPageQuery(tx, {
          ...scope,
          asOf: input.asOf,
          limit: input.limit,
          ...(input.matterAfter ? { after: input.matterAfter } : {}),
        });
        // Matter membership and all its currency rows share one statement snapshot.
        const byMatter = new Map<
          string,
          {
            matterId: (typeof workspaces.$inferSelect)["id"];
            matterName: string;
            matterReference: string;
            clientId: (typeof workspaces.$inferSelect)["clientId"];
            clientName: string | null;
            currencies: ReturnType<typeof toWipCurrency>[];
          }
        >();
        for (const row of amounts) {
          const matter = byMatter.get(row.matterId);
          if (matter) {
            matter.currencies.push(toWipCurrency(row));
          } else {
            byMatter.set(row.matterId, {
              matterId: row.matterId,
              matterName: row.matterName,
              matterReference: row.matterReference,
              clientId: row.clientId,
              clientName: row.clientName,
              currencies: [toWipCurrency(row)],
            });
          }
        }
        const page = createCursorPage({
          rows: [...byMatter.values()],
          limit: input.limit,
          cursorForItem: (row) =>
            encodePaginationCursor([...input.scope, row.matterId]),
        });
        return Result.ok({
          ...page,
          asOf: input.asOf,
          totalsByCurrency: totals.map(toWipCurrency),
        });
      }),
    );
    return outcome;
  },
);
export default listWip;
