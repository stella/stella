import { Result } from "better-result";
import { t } from "elysia";

import type { TemplatePackCatalogue } from "@stll/template-packs";
import { TEMPLATE_PACK_SLUG_PATTERN } from "@stll/template-packs/schema";

import type { SafeDb } from "@/api/db/safe-db";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type {
  HandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, withDescription } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type { MemberRole } from "@/api/lib/member-roles";
import { createStoredTemplate } from "@/api/lib/templates/create-template";

import {
  canInstallTemplatePacks,
  getTemplatePackCatalogue,
} from "../catalogue";
import { templatePackParamsSchema } from "../get";
import { readInstalledPackTemplates } from "../organization-context";

const installTemplatePackBodySchema = t.Object({
  templateSlugs: withDescription(
    t.Array(
      t.String({
        minLength: 1,
        maxLength: 64,
        pattern: TEMPLATE_PACK_SLUG_PATTERN.source,
      }),
      { minItems: 1, maxItems: LIMITS.templatePackInstallTemplatesMax },
    ),
    "Slugs of the pack templates to copy into the organization's library",
  ),
  categoryId: t.Optional(tSafeId("templateCategory")),
});

const config = {
  description:
    "Copy templates from a bundled pack into the organization's template " +
    "library as ordinary templates with a first version; each records the " +
    "pack, version, slug, content hash, license and authors it came from. " +
    "Pass the pack id and the template slugs. A template already installed " +
    "from the same pack is reported as such and not copied again, so a " +
    "request that failed part way through can simply be repeated. Owners " +
    "and admins only.",
  permissions: { template: ["create"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: templatePackParamsSchema,
  body: installTemplatePackBodySchema,
} satisfies HandlerConfig;

export const TEMPLATE_PACK_INSTALL_STATUSES = [
  "installed",
  "already-installed",
] as const;
export type TemplatePackInstallStatus =
  (typeof TEMPLATE_PACK_INSTALL_STATUSES)[number];

export type TemplatePackInstallItem = {
  slug: string;
  status: TemplatePackInstallStatus;
  templateId: SafeId<"template">;
};

export type InstallTemplatePackProps = {
  catalogue: TemplatePackCatalogue;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  memberRole: { role: MemberRole };
  packId: string;
  body: { templateSlugs: string[]; categoryId?: SafeId<"templateCategory"> };
  recordAuditEvent: AuditRecorder;
  createStoredTemplate?: typeof createStoredTemplate;
};

export const installTemplatePackHandler = async function* ({
  catalogue,
  safeDb,
  organizationId,
  userId,
  memberRole,
  packId,
  body,
  recordAuditEvent,
  createStoredTemplate: createTemplate = createStoredTemplate,
}: InstallTemplatePackProps): SafeHandlerGenerator<{
  items: TemplatePackInstallItem[];
}> {
  if (!canInstallTemplatePacks(memberRole)) {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "Only owners and admins can install template packs",
      }),
    );
  }
  const pack = catalogue.get(packId);
  if (!pack) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template pack not found" }),
    );
  }
  const slugs = [...new Set(body.templateSlugs)];
  const unknownSlug = slugs.find(
    (slug) => !pack.templates.some((template) => template.slug === slug),
  );
  if (unknownSlug !== undefined) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Template "${unknownSlug}" is not in this pack`,
      }),
    );
  }

  const installed = yield* Result.await(
    readInstalledPackTemplates(safeDb, { organizationId, packId }),
  );

  // Read every missing template's bytes up front: one round of parallel
  // reads instead of one read per template inside the insert loop.
  const docxBySlug = new Map(
    await Promise.all(
      slugs
        .filter((slug) => !installed.has(slug))
        .map(
          async (slug) =>
            [slug, await catalogue.readTemplateDocx({ packId, slug })] as const,
        ),
    ),
  );

  // Each template is its own storage write, so a failure part way through
  // leaves the earlier ones installed. That is recoverable rather than
  // partial state to unwind: the request is idempotent, so repeating it
  // installs exactly what is still missing.
  const items: TemplatePackInstallItem[] = [];
  for (const slug of slugs) {
    const existingId = installed.get(slug);
    if (existingId) {
      items.push({ slug, status: "already-installed", templateId: existingId });
      continue;
    }
    const template = catalogue.getTemplate({ packId, slug });
    const docx = docxBySlug.get(slug);
    if (!template || !docx) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Bundled template content is unavailable",
        }),
      );
    }
    if (Result.isError(docx)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Bundled template content is unavailable",
          cause: docx.error,
        }),
      );
    }
    const created = yield* createTemplate({
      safeDb,
      organizationId,
      userId,
      buffer: Buffer.from(docx.value.bytes),
      name: template.title,
      fileName: docx.value.fileName,
      categoryId: body.categoryId,
      origin: {
        type: "bundled-pack",
        packId: pack.id,
        packVersion: pack.version,
        slug,
        contentHash: docx.value.sha256,
        license: template.license,
        authors: [...pack.authors],
      },
      recordAuditEvent,
    });
    if (Result.isError(created)) {
      return Result.err(created.error);
    }
    items.push({
      slug,
      status: "installed",
      templateId: created.value.id,
    });
  }

  return Result.ok({ items });
};

const installTemplatePack = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    params,
    body,
    recordAuditEvent,
  }) {
    return yield* installTemplatePackHandler({
      catalogue: getTemplatePackCatalogue(),
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      memberRole,
      packId: params.packId,
      body,
      recordAuditEvent,
    });
  },
);

export default installTemplatePack;
