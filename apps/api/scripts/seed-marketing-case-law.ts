import { panic, Result } from "better-result";
import { and, eq, or, sql } from "drizzle-orm";
import path from "node:path";
import * as v from "valibot";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { decisionAnalysisSchema } from "@stll/legal-ast/analysis";
import { persistedDocumentAstSchema } from "@stll/legal-ast/document-ast";
import scenes from "@stll/playwright-tools/marketing-case-law.json" with { type: "json" };

import {
  caseLawDecisions,
  chatMessages,
  chatThreads,
  legalReaderAnnotations,
} from "@/api/db/schema";
import { getSystemPrompt } from "@/api/handlers/case-law/analysis/prompts/prompt-registry";
import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { RECAP_PROMPT_VERSION } from "@/api/handlers/chat/thread-recap";
import type { ChatMessage } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { analysisInputOf } from "@/api/lib/case-law/analysis-prompt";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";
import { readGzipJson } from "@/api/lib/gzip-json";
import { requireLocalDevOpen } from "@/api/runtime-mode";

import { sourceIdFor } from "./seed-case-law";
import { seedId } from "./seed-utils";

const RECORDED_AT = new Date("2026-01-15T09:00:00Z");
const FIXTURE_FILES = ["cz-ns", "cz-us"] as const;
const fixtureSchema = v.object({
  source: v.looseObject({ adapter_key: v.string() }),
  decisions: v.array(
    v.looseObject({
      case_number: v.string(),
      country: v.string(),
      language: v.string(),
      document_ast: v.unknown(),
    }),
  ),
});

