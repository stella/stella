import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { templates, templateVersions } from "@/api/db/schema";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import {
  mergeManifestWithDiscovery,
  readManifest,
  writeManifest,
} from "@/api/handlers/docx/template-manifest";
import type {
  DiscoveredField,
  DiscoveredTemplate,
  FieldMeta,
  TemplateManifest,
} from "@/api/handlers/docx/types";
import { isTemplateManifest } from "@/api/handlers/docx/types";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const buildVersionS3Key = (
  organizationId: SafeId<"organization">,
  templateId: SafeId<"template">,
  version: number,
) => `${organizationId}/templates/${templateId}/v${version}.docx`;

/** Every path discovery still found in the saved body, including nested
 *  loop-item paths (prefixed by their array root). A path absent from this set
 *  has no live `{{marker}}` (or condition/each reference) in the document. */
const collectDiscoveredPaths = (
  discovered: DiscoveredTemplate,
): Set<string> => {
  const paths = new Set<string>();
  const visit = (field: DiscoveredField, prefix: string): void => {
    const fullPath = prefix ? `${prefix}.${field.path}` : field.path;
    paths.add(fullPath);
    const itemFields = field.itemFields;
    for (const item of arrayOrEmpty(itemFields)) {
      visit(item, fullPath);
    }
  };
  for (const field of discovered.fields) {
    visit(field, "");
  }
  return paths;
};

/** A manifest field whose value is derived without any literal body `{{marker}}`
 *  at all (formula/condition derive a value from other fields; AI drafts/adapts
 *  in place). Such a field can legitimately survive a save even when discovery
 *  reports no path for it, so it is never treated as a deleted-marker orphan.
 *
 *  Lookup and composite fields are deliberately NOT here: they are marker-backed
 *  (a lookup fills `{{field}}` and its keyed `{{field.key}}` renderings; a
 *  composite joins its parts into one `{{field}}` marker), so a Studio edit that
 *  removes their last live marker must prune them like any other field. See
 *  {@link hasLiveMarker}. */
export const hasDerivedValueSource = (field: FieldMeta): boolean =>
  field.formula !== undefined ||
  field.condition !== undefined ||
  field.conditionAst !== undefined ||
  field.aiPrompt !== undefined ||
  field.aiAdapt === true;

/** Whether discovery still found a live `{{marker}}` backing this field. The
 *  bare `field.path` covers plain, composite, and the default lookup rendering.
 *  A lookup also renders keyed `{{field.key}}` markers off the SAME hit, and a
 *  keyed marker can outlive the bare one inside an `{{#each}}` loop (where
 *  `field.path` is the item-relative path `companies.krs` and only
 *  `companies.krs.full` survives discovery), so a live keyed-format path keeps
 *  the field too. */
export const hasLiveMarker = (
  field: FieldMeta,
  discoveredPaths: Set<string>,
): boolean =>
  discoveredPaths.has(field.path) ||
  (field.lookup?.formats.some((format) =>
    discoveredPaths.has(`${field.path}.${format.key}`),
  ) ??
    false);

const saveDocumentBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
  // Optional edited manifest (the Studio's field settings and conditions).
  // When present it is the base manifest, so the editor's field
  // metadata is persisted without a separate binary re-embed round-trip.
  // t.Unknown() (not t.String()) because Elysia auto-parses JSON-looking
  // multipart fields into objects; the handler validates the shape below.
  manifest: t.Optional(t.Unknown()),
});

const saveDocumentParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const config = {
  permissions: { template: ["update"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: saveDocumentParamsSchema,
  body: saveDocumentBodySchema,
} satisfies HandlerConfig;

// Persists a Folio-edited template body as a new immutable version. Folio
// preserves the embedded manifest + {{markers}} on round-trip; we still
// re-discover fields from the edited body and merge with the existing manifest
// so placeholders added/removed in the editor stay in sync with the fields.
const saveTemplateDocument = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, params, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const { templateId } = params;
    const { file, manifest: manifestJson } = body;

    // Parse the optional client manifest; ignore it if malformed and fall back
    // to the manifest embedded in the uploaded DOCX. Elysia may hand us either
    // the raw JSON string or an already-parsed object, so handle both.
    let clientManifest: TemplateManifest | undefined;
    if (manifestJson !== undefined) {
      let candidate: unknown = manifestJson;
      if (typeof manifestJson === "string") {
        const parsed = Result.try((): unknown => JSON.parse(manifestJson));
        candidate = Result.isError(parsed) ? undefined : parsed.value;
      }
      if (isTemplateManifest(candidate)) {
        clientManifest = candidate;
      }
    }

    if (file.type !== DOCX_MIME_TYPE) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid file type. Expected a DOCX file.",
        }),
      );
    }

    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.templates.findFirst({
          where: {
            id: { eq: templateId },
            organizationId: { eq: organizationId },
          },
          columns: {
            id: true,
            s3Key: true,
            currentVersion: true,
            manifest: true,
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Template not found" }),
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const [discovered, embeddedManifest] = await Promise.all([
      discoverTemplate(buffer),
      readManifest(buffer),
    ]);

    const baseManifest =
      clientManifest ?? embeddedManifest ?? existing.manifest;
    const fields = mergeManifestWithDiscovery(baseManifest, discovered);
    // mergeManifestWithDiscovery returns ResolvedField, which carries no
    // aiPrompt, so recover each field's AI settings from the source manifest
    // by path. Without this, saving a template silently disables its
    // AI-fillable (aiPrompt) and AI-adapted (aiAdapt) fields. Composite
    // parts + format, dependent optionsFrom, registry lookup, formula, date
    // format, and the fill hint are restored the same way.
    const sourceFieldByPath = new Map(
      arrayOrEmpty(baseManifest?.fields).map((f) => [f.path, f]),
    );
    const fieldMetas: FieldMeta[] = fields.map((f) => ({
      path: f.path,
      label: f.label,
      hint: f.hint,
      inputType: f.inputType,
      options: f.options,
      validation: f.validation,
      required: f.required,
      aiPrompt: sourceFieldByPath.get(f.path)?.aiPrompt,
      aiAdapt: sourceFieldByPath.get(f.path)?.aiAdapt,
      aiSeesDocument: sourceFieldByPath.get(f.path)?.aiSeesDocument,
      parts: sourceFieldByPath.get(f.path)?.parts,
      format: sourceFieldByPath.get(f.path)?.format,
      optionsFrom: sourceFieldByPath.get(f.path)?.optionsFrom,
      lookup: sourceFieldByPath.get(f.path)?.lookup,
      formula: sourceFieldByPath.get(f.path)?.formula,
      condition: sourceFieldByPath.get(f.path)?.condition,
      conditionAst: sourceFieldByPath.get(f.path)?.conditionAst,
      dateFormat: sourceFieldByPath.get(f.path)?.dateFormat,
    }));

    // Drop orphaned fields: a Studio edit can delete a `{{field}}` marker from
    // the body without a separate field-delete action, but the client manifest
    // still carries that field, so the merge re-adds it as a manifest-only
    // field. Such a field has no live marker (discovery did not find its path or
    // any keyed lookup-format path) and no marker-less derived value source, so
    // persisting it would keep the Fill tab prompting for a value the document
    // can never use. Marker-backed lookup/composite fields are pruned once their
    // last marker is gone; only genuinely marker-less derived fields
    // (formula/condition/AI) survive without one.
    const discoveredPaths = collectDiscoveredPaths(discovered);
    const prunedFieldMetas = fieldMetas.filter(
      (field) =>
        hasLiveMarker(field, discoveredPaths) || hasDerivedValueSource(field),
    );

    const manifest: TemplateManifest = {
      version: baseManifest?.version ?? 1,
      fields: prunedFieldMetas,
    };

    // Re-embed the merged manifest so the stored DOCX stays in sync with the DB.
    const updatedDocx = await writeManifest(buffer, manifest);

    // Advisory lock, then allocate the version, write its S3 object, and commit
    // the row + version insert — all under the lock. Allocating the version and
    // writing S3 *outside* the lock let two overlapping saves pick the same vN,
    // write the same key (one clobbering the other), and leave the committed
    // version pointing at the loser's bytes.
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${templateId}))`,
        );

        // Re-read under the lock: a concurrent save that already committed will
        // have bumped currentVersion, so the next version is read fresh here.
        const [locked] = await tx
          .select({
            currentVersion: templates.currentVersion,
            s3Key: templates.s3Key,
          })
          .from(templates)
          .where(
            and(
              eq(templates.id, templateId),
              eq(templates.organizationId, organizationId),
            ),
          );
        if (!locked) {
          return { ok: false as const, reason: "not-found" as const };
        }

        const versionCount = await tx.$count(
          templateVersions,
          eq(templateVersions.templateId, templateId),
        );

        if (versionCount >= LIMITS.templateVersionsPerTemplate) {
          return { ok: false as const, reason: "limit" as const };
        }

        const newVersion = locked.currentVersion + 1;
        const versionS3Key = buildVersionS3Key(
          organizationId,
          templateId,
          newVersion,
        );
        // Under the lock: only concurrent saves of this same template wait, and
        // they must serialize anyway so vN's bytes aren't overwritten before the
        // version row commits.
        await getS3().write(versionS3Key, new Uint8Array(updatedDocx));

        const [row] = await tx
          .update(templates)
          .set({
            manifest,
            fieldCount: manifest.fields.length,
            sizeBytes: updatedDocx.byteLength,
            s3Key: versionS3Key,
            currentVersion: newVersion,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(templates.id, templateId),
              eq(templates.organizationId, organizationId),
            ),
          )
          .returning({
            id: templates.id,
            name: templates.name,
            fieldCount: templates.fieldCount,
            updatedAt: templates.updatedAt,
          });

        await tx.insert(templateVersions).values({
          id: createSafeId<"templateVersion">(),
          organizationId,
          templateId,
          version: newVersion,
          s3Key: versionS3Key,
          manifest,
          fieldCount: manifest.fields.length,
          createdBy: user.id,
        });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
          resourceId: templateId,
          workspaceId: null,
          changes: {
            currentVersion: { old: locked.currentVersion, new: newVersion },
            s3Key: { old: locked.s3Key, new: versionS3Key },
            fieldCount: { old: null, new: manifest.fields.length },
          },
        });

        if (!row) {
          // The update targeted a row the locked re-read just confirmed exists;
          // a missing returning row means it vanished mid-transaction.
          return { ok: false as const, reason: "not-found" as const };
        }
        return { ok: true as const, row };
      }),
    );

    if (!txResult.ok) {
      if (txResult.reason === "not-found") {
        return Result.err(
          new HandlerError({ status: 404, message: "Template not found" }),
        );
      }
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Version limit reached for this template",
        }),
      );
    }

    return Result.ok(txResult.row);
  },
);

export default saveTemplateDocument;
