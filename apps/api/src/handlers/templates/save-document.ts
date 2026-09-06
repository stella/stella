import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { tSafeId } from "@/api/lib/custom-schema";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import { readManifest, writeManifest } from "@/api/lib/docx/template-manifest";
import type {
  DiscoveredField,
  DiscoveredTemplate,
  FieldMeta,
  TemplateManifest,
} from "@/api/lib/docx/types";
import { isTemplateManifest } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { resolveTemplateFieldOverlay } from "@/api/lib/templates/field-overlay";
import { writeStoredTemplate } from "@/api/lib/templates/write-template";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

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

export const savedManifestFromDiscovery = ({
  manifest,
  discovered,
}: {
  manifest: TemplateManifest | null;
  discovered: DiscoveredTemplate;
}): TemplateManifest => {
  const resolvedManifest = resolveTemplateFieldOverlay({
    manifest,
    discovered,
    overlay: undefined,
  });
  const discoveredPaths = collectDiscoveredPaths(discovered);
  return {
    version: resolvedManifest.version,
    fields: resolvedManifest.fields.filter(
      (field) =>
        hasLiveMarker(field, discoveredPaths) || hasDerivedValueSource(field),
    ),
  };
};

const saveDocumentBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
  // Optional edited manifest (the Studio's field settings and conditions).
  // When present it is the base manifest, so the editor's field
  // metadata is persisted without a separate binary re-embed round-trip.
  // t.Unknown() (not t.String()) because the field is a JSON string over the
  // multipart HTTP body and an object when an MCP invocation calls the handler
  // directly; the handler validates the shape below.
  manifest: t.Optional(t.Unknown()),
});

const saveDocumentParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const config = {
  description:
    "Store an edited DOCX as the template's next version: the file becomes " +
    "the current body, the manifest is merged from the optional edited " +
    "manifest and what discovery finds in the document, fields whose markers " +
    "are gone are dropped unless they derive their value without one, and " +
    "the previous version stays in history. Refused once the template holds " +
    "its maximum number of versions.",
  permissions: { template: ["update"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  transport: {
    type: "file-input",
    input: { field: "file", required: true, mediaTypes: [DOCX_MIME_TYPE] },
    alternative: {
      type: "none",
      reason:
        "the new template version IS the edited DOCX body; no capability accepts that body as JSON",
    },
  },
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
    // to the manifest embedded in the uploaded DOCX. Either the raw JSON
    // string (HTTP) or an object (MCP) can arrive, so handle both.
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

    const written = yield* Result.await(
      Result.gen(() =>
        writeStoredTemplate({
          safeDb,
          organizationId,
          templateId,
          mode: { type: "new-version", userId: user.id },
          recordAuditEvent,
          async prepare({ manifest: currentManifest }) {
            const baseManifest =
              clientManifest ?? embeddedManifest ?? currentManifest;
            // Drop orphaned fields: a Studio edit can delete a `{{field}}` marker from
            // the body without a separate field-delete action, but the client manifest
            // still carries that field, so the merge re-adds it as a manifest-only
            // field. Such a field has no live marker (discovery did not find its path or
            // any keyed lookup-format path) and no marker-less derived value source, so
            // persisting it would keep the Fill tab prompting for a value the document
            // can never use. Marker-backed lookup/composite fields are pruned once their
            // last marker is gone; only genuinely marker-less derived fields
            // (formula/condition/AI) survive without one.
            const manifest = savedManifestFromDiscovery({
              manifest: baseManifest,
              discovered,
            });
            const updatedDocx = await writeManifest(buffer, manifest);
            return Result.ok({
              manifest,
              bytes: new Uint8Array(updatedDocx),
            });
          },
        }),
      ),
    );

    return Result.ok(written.row);
  },
);

export default saveTemplateDocument;
