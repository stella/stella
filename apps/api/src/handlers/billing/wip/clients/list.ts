import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { workspaces } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage, encodePaginationCursor } from "@/api/lib/pagination";

import { WIP_LIMITS, wipQuerySchema } from "../config";
import { buildWipCurrencyQuery, buildWipClientPageQuery } from "../query";
import {
  readWipInput,
  tooManyWipCurrencies,
  toWipCurrency,
} from "../read-input";

const listWipClients = createSafeRootHandler(
  {
    description:
      "List complete client WIP totals across accessible matters, grouped by currency with aged buckets and no FX conversion. Amounts are exact minor-unit integer strings. A row with clientId and clientName null is the explicit unassigned-client bucket. Future work dates have age zero; asOf pins aging, not a historical snapshot. WIP is live and can change between requests. totalsByCurrency covers the matching scope independently of the client page. Reuse asOf and filters with nextCursor. Use billing.wip.list to inspect matter totals or filter matterId for one matter.",
    permissions: { workspace: ["read"], timeEntry: ["read"] },
    mcp: { type: "capability", reason: "billing_admin" },
    access: "read",
    query: wipQuerySchema,
  },
  async function* ({ safeDb, session, query }) {
    const input = yield* readWipInput(query, "client");
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
                hint: "Call list_matters and choose an accessible matterId before billing.wip.clients.list.",
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
        const amounts = await buildWipClientPageQuery(tx, {
          ...scope,
          asOf: input.asOf,
          limit: input.limit,
          ...(input.clientAfter === undefined
            ? {}
            : { after: input.clientAfter }),
        });
        const byClient = new Map<
          string,
          {
            clientId: (typeof workspaces.$inferSelect)["clientId"];
            clientName: string | null;
            key: string;
            currencies: ReturnType<typeof toWipCurrency>[];
          }
        >();
        for (const row of amounts) {
          const client = byClient.get(row.key);
          if (client) {
            client.currencies.push(toWipCurrency(row));
          } else {
            byClient.set(row.key, {
              clientId: row.clientId,
              clientName: row.clientName,
              key: row.key,
              currencies: [toWipCurrency(row)],
            });
          }
        }
        const page = createCursorPage({
          rows: [...byClient.values()],
          limit: input.limit,
          cursorForItem: (row) =>
            encodePaginationCursor([...input.scope, row.key]),
        });
        return Result.ok({
          ...page,
          asOf: input.asOf,
          totalsByCurrency: totals.map(toWipCurrency),
          items: page.items.map((row) => ({
            clientId: row.clientId,
            clientName: row.clientName,
            currencies: row.currencies,
          })),
        });
      }),
    );
    return outcome;
  },
);
export default listWipClients;
