import { Result } from "better-result";
import { t } from "elysia";

import type { TemplatePackCatalogue } from "@stll/template-packs";

import type { SafeDb } from "@/api/db/safe-db";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type {
  HandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tPaginationCursor, withDescription } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type { MemberRole } from "@/api/lib/member-roles";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  type Page,
} from "@/api/lib/pagination";

import {
  canInstallTemplatePacks,
  getTemplatePackCatalogue,
  rankTemplatePacks,
  type TemplatePackView,
} from "./catalogue";
import {
  readInstalledPackCounts,
  readTemplatePackOrganizationContext,
} from "./organization-context";

const listTemplatePacksQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.templatePacksPageSizeMax }),
  ),
  cursor: t.Optional(tPaginationCursor({ maxChars: 128 })),
  locale: t.Optional(
    withDescription(
      t.String({ minLength: 2, maxLength: 35 }),
      "BCP-47 tag of the caller's interface language; packs in that language rank first",
    ),
  ),
});

const config = {
  description:
    "List the template packs bundled with this deployment, ranked for the " +
    "organization: packs covering one of its practice jurisdictions first, " +
    "then jurisdiction-agnostic packs, then the rest, with packs in the " +
    "caller's language ahead within each group. Each pack carries its " +
    "attribution, license, jurisdictions, languages, template list and how " +
    "many of its templates are already installed. Also reports whether the " +
    "organization hides pack offers and whether the caller may install.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  access: "read",
  query: listTemplatePacksQuerySchema,
} satisfies HandlerConfig;

export type TemplatePackListItem = TemplatePackView & {
  installedCount: number;
};

export type TemplatePackListResult = Page<TemplatePackListItem> & {
  hidden: boolean;
  canInstall: boolean;
};

const decodeIndexCursor = (cursor: string): number | null => {
  const index = decodePaginationCursor(cursor)?.at(0);
  return typeof index === "number" && Number.isInteger(index) && index >= 0
    ? index
    : null;
};

export type ListTemplatePacksProps = {
  catalogue: TemplatePackCatalogue;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  memberRole: { role: MemberRole };
  query: { limit?: number; cursor?: string; locale?: string };
};

export const listTemplatePacksHandler = async function* ({
  catalogue,
  safeDb,
  organizationId,
  memberRole,
  query,
}: ListTemplatePacksProps): SafeHandlerGenerator<TemplatePackListResult> {
  const limit = query.limit ?? LIMITS.templatePacksPageSizeDefault;
  const start = query.cursor ? decodeIndexCursor(query.cursor) : 0;
  if (start === null) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid cursor" }),
    );
  }

  const context = yield* Result.await(
    readTemplatePackOrganizationContext(safeDb, organizationId),
  );
  const installedCounts = yield* Result.await(
    readInstalledPackCounts(safeDb, organizationId),
  );

  const ranked = rankTemplatePacks(catalogue.list(), {
    countries: context.countries,
    locale: query.locale ?? null,
  });
  // The cursor is the rank index, so each row carries the position it was
  // taken from rather than deriving it again after the page is cut.
  const rows = ranked
    .slice(start, start + limit + 1)
    .map((view, offset) => ({ view, index: start + offset }));
  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (row) => encodePaginationCursor([row.index + 1]),
  });

  const items: TemplatePackListItem[] = [];
  for (const { view } of page.items) {
    items.push({ ...view, installedCount: installedCounts.get(view.id) ?? 0 });
  }

  return Result.ok({
    items,
    nextCursor: page.nextCursor,
    limit: page.limit,
    hidden: context.hidden,
    canInstall: canInstallTemplatePacks(memberRole),
  });
};

const listTemplatePacks = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, memberRole, query }) {
    return yield* listTemplatePacksHandler({
      catalogue: getTemplatePackCatalogue(),
      safeDb,
      organizationId: session.activeOrganizationId,
      memberRole,
      query,
    });
  },
);

export default listTemplatePacks;
