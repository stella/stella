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
import { and, eq } from "drizzle-orm";

import { toChatDecisionPassageHref } from "@stll/api-contract";
import type {
  ReaderAnnotationColor,
  ReaderAnnotationStyle,
} from "@stll/api-contract/legal-reader-annotations";
import { courtParagraphNumbersByAnchor } from "@stll/legal-ast/court-paragraph-number";
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
 * it: a Supreme Court judgment on a board member's statutory guarantee to
 * the company's creditors (§ 159 odst. 3 o. z.). The capture scrolls the
 * reader to the first mark, in the court's paragraph [31], so the frame
 * holds the reasoning from [31] on with the stored analysis' margin note
 * on it, two highlights and a comment. The later marks sit further down, where a
 * reader who scrolls on finds them.
 *
 * The court numbers its paragraphs in the text ("[31]"), and the anchors
 * here name blocks of the decision's parse; the comments quote the court's
 * numbers, which stay right once a parser records them on the blocks.
 */
export const CASE_LAW_READER_STORY: ReaderStory = {
  decision: {
    adapterKey: "cz-ns",
    caseNumber: "27 Cdo 59/2022",
    language: "cs",
  },
  /** Also the capture spec's lookup key for the thread. */
  threadTitle: "Director's guarantee under § 159(3): when it arises",
  createdAt: new Date("2026-07-20T09:30:00.000Z"),
  marks: [
    {
      // On [31] itself, so the card stacks right under the analysis' note
      // for the same paragraph and the pair fits the frame together.
      key: "existence-comment",
      kind: "comment",
      anchor: "p-65",
      quote:
        "jednou z podmínek ručení podle § 159 odst. 3 o. z. je existence závazku",
      body: "Key point for creditor claims: the guarantee needs only the director's duty to compensate, performable rather than due (¶ 40), so we can sue him without the company or its administrator first demanding payment.",
    },
    {
      key: "open-question",
      kind: "highlight",
      anchor: "p-65",
      quote:
        "Otázka, zda se musí jednat o závazek splatný, však dosud v rozhodovací praxi dovolacího soudu nebyla řešena.",
      color: "yellow",
      style: "highlight",
    },
    {
      key: "performability",
      kind: "highlight",
      anchor: "p-68",
      quote:
        "Splnitelnost dluhu je dána okamžikem, od kterého je dlužník oprávněn závazek splnit.",
      color: "green",
      style: "highlight",
    },
    {
      key: "guarantee-arises",
      kind: "highlight",
      anchor: "p-74",
      quote:
        "ke vzniku jeho ručení tak postačí, je-li oprávněn svou povinnost k náhradě škody plnit",
      color: "sky",
      style: "underline",
    },
    {
      key: "adverse-costs-comment",
      kind: "comment",
      anchor: "p-87",
      quote:
        "musí vycházet z toho, že v případě jejího neúspěchu v řízení může společnosti vzniknout povinnost nahradit protistraně její náklady",
      body: "For board advice: before authorising a claim, record the adverse-costs risk. The careful-manager test is objective (¶ 44), and how the case later ended is irrelevant (¶ 47).",
    },
  ],
  question:
    "Does a creditor need the company to demand compensation from its director before suing him as guarantor under § 159(3)? And how is foreseeability of the loss judged?",
  answer: [
    "No demand is needed. The Court held that the guarantee arises once the director's debt to compensate the company can be performed; it does not have to be due.\n\n",
    "**1. Performability, not maturity.** The Court found that the words “although obliged to compensate” ",
    { cite: "p-66", text: "admit three readings" },
    " and distinguished ",
    { cite: "p-68", text: "performability, the moment the debtor may pay" },
    ", from ",
    { cite: "p-69", text: "maturity, which follows the creditor's demand" },
    ". Because the guarantee protects creditors, tying it to the company's demand would defeat its purpose: the company ",
    {
      cite: "p-72",
      text: "may be unable or unwilling to act against its own director",
    },
    ". It is therefore enough that ",
    { cite: "p-74", text: "the director is entitled to pay" },
    ".\n\n",
    "**2. Foreseeability is objective.** The question is whether ",
    {
      cite: "p-85",
      text: "an imaginary reasonably careful manager could recognise the risk",
    },
    ", not what this director knew. A director who sues on the company's behalf ",
    {
      cite: "p-87",
      text: "must assume the company may have to pay the other side's costs",
    },
    ", and judging him by how the case later ended is ",
    { cite: "p-88", text: "forbidden hindsight" },
    ".\n\n",
    "**Outcome:** both judgments were quashed and the case went to the Municipal Court in Prague, because ",
    {
      cite: "p-94",
      text: "guarantee claims belong to the regional courts at first instance",
    },
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

/**
 * The answer as Markdown, each citation a decision passage link carrying the
 * number the court printed on the cited paragraph, as a live answer's would.
 */
export const renderReaderStoryAnswer = (
  decisionId: SafeId<"caseLawDecision">,
  blocks: readonly Block[],
): string => {
  const numbers = courtParagraphNumbersByAnchor(blocks);
  return CASE_LAW_READER_STORY.answer
    .map((run) =>
      typeof run === "string"
        ? run
        : `[${run.text}](${toChatDecisionPassageHref({
            anchorId: run.cite,
            courtParagraphNumber: numbers.get(run.cite) ?? null,
            decisionId,
          })})`,
    )
    .join("");
};

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
    parts: [createChatTextPart(renderReaderStoryAnswer(decisionId, blocks))],
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
 * Seeds the story for one user. Idempotent: the user's marks on the decision
 * and the fixed-id thread are replaced on every run, the thread's messages
 * going with it by cascade.
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
    // Every mark this user has on the decision, not only today's ids: a mark
    // dropped from the story must not linger in the shot after a reseed.
    await tx
      .delete(legalReaderAnnotations)
      .where(
        and(
          eq(legalReaderAnnotations.organizationId, organizationId),
          eq(legalReaderAnnotations.userId, userId),
          eq(legalReaderAnnotations.targetType, "decision"),
          eq(legalReaderAnnotations.targetId, decisionId),
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
