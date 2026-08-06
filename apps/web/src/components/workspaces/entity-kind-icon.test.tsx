import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { ENTITY_KINDS } from "@stll/api-contract";

import {
  EntityIcon,
  EntityKindIcon,
} from "@/components/workspaces/entity-kind-icon";

// lucide tags every glyph with a `lucide-<name>` class, which identifies
// the drawing independently of the sizing/colour classes a caller passes.
const glyphOf = (markup: string): string | undefined =>
  markup
    .split('"')
    .flatMap((chunk) => chunk.split(" "))
    .find((token) => token.startsWith("lucide-"));

const kindGlyph = (kind: (typeof ENTITY_KINDS)[number], status?: string) =>
  glyphOf(renderToStaticMarkup(<EntityKindIcon kind={kind} status={status} />));

describe("EntityKindIcon", () => {
  // Declared set equals drawn set, in both directions: a kind added to
  // ENTITY_KINDS without a glyph fails the switch's `never` check at
  // compile time, and a kind quietly mapped onto another's glyph fails
  // here.
  test("every kind draws a distinct glyph", () => {
    const glyphs = ENTITY_KINDS.map((kind) => kindGlyph(kind));

    expect(glyphs.filter((glyph) => glyph !== undefined)).toHaveLength(
      ENTITY_KINDS.length,
    );
    expect(new Set(glyphs).size).toBe(ENTITY_KINDS.length);
  });

  test("no kind draws the unresolved placeholder", () => {
    const placeholder = glyphOf(
      renderToStaticMarkup(<EntityIcon source={{ type: "unknown" }} />),
    );

    expect(placeholder).toBeDefined();
    for (const kind of ENTITY_KINDS) {
      expect(kindGlyph(kind)).not.toBe(placeholder);
    }
  });

  // A status glyph asserts a status. Rendering one for a task whose status
  // the caller never had (chat mentions read an entity endpoint that does
  // not return it) labels every done task "open".
  test("a task without a status does not draw a status glyph", () => {
    const statusless = kindGlyph("task");

    expect(statusless).toBeDefined();
    expect(statusless).not.toBe(kindGlyph("task", "open"));
    expect(statusless).not.toBe(kindGlyph("task", "done"));
    expect(kindGlyph("task", "done")).not.toBe(kindGlyph("task", "cancelled"));
  });
});