// The screenshot seed owns these completed local conversations. Both the
// public analysis and private marks use the same checked-in paragraph anchors.
const seedCorpusAnalyses = async () => {
  const fixtures = await Promise.all(
    FIXTURE_FILES.map(async (name) =>
      v.parse(
        fixtureSchema,
        await readGzipJson(
          path.join(
            import.meta.dir,
            "__fixtures__",
            "case-law",
            `${name}.json.gz`,
          ),
        ),
      ),
    ),
  );
  const recorded = fixtures.flatMap(({ source, decisions }) =>
    decisions.map((decision) => ({
      ...decision,
      sourceId: sourceIdFor(source.adapter_key),
    })),
  );
  // A decision's identity is its source plus case number and language
  // (`case_law_decisions` unique index), so each scene resolves to exactly one
  // recorded fixture and is then looked up under that fixture's source.
  const resolvedScenes = scenes.map((scene) => {
    const matches = recorded.filter(
      (row) =>
        row.case_number === scene.caseNumber &&
        row.country === scene.country &&
        row.language === scene.language,
    );
    const [fixture, ...others] = matches;
    if (!fixture) {
      panic(`Marketing fixture is missing: ${scene.caseNumber}`);
    }
    if (others.length > 0) {
      panic(`Marketing fixture is ambiguous: ${scene.caseNumber}`);
    }
    return { scene, fixture };
  });
  const lane = await enterCaseLawMaintenanceLane();
  try {
    const rows = await withAggregateTransaction(
      lane.rootDb,
      async (tx) =>
        await tx
          .select({
            id: caseLawDecisions.id,
            sourceId: caseLawDecisions.sourceId,
            caseNumber: caseLawDecisions.caseNumber,
            country: caseLawDecisions.country,
            court: caseLawDecisions.court,
            language: caseLawDecisions.language,
            slug: caseLawDecisions.slug,
            decisionType: caseLawDecisions.decisionType,
          })
          .from(caseLawDecisions)
          .where(
            or(
              ...resolvedScenes.map(({ fixture }) =>
                and(
                  eq(caseLawDecisions.sourceId, fixture.sourceId),
                  eq(caseLawDecisions.caseNumber, fixture.case_number),
                  eq(caseLawDecisions.language, fixture.language),
                ),
              ),
            ),
          )
          .limit(scenes.length),
    );
    const stories = resolvedScenes.map(({ scene, fixture }) => {
      const decision =
        rows.find(
          (row) =>
            row.sourceId === fixture.sourceId &&
            row.caseNumber === fixture.case_number &&
            row.language === fixture.language,
        ) ?? panic(`Marketing decision is missing: ${scene.caseNumber}`);
      const ast = v.parse(persistedDocumentAstSchema, fixture.document_ast);
      const highlight =
        ast.blocks.find((block) => block.anchorId === scene.highlightAnchor) ??
        panic(`Marketing highlight anchor is missing: ${scene.caseNumber}`);
      const underline =
        ast.blocks.find((block) => block.anchorId === scene.underlineAnchor) ??
        panic(`Marketing underline anchor is missing: ${scene.caseNumber}`);
      const lastBlock =
        ast.blocks.at(-1) ??
        panic(`Marketing decision has no blocks: ${scene.caseNumber}`);
      const systemPrompt = getSystemPrompt(decision.language);
      if (Result.isError(systemPrompt)) {
        panic(
          `Marketing analysis language is unsupported: ${decision.language}`,
        );
      }
      const input = analysisInputOf({
        blocks: ast.blocks,
        decision,
        systemPrompt: systemPrompt.value,
      });
      const analysis = v.parse(decisionAnalysisSchema, {
        version: 4,
        generatedAt: RECORDED_AT.toISOString(),
        model: "deterministic-dev-fixture",
        inputFingerprint: input.fingerprint,
        tree: [
          {
            id: `marketing-issue-${decision.id}`,
            label: "Legal issue",
            category: "reasoning",
            startAnchorId: highlight.anchorId,
            endAnchorId: highlight.anchorId,
            annotations: [
              {
                id: `marketing-note-${decision.id}`,
                summary: scene.aiNote,
                startAnchorId: highlight.anchorId,
                endAnchorId: highlight.anchorId,
                textSnippet: highlight.plainText.slice(0, 240),
              },
            ],
            children: [],
          },
          {
            // The reader draws its outline only for two or more headings, so
            // the shot needs the decision's closing section as a second one.
            id: `marketing-outcome-${decision.id}`,
            label: "Outcome",
            category: "outcome",
            startAnchorId: lastBlock.anchorId,
            endAnchorId: lastBlock.anchorId,
            annotations: [],
            children: [],
          },
        ],
        holding: {
          spans: [
            {
              text: scene.answer,
              anchors: [
                {
                  startAnchorId: highlight.anchorId,
                  endAnchorId: highlight.anchorId,
                },
              ],
            },
          ],
          language: "en",
        },
        abstract: {
          spans: [
            {
              text: scene.answer,
              anchors: [
                {
                  startAnchorId: highlight.anchorId,
                  endAnchorId: highlight.anchorId,
                },
              ],
            },
            { text: ` ${scene.followUpAnswer}`, anchors: [] },
          ],
          language: "en",
        },
        topics: [],
      });
      return { scene, decision, ast, highlight, underline, analysis };
    });
    await lane.ingestionDb(async (tx) => {
      for (const { decision, ast, analysis } of stories) {
        await tx
          .update(caseLawDecisions)
          .set({ documentAst: ast, analysis })
          .where(eq(caseLawDecisions.id, decision.id));
      }
    });
    return stories;
  } finally {
    await lane.release();
  }
};

type SeedMarketingCaseLawOptions = {
  db: MaintenanceDb;
  organizationId: SafeId<"organization">;
  userId: string;
};

