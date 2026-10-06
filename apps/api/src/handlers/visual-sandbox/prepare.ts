import { Result, TaggedError } from "better-result";

import type { GeneratedVisualInput } from "@stll/api-contract/generated-visual";

import { collectLiteralVisualLinks } from "./literal-links";
import { sanitizeVisualHtml } from "./sanitize";

export class VisualDefinitionError extends TaggedError(
  "VisualDefinitionError",
)<{
  message: string;
  reason: "title" | "data" | "links";
}> {}

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unreferencedDataKey = (data: unknown, html: string) => {
  const pending: unknown[] = [data];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const child of current) {
        pending.push(child);
      }
      continue;
    }
    if (!isRow(current)) {
      continue;
    }
    for (const [field, child] of Object.entries(current)) {
      if (!html.includes(field)) {
        return field;
      }
      pending.push(child);
    }
  }
  return null;
};

export const prepareGeneratedVisual = (input: GeneratedVisualInput) => {
  const title = input.title.trim();
  if (title.length === 0) {
    return Result.err(
      new VisualDefinitionError({
        reason: "title",
        message: "Give the visual a nonempty title.",
      }),
    );
  }
  const normalized = sanitizeVisualHtml(input.html);
  if (normalized.isErr()) {
    return normalized;
  }
  const unused = unreferencedDataKey(input.data, normalized.value);
  if (unused !== null) {
    return Result.err(
      new VisualDefinitionError({
        reason: "data",
        message: `Remove unreferenced data key ${unused}, or reference it literally in the page.`,
      }),
    );
  }
  const ids = new Set<string>();
  for (const link of input.links ?? []) {
    if (ids.has(link.id)) {
      return Result.err(
        new VisualDefinitionError({
          reason: "links",
          message: `Give decision link ${link.id} one unique identifier.`,
        }),
      );
    }
    ids.add(link.id);
  }
  return Result.ok({
    title,
    html: normalized.value,
    data: input.data,
    links: input.links ?? [],
    literalLinks: collectLiteralVisualLinks(normalized.value),
  });
};
