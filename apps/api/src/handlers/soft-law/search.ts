import { Result } from "better-result";

import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  decodeSoftLawCursor,
  encodeSoftLawCursor,
  searchServedSoftLaw,
} from "@/api/lib/legal-search/soft-law-read";
import { SOFT_LAW_READ_SURFACE } from "@/api/lib/legal-search/soft-law-serving";

import {
  searchSoftLawBodySchema,
  searchSoftLawResponseSchema,
} from "./read-schema";

const SOFT_LAW_SEARCH_DEFAULT_LIMIT = 20;

const config = {
  contract: "patch",
  description:
    "Full-text search regulator guidance (soft law) served by stella: methodologies, " +
    "opinions, guidelines, recommendations, FAQs and similar documents, never court decisions. " +
    "Every result names its issuer, document kind, publisher URL and required attribution. " +
    "Filter by authority, jurisdiction, kind and issue date; paginate with limit and cursor. " +
    "Totals are not counted.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "tool", name: "search_guidance" },
  access: "read",
  body: searchSoftLawBodySchema,
  response: searchSoftLawResponseSchema,
} satisfies HandlerConfig;

const searchSoftLaw = createSafeRootHandler(
  config,
  async function* ({ body: { cursor, limit, query, ...filters } }) {
    const offset = cursor === undefined ? 0 : decodeSoftLawCursor(cursor);
    const page =
      offset === null
        ? null
        : yield* Result.await(
            Result.tryPromise(
              async () =>
                await searchServedSoftLaw({
                  ...filters,
                  query,
                  offset,
                  limit: limit ?? SOFT_LAW_SEARCH_DEFAULT_LIMIT,
                  surface: SOFT_LAW_READ_SURFACE.people,
                }),
            ),
          );
    return Result.ok(
      page === null
        ? status(400, { message: "Invalid cursor" })
        : {
            items: page.items,
            nextCursor:
              page.nextOffset === null
                ? null
                : encodeSoftLawCursor(page.nextOffset),
          },
    );
  },
);

export default searchSoftLaw;
