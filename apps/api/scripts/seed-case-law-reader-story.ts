/**
 * The case-law reader at its richest, for the marketing screenshots
 * (`apps/web/e2e/marketing/product-screenshots.spec.ts`, "public-data" and
 * "story-public-data-1"): one decision with the seeded user's highlights and
 * comments on the passages the shot scrolls to, and the decision's chat
 * already holding a question and an answer that cites the decision's own
 * paragraphs.
 *
 * Everything that names the decision lives in `CASE_LAW_READER_STORY`, so
 * filming another decision is a change to that constant alone: the anchors,
 * offsets and quotes are derived from the decision's AST, never typed in.
 */
import { panic } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { toChatDecisionPassageHref } from "@stll/api-contract";
import type {
  ReaderAnnotationColor,
  ReaderAnnotationStyle,
} from "@stll/api-contract/legal-reader-annotations";
import { isDocumentAst } from "@stll/legal-ast/document-ast";
import type { Block } from "@stll/legal-ast/document-ast";

import {
  caseLawDecisions,
  caseLawSources,
  chatMessages,
  chatThreads,
  legalReaderAnnotations,
} from "@/api/db/schema";
import {
  chatMessageContentFromMessage,
  createChatTextPart,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { locatePassages } from "@/api/handlers/legal-reader/annotations/locate.logic";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";

import { seedId } from "./seed-utils";

type StoryMark =
  | {
      key: string;
      kind: "highlight";
      /** The block anchor the words sit in. */
      anchor: string;
      /** The words, exactly as the block reads them. */
      quote: string;
      color: ReaderAnnotationColor;
      style: ReaderAnnotationStyle;
    }
  | {
      key: string;
      kind: "comment";
      anchor: string;
      quote: string;
      body: string;
    };

/** One run of the answer: plain prose, or a phrase citing a paragraph. */
type StoryAnswerRun = string | { cite: string; text: string };

type ReaderStory = {
  /** The decision, by the key the case-law seed stores it under. */
  decision: { adapterKey: string; caseNumber: string; language: string };
  threadTitle: string;
  createdAt: Date;
  /** In reading order: the capture scrolls to the first. */
  marks: readonly StoryMark[];
  question: string;
  answer: readonly StoryAnswerRun[];
};

/**
 * The decision the reader shots film, and what the seeded user has done on
 * it. The capture scrolls the reader to the first mark, so the marks sit in
 * one stretch of the body ("I. Podstata věci") that also carries the stored
 * analysis' margin note on p-7, and all of them share the frame.
 */
export const CASE_LAW_READER_STORY: ReaderStory = {
  decision: {
    adapterKey: "cz-us",
    caseNumber: "IV.ÚS 1394/24",
    language: "cs",
  },
  /** Also the capture spec's lookup key for the thread. */
  threadTitle: "Why the Court quashed the restitution rulings",
  createdAt: new Date("2026-07-20T09:30:00.000Z"),
  marks: [
    {
      key: "statutory-basis",
      kind: "highlight",
      anchor: "p-7",
      quote:
        "Restituční nárok stěžovatele vycházel z § 2 odst. 2 zákona č. 243/1992 Sb.",
      color: "yellow",
      style: "highlight",
    },
    {
      // On the framed paragraph itself, so a whole comment card sits in the
      // shot beside the AI note rather than below the frame's edge.
      key: "confiscation-comment",
      kind: "comment",
      anchor: "p-7",
      quote:
        "V roce 1942 mu byl veškerý majetek zkonfiskován ve prospěch Německé říše a po válce nebyl vrácen.",
      body: "Confiscated for the Reich in 1942 and never returned: the claim rests on § 2(2) of Act 243/1992, so the 1948 cut-off in the Land Act does not bite (Part VI.B(b)).",
    },
    {
      key: "extreme-conflict",
      kind: "highlight",
      anchor: "p-8",
      quote: "je v extrémním rozporu s obsahem soudního spisu",
      color: "yellow",
      style: "highlight",
    },
    {
      key: "fragebogen-comment",
      kind: "comment",
      anchor: "p-8",
      quote:
        "Přestože obsah dotazníku nebyl znám, obecné soudy vyložily jeho vyplnění paušálně jako snahu o získání říšského občanství",
      body: "Our strongest point: a questionnaire nobody has read cannot carry a finding of state unreliability. Pair it with Part VI.C on the Nazi pressure on the family.",
    },
    {
      key: "non-filing",
      kind: "highlight",
      anchor: "p-9",
      quote: "nepodal žádost o navrácení majetku",
      color: "sky",
      style: "underline",
    },
    {
      key: "non-filing-comment",
      kind: "comment",
      anchor: "p-9",
      quote:
        "Takový výklad ve svém důsledku popřel samotný smysl rozhodné právní úpravy",
      body: "Not filing under Act 128/1946 is no bar to the § 2(2) claim (Part VI.B(c)). Check whether the Land Office relies on the missing application in our file.",
    },
  ],
  question:
    "Why did the Court quash the decisions? Focus on the Fragebogen and the missing 1946 application.",
  answer: [
    "The Court quashed all three decisions on two independent grounds.\n\n",
    "**1. The Fragebogen finding was arbitrary.** The lower courts read the questionnaire as an attempt to obtain Reich citizenship, although ",
    { cite: "p-8", text: "its contents were never established" },
    ". The Court found that assessment ",
    { cite: "p-8", text: "in extreme conflict with the case file" },
    ": it ignored the sustained Nazi pressure on the family and disregarded the ",
    { cite: "p-132", text: "certificates of state reliability" },
    " altogether.\n\n",
    "**2. Not applying under Act No. 128/1946 is no bar.** Under § 2(2) of Act No. 243/1992 what matters is that ",
    {
      cite: "p-103",
      text: "the substantive conditions of the post-war claim were met",
    },
    ", not that a procedural application was lodged — and the state had in fact ",
    { cite: "p-102", text: "prevented the grandfather from applying" },
    ".\n\n",
    "**Takeaway:** a § 2(2) claim must not be assessed ",
    { cite: "p-92", text: "over-formalistically" },
    "; the formalism here amounted to arbitrariness ",
    { cite: "p-139", text: "contrary to Article 36(1) of the Charter" },
    ".",
  ],
};

type StoryScope = {
  organizationId: SafeId<"organization">;
  userId: string;
};

type StoryRowsInput = StoryScope & {
  blocks: readonly Block[];
  decisionId: SafeId<"caseLawDecision">;
};

/** Per user, so a seed aimed at another account never collides. */
const storySeedId = ({ organizationId, userId }: StoryScope, label: string) =>
  `${organizationId}:${userId}:case-law-reader-story:${label}`;

/** The highlight and comment rows, placed on the decision's own text. */
export const buildReaderStoryAnnotationRows = ({
  blocks,
  decisionId,
  organizationId,
  userId,
}: StoryRowsInput) => {
  const { marks } = CASE_LAW_READER_STORY;
  const located = locatePassages(
    blocks,
    marks.map(({ anchor, quote }) => ({ anchor, quote })),
  );
  if (located.status === "rejected") {
    return panic(
      `Reader story marks do not fit ${CASE_LAW_READER_STORY.decision.caseNumber}: ${located.issues
        .map(
          (issue) =>
            `${marks[issue.passageIndex]?.key ?? "?"}: ${issue.message}`,
        )
        .join("; ")}`,
    );
  }
  return marks.map((mark, index) => {
    const span = located.spans[index] ?? panic("A located mark has no span");
    // Spaced a minute apart: the margin reads oldest first.
    const createdAt = new Date(
      CASE_LAW_READER_STORY.createdAt.getTime() + index * 60_000,
    );
    return {
      id: seedId<"legalReaderAnnotation">(
        storySeedId({ organizationId, userId }, `mark-${mark.key}`),
      ),
      organizationId,
      userId,
      targetType: "decision" as const,
      targetId: decisionId,
      groupId: null,
      kind: mark.kind,
      visibility: "private" as const,
      color: mark.kind === "highlight" ? mark.color : null,
      style: mark.kind === "highlight" ? mark.style : null,
      body: mark.kind === "comment" ? mark.body : null,
      blockAnchorId: span.blockAnchorId,
      startOffset: span.startOffset,
      endOffset: span.endOffset,
      quote: span.quote,
      createdAt,
      updatedAt: createdAt,
    };
  });
};

/** The answer as Markdown, each citation a decision passage link. */
export const renderReaderStoryAnswer = (
  decisionId: SafeId<"caseLawDecision">,
): string =>
  CASE_LAW_READER_STORY.answer
    .map((run) =>
      typeof run === "string"
        ? run
        : `[${run.text}](${toChatDecisionPassageHref({ anchorId: run.cite, decisionId })})`,
    )
    .join("");

/** The decision's chat: one thread, the question and its cited answer. */
export const buildReaderStoryChatRows = ({
  blocks,
  decisionId,
  organizationId,
  userId,
}: StoryRowsInput) => {
  const anchors = new Set(blocks.map((block) => block.anchorId));
  for (const run of CASE_LAW_READER_STORY.answer) {
    if (typeof run !== "string" && !anchors.has(run.cite)) {
      return panic(
        `Reader story answer cites ${run.cite}, which ${CASE_LAW_READER_STORY.decision.caseNumber} does not have`,
      );
    }
  }
  const scope = { organizationId, userId };
  const threadId = seedId<"chatThread">(storySeedId(scope, "thread"));
  const askedAt = CASE_LAW_READER_STORY.createdAt;
  const answeredAt = new Date(askedAt.getTime() + 4000);
  const question = toPersistableChatMessage({
    id: seedId<"chatMessage">(storySeedId(scope, "question")),
    role: "user",
    parts: [createChatTextPart(CASE_LAW_READER_STORY.question)],
  });
  const answer = toPersistableChatMessage({
    id: seedId<"chatMessage">(storySeedId(scope, "answer")),
    role: "assistant",
    parts: [createChatTextPart(renderReaderStoryAnswer(decisionId))],
    metadata: { turnOutcome: { type: "completed" } },
  });
  return {
    thread: {
      id: threadId,
      organizationId,
      userId,
      workspaceId: null,
      title: CASE_LAW_READER_STORY.threadTitle,
      titleSource: "user" as const,
      subjectDecisionId: decisionId,
      contextMatterIds: [],
      dataWorkspaceIds: [],
      createdAt: askedAt,
      updatedAt: answeredAt,
    },
    messages: [
      { message: question, createdAt: askedAt },
      { message: answer, createdAt: answeredAt },
    ].map(({ message, createdAt }) => ({
      id: message.id,
      threadId,
      workspaceId: null,
      userId,
      role: message.role,
      content: chatMessageContentFromMessage(message),
      createdAt,
    })),
  };
};

const readStoryDecision = async (db: MaintenanceDb) => {
  const { adapterKey, caseNumber, language } = CASE_LAW_READER_STORY.decision;
  const [row] = await withAggregateTransaction(
    db,
    async (tx) =>
      await tx
        .select({
          id: caseLawDecisions.id,
          documentAst: caseLawDecisions.documentAst,
        })
        .from(caseLawDecisions)
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          and(
            eq(caseLawSources.adapterKey, adapterKey),
            eq(caseLawDecisions.caseNumber, caseNumber),
            eq(caseLawDecisions.language, language),
          ),
        )
        .limit(1),
  );
  if (row === undefined) {
    return panic(
      `Reader story decision ${adapterKey} ${caseNumber} (${language}) is not seeded`,
    );
  }
  if (!isDocumentAst(row.documentAst)) {
    return panic(
      `Reader story decision ${caseNumber} has no inline document AST to place marks on`,
    );
  }
  return { decisionId: row.id, blocks: row.documentAst.blocks };
};

/**
 * Seeds the story for one user. Idempotent: the rows have fixed ids and are
 * replaced on every run, the thread's messages going with it by cascade.
 */
export const seedCaseLawReaderStory = async ({
  db,
  organizationId,
  userId,
}: StoryScope & { db: MaintenanceDb }) => {
  const { blocks, decisionId } = await readStoryDecision(db);
  const input = { blocks, decisionId, organizationId, userId };
  const annotations = buildReaderStoryAnnotationRows(input);
  const chat = buildReaderStoryChatRows(input);
  await withAggregateTransaction(db, async (tx) => {
    // audit: skip — dev seed replaces its own fixed-id rows.
    await tx.delete(legalReaderAnnotations).where(
      inArray(
        legalReaderAnnotations.id,
        annotations.map(({ id }) => id),
      ),
    );
    await tx.delete(chatThreads).where(eq(chatThreads.id, chat.thread.id));
    await tx.insert(legalReaderAnnotations).values(annotations);
    await tx.insert(chatThreads).values(chat.thread);
    await tx.insert(chatMessages).values(chat.messages);
  });
  console.log(
    `  Case-law reader story: ${String(annotations.length)} marks, 1 thread on ${CASE_LAW_READER_STORY.decision.caseNumber}`,
  );
};
