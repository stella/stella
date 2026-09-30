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

describe("EntityKindIcon thumbnails", () => {
  const thumbnail = {
    fieldId: "field-1",
    hasThumbnail: true,
    workspaceId: "matter-1",
  };
  const documentIcon = (
    mimeType: string,
    fileThumbnail: typeof thumbnail | null,
  ) =>
    renderToStaticMarkup(
      <EntityKindIcon
        className="size-4 shrink-0"
        fileName="file"
        kind="document"
        mimeType={mimeType}
        thumbnail={fileThumbnail}
      />,
    );

  // The image sits next to the file name, so it takes the icon's box and
  // adds no second accessible name to the row.
  test("an image with a preview draws it, decorative, in the icon's box", () => {
    const markup = documentIcon("image/png", thumbnail);

    expect(markup).toStartWith("<img");
    expect(markup).toContain('alt=""');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('decoding="async"');
    expect(markup).toContain("/files/matter-1/thumbnail/field-1");
    expect(markup).toContain("size-4 shrink-0");
  });

  test("an image without a preview keeps its type icon", () => {
    const markup = documentIcon("image/png", {
      ...thumbnail,
      hasThumbnail: false,
    });

    expect(markup).not.toContain("<img");
    expect(glyphOf(markup)).toBe(glyphOf(documentIcon("image/png", null)));
  });

  test("a non-image keeps its type icon even when it has a preview", () => {
    expect(documentIcon("application/pdf", thumbnail)).not.toContain("<img");
  });
});
