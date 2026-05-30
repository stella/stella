/**
 * Image-insertion / -deletion tracked-change round-trip tests.
 *
 * Port of eigenpal docx-editor #641 ("track inserted/deleted images as tracked
 * changes"). A picture that is itself a tracked change must:
 *
 * 1. carry the `insertion` / `deletion` mark on the atomic image PM node
 *    (the image schema has `marks: "_"` so the leaf atom accepts marks);
 * 2. serialize back into a `<w:ins>` / `<w:del>` wrapper around the
 *    drawing-bearing run;
 * 3. reload on the next parse with the mark re-applied.
 *
 * Background: folio's tracked-change model previously surfaced only on text
 * runs, so an inserted picture round-tripped as untracked content.
 */

import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "prosemirror-model";

import type { Document, Paragraph } from "../../types/document";
import { schema } from "../schema";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

const PNG_DATA_URL = "data:image/png;base64,AA==";

function makeMarkedImageDoc(
  markName: "insertion" | "deletion",
  revisionId: number,
): PMNode {
  // SAFETY: real editor schema has both insertion and deletion marks.
  const mark = schema.marks[markName]!.create({
    revisionId,
    author: "Reviewer",
    date: "2026-05-30T00:00:00Z",
  });
  // SAFETY: real editor schema has the image node.
  const image = schema.nodes["image"]!.create({
    src: PNG_DATA_URL,
    width: 80,
    height: 60,
  });
  const markedImage = image.mark(mark.addToSet(image.marks));
  // SAFETY: real editor schema has the paragraph node.
  const paragraph = schema.nodes["paragraph"]!.create({}, [markedImage]);
  // SAFETY: real editor schema has the doc node.
  return schema.nodes["doc"]!.create({}, [paragraph]);
}

function firstParagraph(doc: Document): Paragraph | undefined {
  const block = doc.package.document.content.at(0);
  return block?.type === "paragraph" ? block : undefined;
}

describe("tracked image insertion round-trip", () => {
  test("inserted image serializes inside a <w:ins> wrapper", () => {
    const pmDoc = makeMarkedImageDoc("insertion", 200);
    const result = fromProseDoc(pmDoc);
    const paragraph = firstParagraph(result);
    expect(paragraph).toBeDefined();

    const insertion = paragraph?.content.find(
      (item) => item.type === "insertion",
    );
    expect(insertion).toBeDefined();
    if (insertion?.type !== "insertion") {
      return;
    }
    expect(insertion.info.id).toBe(200);
    expect(insertion.info.author).toBe("Reviewer");

    const innerRun = insertion.content.at(0);
    expect(innerRun?.type).toBe("run");
    if (innerRun?.type !== "run") {
      return;
    }
    expect(innerRun.content.at(0)?.type).toBe("drawing");
  });

  test("inserted image reloads with the insertion mark re-applied", () => {
    const pmDoc = makeMarkedImageDoc("insertion", 201);
    const result = fromProseDoc(pmDoc);
    const reloaded = toProseDoc(result);

    let markedImages = 0;
    reloaded.descendants((node) => {
      if (
        node.type.name === "image" &&
        node.marks.some((m) => m.type.name === "insertion")
      ) {
        markedImages += 1;
      }
      return true;
    });
    expect(markedImages).toBe(1);
  });

  test("deleted image serializes inside a <w:del> wrapper", () => {
    const pmDoc = makeMarkedImageDoc("deletion", 300);
    const result = fromProseDoc(pmDoc);
    const paragraph = firstParagraph(result);
    expect(paragraph).toBeDefined();

    const deletion = paragraph?.content.find(
      (item) => item.type === "deletion",
    );
    expect(deletion).toBeDefined();
    if (deletion?.type !== "deletion") {
      return;
    }
    expect(deletion.info.id).toBe(300);

    const innerRun = deletion.content.at(0);
    expect(innerRun?.type).toBe("run");
    if (innerRun?.type !== "run") {
      return;
    }
    expect(innerRun.content.at(0)?.type).toBe("drawing");
  });

  test("deleted image reloads with the deletion mark re-applied", () => {
    const pmDoc = makeMarkedImageDoc("deletion", 301);
    const result = fromProseDoc(pmDoc);
    const reloaded = toProseDoc(result);

    let markedImages = 0;
    reloaded.descendants((node) => {
      if (
        node.type.name === "image" &&
        node.marks.some((m) => m.type.name === "deletion")
      ) {
        markedImages += 1;
      }
      return true;
    });
    expect(markedImages).toBe(1);
  });

  test("parses <w:ins><w:r><w:drawing>...</w:drawing></w:r></w:ins>", () => {
    // Regression guard: the parser path that constructs this Document and the
    // toProseDoc mapping must re-apply the insertion mark on the atomic image
    // node — a leaf atom whose schema doesn't list `marks: "_"` would lose
    // the mark silently.
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "insertion",
                  info: {
                    id: 42,
                    author: "Reviewer",
                    date: "2026-05-30T00:00:00Z",
                  },
                  content: [
                    {
                      type: "run",
                      content: [
                        {
                          type: "drawing",
                          image: {
                            type: "image",
                            rId: "rIdImg1",
                            src: PNG_DATA_URL,
                            size: { width: 914_400, height: 457_200 },
                            wrap: { type: "inline" },
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };

    const pmDoc = toProseDoc(document);
    let imageMark: { name: string; revisionId: unknown } | null = null;
    pmDoc.descendants((node) => {
      if (node.type.name === "image") {
        const m = node.marks.at(0);
        if (m) {
          imageMark = {
            name: m.type.name,
            revisionId: m.attrs["revisionId"],
          };
        }
      }
      return true;
    });
    expect(imageMark).not.toBeNull();
    expect(imageMark!.name).toBe("insertion");
    expect(imageMark!.revisionId).toBe(42);
  });

  test("tracked text still round-trips (regression: do not gate on allowsMarkType alone)", () => {
    // A leaf text node's own markSet is empty, so
    // `text.allowsMarkType(insertion) === false` even though the paragraph
    // permits the mark. The `node.isText` short-circuit must stay or every
    // tracked text load/round-trip collapses to plain text.
    // SAFETY: real editor schema has the insertion mark and paragraph/doc.
    const insertionMark = schema.marks["insertion"]!.create({
      revisionId: 500,
      author: "Reviewer",
      date: "2026-05-30T00:00:00Z",
    });
    const paragraph = schema.nodes["paragraph"]!.create({}, [
      schema.text("added text", [insertionMark]),
    ]);
    const pmDoc = schema.nodes["doc"]!.create({}, [paragraph]);

    const result = fromProseDoc(pmDoc);
    const reloaded = toProseDoc(result);

    let markedTextRuns = 0;
    reloaded.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === "insertion")) {
        markedTextRuns += 1;
      }
      return true;
    });
    expect(markedTextRuns).toBeGreaterThan(0);
  });
});
