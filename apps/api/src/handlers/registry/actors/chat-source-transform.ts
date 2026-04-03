import type { UIMessageChunk } from "ai";
import { and, eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { entities, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";

const SOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "readEntity",
  "readContent",
  "readContentAcrossMatters",
]);

const DEFAULT_KIND = "document";
const FILE_FIELD_RE = /^\[file: (.+)\]$/;

type ToolField = { value: string };

// TODO: FIXME — this is a bit of a hack to get the type system to work
const isToolField = (x: unknown): x is ToolField =>
  typeof x === "object" &&
  x !== null &&
  "value" in x &&
  typeof x.value === "string";

/** Extract a display name from a readEntity tool output.
 *  Prefers entity.name, falls back to the first file field's
 *  filename (formatted as `[file: name]` by the tool). */
const nameFromReadEntity = (output: Record<string, unknown>): string | null => {
  if (typeof output.name === "string" && output.name) {
    return output.name;
  }

  // readEntity formats file fields as "[file: <name>]".
  if (Array.isArray(output.fields)) {
    for (const field of output.fields) {
      if (isToolField(field)) {
        const match = field.value.match(FILE_FIELD_RE);
        // oxlint-disable-next-line typescript/strict-boolean-expressions -- match is RegExpMatchArray | null
        if (match?.[1]) {
          return match[1];
        }
      }
    }
  }

  return null;
};

/** Extract mimeType from a readEntity tool output's fields.
 *  The file field value is formatted as `[file: name.ext]`. */
const extractMimeType = (output: Record<string, unknown>): string | null => {
  if (!Array.isArray(output.fields)) {
    return null;
  }
  for (const field of output.fields) {
    if (isToolField(field)) {
      const match = field.value.match(FILE_FIELD_RE);
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- match is RegExpMatchArray | null
      if (match) {
        const name = match[1];
        if (typeof name === "string" && name.endsWith(".pdf")) {
          return "application/pdf";
        }
        if (typeof name === "string" && name.endsWith(".docx")) {
          return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        }
      }
    }
  }
  return null;
};

type EntityMeta = {
  name: string;
  kind: string;
  mimeType: string | null;
};

/** Look up entity display name via DB. Falls back to the
 *  first file field's filename when entity.name is null. */
const nameFromDb = async (
  entityId: string,
  workspaceId: SafeId<"workspace">,
  scopedDb: ScopedDb,
): Promise<EntityMeta | null> => {
  const entity = await scopedDb((tx) =>
    tx.query.entities.findFirst({
      where: {
        id: entityId,
        workspaceId: { eq: workspaceId },
      },
      columns: { name: true, kind: true },
      with: {
        currentVersion: {
          columns: {},
          with: {
            fields: {
              columns: { content: true },
            },
          },
        },
      },
    }),
  );
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- findFirst returns T | undefined
  if (!entity) {
    return null;
  }

  let name = entity.name;
  let mimeType: string | null = null;

  const fileField = entity.currentVersion?.fields.find(
    (f) =>
      f.content !== null &&
      typeof f.content === "object" &&
      "type" in f.content &&
      f.content.type === "file",
  );

  if (
    fileField?.content &&
    typeof fileField.content === "object" &&
    "fileName" in fileField.content
  ) {
    if (typeof fileField.content.fileName === "string" && !name) {
      name = fileField.content.fileName;
    }
    if (
      "mimeType" in fileField.content &&
      typeof fileField.content.mimeType === "string"
    ) {
      mimeType = fileField.content.mimeType;
    }
  }

  return {
    name: name ?? "Untitled",
    kind: entity.kind,
    mimeType,
  };
};

/** Org-scoped fallback: look up entity by ID within the
 *  organization (no workspace filter). Used for cross-matter
 *  results from searchAcrossMatters / readContentAcrossMatters. */
