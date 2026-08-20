import { Result } from "better-result";
import { t } from "elysia";

import { TEMPLATE_PACK_SLUG_PATTERN } from "@stll/template-packs/schema";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { withDescription } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  canInstallTemplatePacks,
  getTemplatePackCatalogue,
  toTemplatePackView,
  type TemplatePackTemplateView,
  type TemplatePackView,
} from "./catalogue";
import {
  readInstalledPackTemplates,
  readTemplatePackOrganizationContext,
} from "./organization-context";

export const templatePackParamsSchema = t.Object({
  packId: t.String({
    minLength: 1,
    maxLength: 64,
    pattern: TEMPLATE_PACK_SLUG_PATTERN.source,
  }),
});

const getTemplatePackQuerySchema = t.Object({
  locale: t.Optional(
    withDescription(
      t.String({ minLength: 2, maxLength: 35 }),
      "BCP-47 tag of the caller's interface language",
    ),
  ),
});

const config = {
  description:
    "Read one bundled template pack: attribution (drafters, reviewers, " +
    "converters), license and license URL, source, disclaimer, review date, " +
    "jurisdictions, languages, and every template with its README, field " +
    "list and, when already installed in the organization, the installed " +
    "template id. Also reports whether the organization hides pack offers.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  access: "read",
  params: templatePackParamsSchema,
  query: getTemplatePackQuerySchema,
} satisfies HandlerConfig;

export type TemplatePackDetailTemplate = TemplatePackTemplateView & {
  readme: string;
  installedTemplateId: SafeId<"template"> | null;
};

export type TemplatePackDetail = Omit<TemplatePackView, "templates"> & {
  templates: TemplatePackDetailTemplate[];
  canInstall: boolean;
  /** Whether the organization hides pack offers. A display preference, not
   *  an access gate: a pack addressed by id still reads, as it does in the
   *  list. */
  hidden: boolean;
};

const getTemplatePack = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, memberRole, params, query }) {
    const pack = getTemplatePackCatalogue().get(params.packId);
    if (!pack) {
      return Result.err(
        new HandlerError({ status: 404, message: "Template pack not found" }),
      );
    }
    const organizationId = session.activeOrganizationId;
    const context = yield* Result.await(
      readTemplatePackOrganizationContext(safeDb, organizationId),
    );
    const installed = yield* Result.await(
      readInstalledPackTemplates(safeDb, { organizationId, packId: pack.id }),
    );
    const view = toTemplatePackView(pack, {
      countries: context.countries,
      locale: query.locale ?? null,
    });
    const readmeBySlug = new Map(
      pack.templates.map((template) => [template.slug, template.readme]),
    );

    const detailTemplates: TemplatePackDetailTemplate[] = [];
    for (const template of view.templates) {
      detailTemplates.push({
        ...template,
        readme: readmeBySlug.get(template.slug) ?? "",
        installedTemplateId: installed.get(template.slug) ?? null,
      });
    }

    const detail: TemplatePackDetail = {
      ...view,
      templates: detailTemplates,
      canInstall: canInstallTemplatePacks(memberRole),
      hidden: context.hidden,
    };
    return Result.ok(detail);
  },
);

export default getTemplatePack;
