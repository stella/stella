import { describe, expect, test } from "bun:test";
import path from "node:path";

import { parseChatDecisionPassageHref } from "@stll/api-contract";
import { READER_ANNOTATION_QUOTE_MAX_LENGTH } from "@stll/api-contract/legal-reader-annotations";
import type { PersistedDecisionAnalysis } from "@stll/legal-ast/analysis";
import { isDocumentAst, plainTextOf } from "@stll/legal-ast/document-ast";
import type { Block } from "@stll/legal-ast/document-ast";

import {
  chatMessageFromPersisted,
  chatPartText,
} from "@/api/handlers/chat/chat-message-parts";
import { toSafeId } from "@/api/lib/branded-types";
import { readGzipJson } from "@/api/lib/gzip-json";
import { PARSER_VERSIONS } from "@/api/lib/legal-search/ingestion-constants";

import { readCaseLawFixtureAnalyses } from "./lib/case-law-fixture-analyses";
import {
  CASE_LAW_READER_STORY,
  buildReaderStoryAnnotationRows,
  buildReaderStoryChatRows,
  renderReaderStoryAnswer,
} from "./seed-case-law-reader-story";

const { adapterKey, caseNumber, language } = CASE_LAW_READER_STORY.decision;

/** How many blocks from the first mark the capture's frame shows. */
const FRAMED_BLOCKS = 4;

type FixtureDecision = {
  case_number: string;
  language: string;
  document_ast: unknown;
  analysis: PersistedDecisionAnalysis | null;
  fulltext: string | null;
  parser_version: number | null;
};

// The story is seeded on the recorded decision, so it is tested on it too.
const storyDecision = async () => {
  const fixture = await readGzipJson(
    path.join(
      import.meta.dir,
      "__fixtures__",
      "case-law",
      `${adapterKey}.json.gz`,
    ),
  );
  // SAFETY: the recorded fixtures are checked into the repo; the fields read
  // here are validated below before use.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- repo-checked fixture
  const { decisions } = fixture as { decisions: FixtureDecision[] };
  const decision = decisions.find(
    (candidate) =>
      candidate.case_number === caseNumber && candidate.language === language,
  );
  if (decision === undefined || !isDocumentAst(decision.document_ast)) {
    throw new Error(`${caseNumber} is missing from the ${adapterKey} fixture`);
  }
  return {
    analysis: decision.analysis,
    blocks: decision.document_ast.blocks,
    fulltext: decision.fulltext,
    parserVersion: decision.parser_version,
  };
};

const scope = {
  decisionId: toSafeId<"caseLawDecision">(
    "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
  ),
  organizationId: toSafeId<"organization">("org_story"),
  userId: "user_story",
};

const textOf = (blocks: readonly Block[], anchorId: string) => {
  const block = blocks.find((candidate) => candidate.anchorId === anchorId);
  if (block?.type !== "paragraph" && block?.type !== "heading") {
    throw new Error(`No text block anchored ${anchorId}`);
  }
  return plainTextOf(block.inlines);
};

const passageLinks = (markdown: string) =>
  [...markdown.matchAll(/\]\(([^)\s]+)\)/gu)].map(([, href]) => href ?? "");

