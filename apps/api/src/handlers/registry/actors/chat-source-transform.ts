import type { UIMessageChunk } from "ai";

import { db } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

const SOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "readEntity",
  "readContent",
]);

const DEFAULT_KIND = "document";
const FILE_FIELD_RE = /^\[file: (.+)\]$/;

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
      if (
        typeof field === "object" &&
        field !== null &&
        "value" in field &&
        typeof field.value === "string"
      ) {
        const match = field.value.match(FILE_FIELD_RE);
        if (match) {
          return match[1];
        }
      }
    }
  }

  return null;
};

/** Look up entity display name via DB. Falls back to the
 *  first file field's filename when entity.name is null. */
const nameFromDb = async (
  entityId: string,
  workspaceId: SafeId<"workspace">,
): Promise<{ name: string; kind: string } | null> => {
  const entity = await db.query.entities.findFirst({
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
  });

  if (!entity) {
    return null;
  }

  let name = entity.name;
  if (!name) {
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
      "fileName" in fileField.content &&
      typeof fileField.content.fileName === "string"
    ) {
      name = fileField.content.fileName;
    }
  }

  return { name: name ?? "Untitled", kind: entity.kind };
};

/**
 * Creates a TransformStream that intercepts `readEntity` and
 * `readContent` tool outputs and injects `source-document`
 * UI-only chunks. These chunks pass through
 * `toUIMessageStream()` but are dropped by
 * `convertToModelMessages()` (zero extra tokens).
 */
export const createSourceInjectionTransform = (
  workspaceId: SafeId<"workspace">,
) => {
  const toolNames = new Map<string, string>();
  const emittedEntities = new Set<string>();
  const entityMeta = new Map<string, { name: string; kind: string }>();

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

      // SAFETY: chunk.output is typed as `unknown` by the AI
      // SDK. The tools always return JSON objects, so casting
      // to Record is sound after the typeof guard below.
      const output = chunk.output as Record<string, unknown> | null;
      if (!output || typeof output !== "object") {
        return;
      }
      if ("error" in output) {
        return;
      }

      const entityId = output.entityId;
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
        if (name) {
          entityMeta.set(entityId, { name, kind });
        }
      }

      let meta = entityMeta.get(entityId);

      // Fallback: look up entity display name from DB.
      if (!meta) {
        try {
          const dbMeta = await nameFromDb(entityId, workspaceId);
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
        mediaType: "application/octet-stream",
        title: meta?.name ?? "Untitled",
        providerMetadata: {
          stella: {
            entityId,
            workspaceId,
            kind: meta?.kind ?? DEFAULT_KIND,
          },
        },
      });
    },
  });
};