const nameFromDbOrgScoped = async (
  entityId: string,
  organizationId: SafeId<"organization">,
  scopedDb: ScopedDb,
): Promise<EntityMeta | null> => {
  // Find which workspace this entity belongs to within
  // the organization. Uses a JOIN so the DB never returns
  // data from another org (no fetch-then-check).
  const rows = await scopedDb((tx) =>
    tx
      .select({ workspaceId: entities.workspaceId })
      .from(entities)
      .innerJoin(workspaces, eq(entities.workspaceId, workspaces.id))
      .where(
        and(
          eq(entities.id, entityId),
          eq(workspaces.organizationId, organizationId),
        ),
      )
      .limit(1),
  );
  const row = rows.at(0);

  if (!row) {
    return null;
  }

  // Delegate to workspace-scoped lookup for full metadata.
  return nameFromDb(entityId, row.workspaceId, scopedDb);
};

/**
 * Creates a TransformStream that intercepts `readEntity` and
 * `readContent` tool outputs and injects `source-document`
 * UI-only chunks. These chunks pass through
 * `toUIMessageStream()` but are dropped by
 * `convertToModelMessages()` (zero extra tokens).
 */
export const createSourceInjectionTransform = (
  workspaceId: SafeId<"workspace"> | null,
  organizationId: SafeId<"organization">,
  scopedDb: ScopedDb,
) => {
  const toolNames = new Map<string, string>();
  const emittedEntities = new Set<string>();
  const entityMeta = new Map<string, EntityMeta>();

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    async transform(chunk, controller) {
      controller.enqueue(chunk);

      if (chunk.type === "tool-input-start") {
        toolNames.set(chunk.toolCallId, chunk.toolName);
        return;
      }

      if (chunk.type !== "tool-output-available") {
        return;
      }

      const toolName = toolNames.get(chunk.toolCallId);
      if (!toolName || !SOURCE_TOOL_NAMES.has(toolName)) {
        return;
      }

      if (!isRecord(chunk.output)) {
        return;
      }
      const output = chunk.output;
      if ("error" in output) {
        return;
      }

      const entityId = output.entityId;
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- output from AI SDK (unknown)
      if (!entityId || typeof entityId !== "string") {
        return;
      }
      if (emittedEntities.has(entityId)) {
        return;
      }

      emittedEntities.add(entityId);

      // Cache metadata from readEntity outputs.
      if (toolName === "readEntity") {
        const name = nameFromReadEntity(output);
        const kind =
          typeof output.kind === "string" ? output.kind : DEFAULT_KIND;
        const mimeType = extractMimeType(output);
        if (name) {
          entityMeta.set(entityId, { name, kind, mimeType });
        }
      }

      // Cache metadata from readContentAcrossMatters output.
      if (
        toolName === "readContentAcrossMatters" &&
        typeof output.name === "string" &&
        output.name
      ) {
        entityMeta.set(entityId, {
          name: output.name,
          kind: DEFAULT_KIND,
          mimeType: null,
        });
      }

      let meta = entityMeta.get(entityId);

      // Fallback: look up entity from DB.
      // Try workspace-scoped first, then org-scoped
      // for cross-matter results.
      if (!meta) {
        try {
          const dbMeta = workspaceId
            ? ((await nameFromDb(entityId, workspaceId, scopedDb)) ??
              (await nameFromDbOrgScoped(entityId, organizationId, scopedDb)))
            : await nameFromDbOrgScoped(entityId, organizationId, scopedDb);
          if (dbMeta) {
            meta = dbMeta;
            entityMeta.set(entityId, meta);
          }
        } catch {
          // DB lookup failure should not abort the stream;
          // the source chip will fall back to "Untitled".
        }
      }

      controller.enqueue({
        type: "source-document",
        sourceId: entityId,
        mediaType: meta?.mimeType ?? "application/octet-stream",
        title: meta?.name ?? "Untitled",
        providerMetadata: {
          stella: {
            entityId,
            workspaceId,
            kind: meta?.kind ?? DEFAULT_KIND,
            mimeType: meta?.mimeType ?? null,
          },
        },
      });
    },
  });
};