export const seedMarketingCaseLaw = async ({
  db,
  organizationId,
  userId,
}: SeedMarketingCaseLawOptions) => {
  requireLocalDevOpen("Seeding marketing case-law stories");
  const stories = await seedCorpusAnalyses();
  await withAggregateTransaction(db, async (tx) => {
    for (const { scene, decision, highlight, underline } of stories) {
      const key = `marketing-case-law-${organizationId}-${userId}-${decision.id}`;
      const threadId = seedId<"chatThread">(`${key}-thread`);
      const readerPath = createCaseLawDecisionPath(
        createCaseLawDecisionRouteParams({
          caseNumber: decision.caseNumber,
          decisionId: decision.id,
          country: decision.country,
          court: decision.court,
          language: decision.language,
          languageAlternates: null,
          slug: decision.slug,
        }),
      );
      const cite = (anchor: string) =>
        `[${decision.caseNumber}](${readerPath}#${anchor})`;
      const turns = [
        { role: "user", text: scene.question },
        {
          role: "assistant",
          text: `${scene.answer} ${cite(highlight.anchorId)}`,
        },
        { role: "user", text: scene.followUp },
        {
          role: "assistant",
          text: `${scene.followUpAnswer} ${cite(underline.anchorId)}`,
        },
      ] as const satisfies readonly {
        role: ChatMessage["role"];
        text: string;
      }[];
      const messages = turns.map(({ role, text }, index) => {
        const id = seedId<"chatMessage">(`${key}-message-${index}`);
        return {
          id,
          threadId,
          userId,
          workspaceId: null,
          role,
          content: chatMessageContentFromMessage(
            toPersistableChatMessage({
              id,
              role,
              parts: [{ type: "text", content: text }],
              ...(role === "assistant"
                ? { metadata: { turnOutcome: { type: "completed" } } }
                : {}),
            }),
          ),
          createdAt: new Date(RECORDED_AT.getTime() + index * 60_000),
        };
      });
      const last = messages.at(-1) ?? panic("Marketing case-law chat is empty");
      const thread = {
        id: threadId,
        organizationId,
        userId,
        workspaceId: null,
        subjectDecisionId: decision.id,
        title: `Case review · ${decision.caseNumber}`,
        titleSource: "user",
        createdAt: RECORDED_AT,
        updatedAt: last.createdAt,
        recapText: scene.aiNote,
        recapMessageId: last.id,
        recapPromptVersion: RECAP_PROMPT_VERSION,
        recapGeneratedAt: RECORDED_AT,
      } as const;
      await tx
        .insert(chatThreads)
        .values(thread)
        .onConflictDoUpdate({
          target: chatThreads.id,
          set: thread,
          setWhere: sql`${chatThreads.organizationId} = ${organizationId} AND ${chatThreads.userId} = ${userId}`,
        });
      await tx
        .insert(chatMessages)
        .values(messages)
        .onConflictDoUpdate({
          target: chatMessages.id,
          set: {
            content: sql`excluded.content`,
            role: sql`excluded.role`,
            createdAt: sql`excluded.created_at`,
          },
          setWhere: sql`${chatMessages.threadId} = ${threadId} AND ${chatMessages.userId} = ${userId}`,
        });
      const marks = [
        {
          kind: "highlight",
          color: "yellow",
          style: "highlight",
          body: null,
          block: highlight,
        },
        {
          kind: "highlight",
          color: "sky",
          style: "underline",
          body: null,
          block: underline,
        },
        {
          kind: "comment",
          color: null,
          style: null,
          body: scene.comment,
          block: underline,
        },
      ] as const;
      const annotations = marks.map((mark, index) => {
        const startOffset =
          mark.kind === "comment"
            ? Math.max(0, mark.block.plainText.length - 100)
            : 0;
        const quote = mark.block.plainText.slice(
          startOffset,
          startOffset + (mark.kind === "comment" ? 100 : 180),
        );
        return {
          id: seedId<"legalReaderAnnotation">(`${key}-mark-${index}`),
          organizationId,
          userId,
          targetType: "decision",
          targetId: decision.id,
          kind: mark.kind,
          visibility: "shared",
          color: mark.color,
          style: mark.style,
          blockAnchorId: mark.block.anchorId,
          startOffset,
          endOffset: startOffset + quote.length,
          quote,
          body: mark.body,
          createdAt: RECORDED_AT,
          updatedAt: RECORDED_AT,
        } as const;
      });
      await tx
        .insert(legalReaderAnnotations)
        .values(annotations)
        .onConflictDoUpdate({
          target: legalReaderAnnotations.id,
          set: {
            kind: sql`excluded.kind`,
            color: sql`excluded.color`,
            style: sql`excluded.style`,
            body: sql`excluded.body`,
            blockAnchorId: sql`excluded.block_anchor_id`,
            startOffset: sql`excluded.start_offset`,
            endOffset: sql`excluded.end_offset`,
            quote: sql`excluded.quote`,
            updatedAt: sql`excluded.updated_at`,
            visibility: sql`excluded.visibility`,
          },
          setWhere: sql`${legalReaderAnnotations.organizationId} = ${organizationId} AND ${legalReaderAnnotations.userId} = ${userId}`,
        });
    }
  });
};
