import { describe, expect, test } from "bun:test";
import * as slimdom from "slimdom";

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

const createThreadedReviewedDocx = async (): Promise<{
  replyId: number;
  source: ArrayBuffer;
}> => {
  const reviewer = await FolioDocxReviewer.fromBuffer(
    await resolveDocxToFinal(await createReviewedDocx()),
  );
  const reply = reviewer.replyTo(10, {
    author: "Reply reviewer",
    text: "Original reply",
  });
  if (!reply || !reviewer.resolveComment("10")) {
    throw new Error("Could not construct the threaded comment fixture");
  }
  return { replyId: reply.id, source: await reviewer.toBuffer() };
};

const W14_NAMESPACE = "http://schemas.microsoft.com/office/word/2010/wordml";
const W15_NAMESPACE = "http://schemas.microsoft.com/office/word/2012/wordml";

const referencedCommentParaIds = (commentsExtendedXml: string): string[] => {
  const document = slimdom.parseXmlDocument(commentsExtendedXml);
  const ids: string[] = [];
  for (const comment of document.getElementsByTagNameNS(
    W15_NAMESPACE,
    "commentEx",
  )) {
    const paraId = comment.getAttributeNS(W15_NAMESPACE, "paraId");
    const parentParaId = comment.getAttributeNS(W15_NAMESPACE, "paraIdParent");
    if (paraId) {
      ids.push(paraId);
    }
    if (parentParaId) {
      ids.push(parentParaId);
    }
  }
  return [...new Set(ids)].toSorted();
};

const commentParagraphIds = (commentsXml: string): string[] => {
  const document = slimdom.parseXmlDocument(commentsXml);
  const ids: string[] = [];
  for (const commentParagraph of document.getElementsByTagNameNS(
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "p",
  )) {
    const paraId = commentParagraph.getAttributeNS(W14_NAMESPACE, "paraId");
    if (paraId) {
      ids.push(paraId);
    }
  }
  return [...new Set(ids)].toSorted();
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

  test("preserves threaded and resolved comment metadata for every policy", async () => {
    const { replyId, source } = await createThreadedReviewedDocx();
    const sourceArchive = await loadDocxArchive(source);
    const sourceExtendedXml = await sourceArchive.readEntryString(
      "word/commentsExtended.xml",
    );
    if (sourceExtendedXml === null) {
      throw new Error("Threaded fixture is missing its comments extension");
    }
    const translations = new Map([
      [10, "Translated root"],
      [replyId, "Translated reply"],
    ]);
    const cases = [
      ["original", "Original comment", "Original reply"],
      [
        "original-and-translated",
        "Original comment\nTranslated root",
        "Original reply\nTranslated reply",
      ],
      ["translated", "Translated root", "Translated reply"],
    ] as const;

    const inspected = await Promise.all(
      cases.map(async ([policy, expectedRoot, expectedReply]) => {
        const output = await applyDocxCommentPolicy({
          source,
          output: source,
          policy,
          translations,
        });
        const [reviewer, archive] = await Promise.all([
          FolioDocxReviewer.fromBuffer(output),
          loadDocxArchive(output),
        ]);
        const [commentsXml, extendedXml] = await Promise.all([
          archive.readEntryString("word/comments.xml"),
          archive.readEntryString("word/commentsExtended.xml"),
        ]);
        if (commentsXml === null || extendedXml === null) {
          throw new Error("Translated fixture lost its comment parts");
        }
        return {
          commentsXml,
          expectedReply,
          expectedRoot,
          extendedXml,
          root: reviewer.getComments().at(0),
        };
      }),
    );

    for (const {
      commentsXml,
      expectedReply,
      expectedRoot,
      extendedXml,
      root,
    } of inspected) {
      expect(root).toMatchObject({
        id: 10,
        author: "Reviewer",
        done: true,
        text: expectedRoot,
        replies: [
          {
            id: replyId,
            author: "Reply reviewer",
            text: expectedReply,
          },
        ],
      });
      expect(extendedXml).toBe(sourceExtendedXml);
      expect(commentParagraphIds(commentsXml)).toEqual(
        referencedCommentParaIds(extendedXml),
      );
    }
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
