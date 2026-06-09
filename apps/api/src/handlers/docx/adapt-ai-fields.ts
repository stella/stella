/**
 * Per-occurrence adaptation of AI-adapted template fields.
 *
 * A manifest field with `aiAdapt` holds a user-written stub (e.g. "czech
 * law"); at fill time a model rewrites the stub to fit the surrounding text
 * of each `{{path}}` occurrence — in inflected languages (Czech, Polish) the
 * same canonical value is declined differently per sentence, so one global
 * substitution cannot be correct.
 *
 * This runs as a pre-pass on the template buffer before `fillTemplate`: each
 * occurrence is patched with its own rendering, and the stub stays in the
 * fill values so any occurrence the model could not cover (or any failure)
 * degrades to the plain global substitution instead of leaving a marker.
 *
 * Like `resolveAiFields`, this module stays free of any model dependency:
 * the fill boundary injects the adapter (see `buildAiOccurrenceAdapter`).
 */

import JSZip from "jszip";

import { placeholderPattern, resolvePath } from "@stll/template-conditions";

import { HEADER_FOOTER_RE } from "./ooxml";
import { partParagraphTexts, patchXmlPartPerOccurrence } from "./rich-patch";
import type { FieldMeta } from "./types";

/** Characters of surrounding document text captured around each occurrence. */
const CONTEXT_RADIUS = 400;

export type MarkerOccurrence = {
  /** Surrounding document text, with the `{{path}}` marker left in place so
   *  the model sees exactly where the rendering will sit. */
  context: string;
};

export type AiOccurrenceAdapter = (input: {
  /** The user-entered canonical value to adapt. */
  stub: string;
  fieldPath: string;
  label: string | undefined;
  /** The field's drafting instruction (`aiPrompt`), if any. */
  prompt: string | undefined;
  occurrences: readonly MarkerOccurrence[];
}) => Promise<string[] | undefined>;

export type AdaptAiFieldsResult = {
  buffer: Buffer;
  /** Paths whose markers were all replaced occurrence-by-occurrence; their
   *  stub values no longer match a placeholder, so callers should drop them
   *  from "unused value" diagnostics. */
  adaptedPaths: string[];
};

type AdaptAiFieldsOptions = {
  buffer: Buffer;
  fields: readonly FieldMeta[];
  /** Already-entered + previously-resolved fill values (stub lookup). */
  values: Record<string, unknown>;
  adapt: AiOccurrenceAdapter | undefined;
};

export const adaptAiFields = async ({
  buffer,
  fields,
  values,
  adapt,
}: AdaptAiFieldsOptions): Promise<AdaptAiFieldsResult> => {
  const unchanged: AdaptAiFieldsResult = { buffer, adaptedPaths: [] };
  if (adapt === undefined) {
    return unchanged;
  }

  const targets = fields.flatMap((field) => {
    if (field.aiAdapt !== true) {
      return [];
    }
    // The fill form nests dotted paths; the chat tool sends flat keys.
    // resolvePath handles both (same reasoning as resolveAiFields).
    const stub = resolvePath(field.path, values);
    if (typeof stub !== "string" || stub.trim() === "") {
      return [];
    }
    return [{ field, stub }];
  });
  if (targets.length === 0) {
    return unchanged;
  }

  const zip = await JSZip.loadAsync(buffer);
  // Sorted for a deterministic occurrence order; the patch pass below walks
  // the same list, so occurrence indices always line up with extraction.
  const partNames = Object.keys(zip.files)
    .filter(
      (name) => name === "word/document.xml" || HEADER_FOOTER_RE.test(name),
    )
    .sort();
  const parts: { name: string; xml: string }[] = [];
  for (const name of partNames) {
    const entry = zip.file(name);
    if (!entry) {
      continue;
    }
    parts.push({ name, xml: await entry.async("string") });
  }

  const targetPaths = new Set(targets.map((target) => target.field.path));
  const occurrencesByPath = collectOccurrences(parts, targetPaths);

  const renderingsByPath = new Map<string, readonly string[]>();
  for (const { field, stub } of targets) {
    const occurrences = occurrencesByPath.get(field.path) ?? [];
    if (occurrences.length === 0) {
      continue;
    }
    const renderings = await adapt({
      stub,
      fieldPath: field.path,
      label: field.label,
      prompt: field.aiPrompt,
      occurrences,
    });
    // A count mismatch would mis-align every later occurrence; fall back to
    // the global stub fill for the whole field instead.
    if (renderings === undefined || renderings.length !== occurrences.length) {
      continue;
    }
    renderingsByPath.set(field.path, renderings);
  }
  if (renderingsByPath.size === 0) {
    return unchanged;
  }

  const counters = new Map<string, number>();
  let anyChanged = false;
  for (const part of parts) {
    const patched = patchXmlPartPerOccurrence(
      part.xml,
      renderingsByPath,
      counters,
    );
    if (patched.changed) {
      zip.file(part.name, patched.xml);
      anyChanged = true;
    }
  }
  if (!anyChanged) {
    return unchanged;
  }

  return {
    buffer: Buffer.from(await zip.generateAsync({ type: "nodebuffer" })),
    adaptedPaths: [...renderingsByPath.keys()],
  };
};

const collectOccurrences = (
  parts: readonly { xml: string }[],
  targetPaths: ReadonlySet<string>,
): Map<string, MarkerOccurrence[]> => {
  const result = new Map<string, MarkerOccurrence[]>();
  for (const part of parts) {
    const texts = partParagraphTexts(part.xml);
    const joined = texts.join("\n");
    let offset = 0;
    for (const text of texts) {
      for (const match of text.matchAll(placeholderPattern())) {
        const key = match[1];
        if (key === undefined || !targetPaths.has(key)) {
          continue;
        }
        const start = offset + match.index;
        const end = start + match[0].length;
        const context = joined.slice(
          Math.max(0, start - CONTEXT_RADIUS),
          Math.min(joined.length, end + CONTEXT_RADIUS),
        );
        const occurrences = result.get(key) ?? [];
        occurrences.push({ context });
        result.set(key, occurrences);
      }
      offset += text.length + 1; // +1 for the joining newline
    }
  }
  return result;
};
