import { describe, expect, test } from "bun:test";

import {
  createDocx,
  createEmptyDocument,
  endnote,
  FolioDocxReviewer,
  paragraph,
  run,
} from "@stll/folio-core/server";

import { loadDocxArchive } from "@/api/lib/docx-archive";

import {
  applyDocxCommentPolicy,
  inspectDocxComments,
  readDocxCommentTranslationUnits,
  resolveDocxToFinal,
} from "./docx-review";

const createReviewedDocx = async (): Promise<ArrayBuffer> => {
  const document = createEmptyDocument();
  document.package.document.content = [
    {
      type: "paragraph",
      content: [
        run("kept "),
        {
          type: "deletion",
          info: { id: 1, author: "Alice" },
          content: [run("deleted ")],
        },
        {
          type: "insertion",
          info: { id: 2, author: "Alice" },
          content: [run("inserted ")],
        },
        {
          type: "moveFrom",
          info: { id: 3, author: "Alice" },
          content: [run("old-position ")],
        },
        {
          type: "moveTo",
          info: { id: 3, author: "Alice" },
          content: [run("new-position ")],
        },
        { type: "commentRangeStart", id: 10 },
        run("anchor"),
        { type: "commentRangeEnd", id: 10 },
        { type: "commentReference", id: 10 },
      ],
    },
  ];
  document.package.document.comments = [
    {
      id: 10,
      author: "Reviewer",
      content: [paragraph([run("Original comment", { bold: true })])],
    },
  ];
  return await createDocx(document);
};

describe("DOCX final-view and comment handling", () => {
  test("resolves tracked revisions to Final and retains comments", async () => {
    const source = await createReviewedDocx();
    expect(await inspectDocxComments(source)).toEqual({ hasComments: true });

    const output = await resolveDocxToFinal(source);
    const reviewer = await FolioDocxReviewer.fromBuffer(output);

    expect(reviewer.getChanges()).toHaveLength(0);
    expect(
      reviewer
        .getContent()
        .map((block) => block.text)
        .join("\n"),
    ).toBe("kept inserted new-position anchor");
    expect(await readDocxCommentTranslationUnits(output)).toEqual([
      { id: 10, text: "Original comment" },
    ]);
  });

  test("applies each comment retention policy without changing attribution", async () => {
    const source = await resolveDocxToFinal(await createReviewedDocx());
    const translation = new Map([[10, "Translated comment"]]);
    const cases = [
      ["original", "Original comment"],
      ["original-and-translated", "Original comment\nTranslated comment"],
      ["translated", "Translated comment"],
    ] as const;

    const outputs = await Promise.all(
      cases.map(
        async ([policy]) =>
          await applyDocxCommentPolicy({
            source,
            output: source,
            policy,
            translations: translation,
          }),
      ),
    );
    const before = await loadDocxArchive(source);
    const beforeCommentsXml = await before.readEntryString("word/comments.xml");
    const unchangedPaths = Object.keys(before.zip.files).filter(
      (path) => path !== "word/comments.xml" && !before.zip.files[path]?.dir,
    );
    const inspected = await Promise.all(
      outputs.map(async (output) => {
        const [reviewer, after] = await Promise.all([
          FolioDocxReviewer.fromBuffer(output),
          loadDocxArchive(output),
        ]);
        const unchangedEntries = await Promise.all(
          unchangedPaths.map(async (path) => {
            const [beforeBytes, afterBytes] = await Promise.all([
              before.readEntryUint8(path),
              after.readEntryUint8(path),
            ]);
            return { beforeBytes, afterBytes };
          }),
        );
        return {
          comment: reviewer.getComments().at(0),
          commentsXml: await after.readEntryString("word/comments.xml"),
          unchangedEntries,
        };
      }),
    );

    for (const [index, [, expectedText]] of cases.entries()) {
      const result = inspected.at(index);
      expect(result).toBeDefined();
      if (!result) {
        continue;
      }
      expect(result.comment).toMatchObject({
        author: "Reviewer",
        text: expectedText,
        anchoredText: "anchor",
      });
      for (const { beforeBytes, afterBytes } of result.unchangedEntries) {
        expect(afterBytes).toEqual(beforeBytes);
      }
    }
    expect(inspected[0]?.commentsXml).toBe(beforeCommentsXml);
    expect(inspected[1]?.commentsXml).toContain("<w:b");
    expect(inspected[1]?.commentsXml).toContain("Original comment");
    expect(inspected[1]?.commentsXml).toContain("Translated comment");
    expect(inspected[2]?.commentsXml).not.toContain("Original comment");
  });

  test("persists Final for tracked revisions in a secondary story", async () => {
    const document = createEmptyDocument();
    const reference = endnote(document, [
      {
        type: "paragraph",
        content: [
          {
            type: "insertion",
            info: { id: 1, author: "Reviewer" },
            content: [run("final note")],
          },
        ],
      },
    ]);
    document.package.document.content = [
      { type: "paragraph", content: [run("Body"), reference] },
    ];
    const source = await createDocx(document);

    const output = await resolveDocxToFinal(source);
    const reviewer = await FolioDocxReviewer.fromBuffer(output);
    const endnoteStory = reviewer
      .listStories()
      .find(({ handle }) => handle.type === "endnote");
    expect(endnoteStory).toMatchObject({ text: "final note" });
    expect(
      endnoteStory
        ? reviewer.readReviewedStory({
            story: endnoteStory.handle,
            view: "current-markup",
          })?.changes
        : null,
    ).toEqual([]);
  });
});