describe("the seeded case-law reader story", () => {
  test("every mark lands on the words it quotes in the decision's text", async () => {
    const { blocks } = await storyDecision();
    const rows = buildReaderStoryAnnotationRows({ ...scope, blocks });

    expect(rows).toHaveLength(CASE_LAW_READER_STORY.marks.length);
    for (const row of rows) {
      const text = textOf(blocks, row.blockAnchorId);
      expect(row.startOffset).toBeGreaterThanOrEqual(0);
      expect(row.endOffset).toBeGreaterThan(row.startOffset);
      expect(row.endOffset).toBeLessThanOrEqual(text.length);
      expect(row.quote.length).toBeGreaterThan(0);
      expect(row.quote.length).toBeLessThanOrEqual(
        READER_ANNOTATION_QUOTE_MAX_LENGTH,
      );
      expect(text.slice(row.startOffset, row.endOffset)).toBe(row.quote);
    }
  });

  test("rows satisfy the table's kind and span checks", async () => {
    const { blocks } = await storyDecision();
    const rows = buildReaderStoryAnnotationRows({ ...scope, blocks });
    const highlights = rows.filter((row) => row.kind === "highlight");
    const comments = rows.filter((row) => row.kind === "comment");

    // The shot promises a few highlights and at least one comment.
    expect(highlights.length).toBeGreaterThanOrEqual(2);
    expect(highlights.length).toBeLessThanOrEqual(4);
    expect(comments.length).toBeGreaterThanOrEqual(1);
    for (const row of highlights) {
      expect(row.color).not.toBeNull();
      expect(row.style).not.toBeNull();
      expect(row.body).toBeNull();
    }
    for (const row of comments) {
      expect(row.style).toBeNull();
      expect(row.body?.trim()).toBeTruthy();
    }
    for (const row of rows) {
      expect(row).toMatchObject({
        groupId: null,
        organizationId: scope.organizationId,
        targetId: scope.decisionId,
        targetType: "decision",
        userId: scope.userId,
      });
    }
  });

  test("the framed stretch carries an AI note, highlights and a comment", async () => {
    const { analysis, blocks } = await storyDecision();
    const rows = buildReaderStoryAnnotationRows({ ...scope, blocks });
    const tree = analysis !== null && "tree" in analysis ? analysis.tree : [];
    const noteAnchors = new Set(
      tree.flatMap((heading) =>
        heading.annotations.map((annotation) => annotation.startAnchorId),
      ),
    );
    const first = rows.at(0);
    // The capture scrolls to the first mark; a margin note must sit there.
    expect(first && noteAnchors.has(first.blockAnchorId)).toBe(true);

    // Every mark follows the first, so the scroll lands above all of them,
    // and the paragraphs on screen with it hold at least two highlights and
    // a comment: what the shot promises.
    const anchors = blocks.map((block) => block.anchorId);
    const firstIndex = anchors.indexOf(first?.blockAnchorId ?? "");
    const framed = rows.filter((row) => {
      const index = anchors.indexOf(row.blockAnchorId);
      expect(index).toBeGreaterThanOrEqual(firstIndex);
      return index - firstIndex < FRAMED_BLOCKS;
    });
    expect(
      framed.filter((row) => row.kind === "highlight").length,
    ).toBeGreaterThanOrEqual(2);
    expect(framed.some((row) => row.kind === "comment")).toBe(true);
  });

  test("ids are fixed per user, so a rerun replaces rather than duplicates", async () => {
    const { blocks } = await storyDecision();
    const once = buildReaderStoryAnnotationRows({ ...scope, blocks });
    const again = buildReaderStoryAnnotationRows({ ...scope, blocks });
    const colleague = buildReaderStoryAnnotationRows({
      ...scope,
      blocks,
      userId: "user_colleague",
    });

    expect(new Set(once.map(({ id }) => id)).size).toBe(once.length);
    expect(again.map(({ id }) => id)).toEqual(once.map(({ id }) => id));
    const colleagueIds = new Set(colleague.map(({ id }) => id));
    expect(once.some(({ id }) => colleagueIds.has(id))).toBe(false);
    expect(buildReaderStoryChatRows({ ...scope, blocks }).thread.id).not.toBe(
      buildReaderStoryChatRows({ ...scope, blocks, userId: "user_colleague" })
        .thread.id,
    );
  });

  test("a quote the decision does not contain stops the seed", async () => {
    const { blocks } = await storyDecision();
    const firstMarkAnchor = CASE_LAW_READER_STORY.marks.at(0)?.anchor;
    expect(blocks.some((block) => block.anchorId === firstMarkAnchor)).toBe(
      true,
    );
    const withoutFirstMark = blocks.filter(
      (block) => block.anchorId !== firstMarkAnchor,
    );

    expect(() =>
      buildReaderStoryAnnotationRows({ ...scope, blocks: withoutFirstMark }),
    ).toThrow(/do not fit/u);
  });

  test("every citation in the answer opens an existing paragraph of the decision", async () => {
    const { blocks } = await storyDecision();
    const anchors = new Set(blocks.map((block) => block.anchorId));
    const links = passageLinks(renderReaderStoryAnswer(scope.decisionId));
    const cited = CASE_LAW_READER_STORY.answer.filter(
      (run) => typeof run !== "string",
    );

    expect(links).toHaveLength(cited.length);
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) {
      const target = parseChatDecisionPassageHref(href);
      expect(target?.decisionId).toBe(scope.decisionId);
      expect(anchors.has(target?.anchorId ?? "")).toBe(true);
    }
  });

  test("an answer citing a paragraph the decision lacks stops the seed", async () => {
    const { blocks } = await storyDecision();
    const cited = CASE_LAW_READER_STORY.answer.find(
      (run) => typeof run !== "string",
    );
    const withoutCited = blocks.filter(
      (block) => typeof cited === "string" || block.anchorId !== cited?.cite,
    );

    expect(() =>
      buildReaderStoryChatRows({ ...scope, blocks: withoutCited }),
    ).toThrow(/does not have/u);
  });

  test("the chat reads back as the question and its cited answer", async () => {
    const { blocks } = await storyDecision();
    const { messages, thread } = buildReaderStoryChatRows({
      ...scope,
      blocks,
    });

    expect(thread).toMatchObject({
      organizationId: scope.organizationId,
      subjectDecisionId: scope.decisionId,
      title: CASE_LAW_READER_STORY.threadTitle,
      userId: scope.userId,
      workspaceId: null,
    });
    expect(messages.map(({ role }) => role)).toEqual(["user", "assistant"]);
    const [question, answer] = messages.map((row) =>
      chatMessageFromPersisted(row),
    );
    expect(messages.map(({ content }) => content.version)).toEqual([3, 3]);
    expect(question?.parts.map(chatPartText)).toEqual([
      CASE_LAW_READER_STORY.question,
    ]);
    expect(answer?.parts.map(chatPartText)).toEqual([
      renderReaderStoryAnswer(scope.decisionId),
    ]);
    expect(answer?.metadata?.turnOutcome).toEqual({ type: "completed" });
    expect(messages.every(({ threadId }) => threadId === thread.id)).toBe(true);
    // The answer follows the question, as a real turn would.
    expect(messages[1]?.createdAt.getTime()).toBeGreaterThan(
      messages[0]?.createdAt.getTime() ?? Infinity,
    );
  });
});

// The filmed decision's row was recorded from the public reader, not the
// database (see the fixtures README). A row the pipeline took for stale, or
// an analysis over other text, would be reparsed or dropped and take the
// shot's margin with it.
describe("the filmed decision's recorded row", () => {
  test("is current for its parser and carries its text", async () => {
    const { fulltext, parserVersion } = await storyDecision();
    const current = Object.entries(PARSER_VERSIONS).find(
      ([key]) => key === adapterKey,
    )?.[1];

    expect(current).toBeDefined();
    expect(parserVersion).toBe(current ?? null);
    expect(fulltext?.length ?? 0).toBeGreaterThan(0);
  });

  test("has an analysis computed over its own text and the current prompt", async () => {
    const entry = (await readCaseLawFixtureAnalyses())
      .flatMap((file) => file.entries)
      .find(
        (candidate) =>
          candidate.fixtureName === `${adapterKey}.json.gz` &&
          candidate.caseNumber === caseNumber,
      );

    expect(entry?.storedFingerprint).toBe(entry?.currentFingerprint ?? "");
    expect(entry?.matches).toBe(true);
  });
});
