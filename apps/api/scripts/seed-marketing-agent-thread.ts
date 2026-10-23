import { panic } from "better-result";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import {
  type ChatSourceCitationTarget,
  toChatSourceCitationHref,
} from "@stll/api-contract";
import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";
import { generatedVisualInputSchema } from "@stll/api-contract/generated-visual";
import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";

import { TEXT_PLAIN_MIME_TYPE } from "@/api/handlers/chat/attachment-validation";
import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { RECAP_PROMPT_VERSION } from "@/api/handlers/chat/thread-recap";
import type {
  ChatMessage,
  ChatMessageMetadata,
  ChatSourceDocument,
} from "@/api/handlers/chat/types";
import exposureView from "@/api/handlers/visual-sandbox/fixtures/showcase/change-of-control-exposure.json";
import { prepareGeneratedVisual } from "@/api/handlers/visual-sandbox/prepare";
import { createVisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import type { SafeId } from "@/api/lib/branded-types";
import { createUserFileKey } from "@/api/lib/file-key";
import {
  VisualPreviewError,
  visualPreviewFailureModelContent,
} from "@/api/lib/visual-preview";

import {
  buildExportReviewCitationSeeds,
  buildExportReviewMetadata,
  EXPORT_REVIEW_DOC_NAMES,
  EXPORT_REVIEW_RISK_LEVELS,
  exportReviewCitationBlockId,
  exportReviewDocumentIds,
  type ExportReviewMetadata,
} from "./seed-export-review";
import { at, seedFileIdentity, seedId } from "./seed-utils";

// The seeded "agent" story: a finished change-of-control review in the
// Export Review ("Project Atlas") matter, filmed for the landing page's agent
// screenshot and video (apps/web/e2e/marketing/agent-thread.ts waits on and
// frames it). Every claim in the answers is derived from the export-review
// rows it cites, and every citation resolves to the exact review-extract line
// that states it, so opening a chip lands on text that supports the sentence.

export const MARKETING_AGENT_THREAD_TITLE =
  "Project Atlas · Change-of-control review";

/** How a change of control affects a counterparty's agreements. */
export const CHANGE_OF_CONTROL_POSITIONS = [
  "consent",
  "confirm",
  "notice",
] as const;
type ChangeOfControlPosition = (typeof CHANGE_OF_CONTROL_POSITIONS)[number];

const exposureHtml = readFileSync(
  new URL(
    "../src/handlers/visual-sandbox/fixtures/showcase/change-of-control-exposure.html",
    import.meta.url,
  ),
  "utf-8",
);

const POSITION_LABELS = exposureView.data.labels.positions satisfies Record<
  ChangeOfControlPosition,
  string
>;

/**
 * The position a review extract supports. High and Critical extracts record
 * that consent, notice or termination rights need partner review; the others
 * report no blocking issue, and those tagged "consent needed" still need the
 * consent position confirmed. Every extract requires written notice.
 */
const changeOfControlPosition = (
  metadata: ExportReviewMetadata,
): ChangeOfControlPosition => {
  if (metadata.riskLevel === "High" || metadata.riskLevel === "Critical") {
    return "consent";
  }
  return metadata.tags.includes("consent needed") ? "confirm" : "notice";
};

type CounterpartyExposure = {
  name: string;
  agreement: string;
  documents: number;
  value: number;
  risk: ExportReviewMetadata["riskLevel"];
  position: ChangeOfControlPosition;
};

/**
 * One row per counterparty across the whole data room, in first-appearance
 * order. Panics when a counterparty's rows disagree on agreement type, risk
 * or position, because the thread and the view describe each counterparty
 * with one position.
 */
export const aggregateChangeOfControlExposure = (): CounterpartyExposure[] => {
  const byCounterparty = new Map<string, CounterpartyExposure>();
  for (let index = 0; index < EXPORT_REVIEW_DOC_NAMES.length; index++) {
    const metadata = buildExportReviewMetadata(index);
    const position = changeOfControlPosition(metadata);
    const existing = byCounterparty.get(metadata.counterparty);
    if (existing === undefined) {
      byCounterparty.set(metadata.counterparty, {
        name: metadata.counterparty,
        agreement: metadata.documentType,
        documents: 1,
        value: metadata.contractValue,
        risk: metadata.riskLevel,
        position,
      });
      continue;
    }
    if (
      existing.agreement !== metadata.documentType ||
      existing.risk !== metadata.riskLevel ||
      existing.position !== position
    ) {
      return panic(
        `Export review rows for ${metadata.counterparty} disagree on their change-of-control position`,
      );
    }
    existing.documents += 1;
    existing.value += metadata.contractValue;
  }
  return [...byCounterparty.values()];
};

/** Risk levels, most severe first. */
export const RISK_SEVERITY = EXPORT_REVIEW_RISK_LEVELS.toReversed();

/**
 * The order the answer's table and the generated view list counterparties
 * in: by change-of-control position, then the most severe risk, then the
 * largest contract value, so the Critical rows the prose cites lead.
 */
export const rankChangeOfControlExposure = (
  rows: readonly CounterpartyExposure[],
): CounterpartyExposure[] =>
  rows.toSorted(
    (a, b) =>
      CHANGE_OF_CONTROL_POSITIONS.indexOf(a.position) -
        CHANGE_OF_CONTROL_POSITIONS.indexOf(b.position) ||
      RISK_SEVERITY.indexOf(a.risk) - RISK_SEVERITY.indexOf(b.risk) ||
      b.value - a.value,
  );

type CitedDocument = {
  fileName: string;
  metadata: ExportReviewMetadata;
  ids: ReturnType<typeof exportReviewDocumentIds>;
};

/** The counterparty's first DOCX row: DOCX citations highlight the passage. */
const citedDocumentFor = (counterparty: string): CitedDocument => {
  for (let index = 0; index < EXPORT_REVIEW_DOC_NAMES.length; index++) {
    const fileName = at(EXPORT_REVIEW_DOC_NAMES, index);
    const metadata = buildExportReviewMetadata(index);
    if (fileName.endsWith(".docx") && metadata.counterparty === counterparty) {
      return {
        fileName,
        metadata,
        ids: exportReviewDocumentIds(index),
      };
    }
  }
  return panic(`No DOCX export review row cites ${counterparty}`);
};

type CitationField =
  | "contract-value"
  | "expiry-date"
  | "governing-law"
  | "key-obligation"
  | "risk-finding"
  | "tags";

const citationTarget = (
  document: CitedDocument,
  field: CitationField,
  workspaceId: SafeId<"workspace">,
): ChatSourceCitationTarget => {
  const citationSeed =
    buildExportReviewCitationSeeds(document.metadata).find(
      ({ fieldSuffix }) => fieldSuffix === field,
    ) ?? panic(`Export review rows have no ${field} citation`);
  return {
    type: "docx-folio",
    workspaceId,
    entityId: document.ids.entityId,
    entityVersionId: document.ids.entityVersionId,
    fieldId: document.ids.fileFieldId,
    blockId: exportReviewCitationBlockId(citationSeed),
    text: citationSeed.quote,
  };
};

const cite = (
  label: string,
  document: CitedDocument,
  field: CitationField,
  workspaceId: SafeId<"workspace">,
) =>
  `[${label}](${toChatSourceCitationHref(
    citationTarget(document, field, workspaceId),
  )})`;

/** "Delta_Logistics_Customer_Contract_2019.docx" -> "Customer Contract 2019". */
const agreementLabel = (document: CitedDocument) => {
  const year = /_(?<year>\d{4})\.docx$/u.exec(document.fileName)?.groups?.[
    "year"
  ];
  return year === undefined
    ? panic(`Export review file ${document.fileName} has no vintage year`)
    : `${document.metadata.documentType} ${year}`;
};

/** Small counts read as words in prose ("four counterparties"). */
const countWord = (count: number) =>
  [
    "no",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
  ].at(count) ?? String(count);

/** "Delta Logistics Kft." -> "Delta Logistics". */
const shortName = (counterparty: string) =>
  counterparty.split(" ").slice(0, 2).join(" ");

const sourceDocument = (
  document: CitedDocument,
  workspaceId: SafeId<"workspace">,
): ChatSourceDocument => ({
  entityId: document.ids.entityId,
  kind: "document",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  title: document.fileName,
  workspaceId,
});

const money = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: exposureView.data.currency,
  notation: "compact",
  maximumFractionDigits: 1,
});
const exactMoney = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: exposureView.data.currency,
  maximumFractionDigits: 0,
});
const conjunction = new Intl.ListFormat("en-GB", { type: "conjunction" });
/** "Delta Logistics, Granite Properties and Helios Energy". */
const names = (rows: readonly { name: string }[]) =>
  conjunction.format(rows.map(({ name }) => shortName(name)));
const percent = new Intl.NumberFormat("en-GB", {
  style: "percent",
  maximumFractionDigits: 0,
});

const MESSAGE_OFFSETS_MS = [0, 40_000, 180_000, 222_000, 360_000, 415_000];

export const MARKETING_AGENT_QUESTIONS = [
  "Which agreements in the Project Atlas data room carry change-of-control risk?",
  "What does the Helios loan agreement say, and when does it expire?",
  "Turn this into a view I can take to the partner meeting.",
] as const;

/**
 * The final turn's `show_visual` call as a real one leaves it: the model's
 * input, the page the store keeps (prepared, as the store writes it), the
 * resource part that points at it, and the tool's result.
 */
const buildExposureVisual = ({
  fileId,
  toolCallId,
}: {
  fileId: SafeId<"userFile">;
  toolCallId: string;
}) => {
  // The page and its labels are the fixture; the data room is the seed's.
  const visualInput = v.parse(generatedVisualInputSchema, {
    ...exposureView,
    data: {
      ...exposureView.data,
      positions: CHANGE_OF_CONTROL_POSITIONS,
      risks: RISK_SEVERITY,
      counterparties: aggregateChangeOfControlExposure(),
    },
    html: exposureHtml,
  });
  const prepared = prepareGeneratedVisual(visualInput).unwrap(
    "The seeded exposure view must pass the generated-view sanitizer",
  );
  const { title, html, data, links } = prepared;
  return {
    visualInput,
    visualBytes: new TextEncoder().encode(
      JSON.stringify({ title, html, data, links }),
    ),
    visualPart: createVisualResourceOrigin().issue({
      fileId,
      title,
      toolCallId,
    }),
    // A local stack has no preview renderer, so a real turn records exactly
    // this text-only result; the view itself is served from the stored page.
    visualOutput: visualPreviewFailureModelContent({
      title,
      error: new VisualPreviewError({
        code: "not-configured",
        message:
          "Visual preview is unavailable; the visual can still be published",
      }),
    }),
  };
};

type BuildMarketingAgentThreadInput = {
  createdAt: Date;
  organizationId: SafeId<"organization">;
  userId: string;
  workspaceId: SafeId<"workspace">;
};

export const buildMarketingAgentThread = ({
  createdAt,
  organizationId,
  userId,
  workspaceId,
}: BuildMarketingAgentThreadInput) => {
  const threadId = seedId<"chatThread">("marketing-agent-thread");
  const visualFileId = seedId<"userFile">("marketing-agent-visual");
  const visualToolCallId = "call-marketing-agent-visual";
  const exposure = aggregateChangeOfControlExposure();
  const ranked = rankChangeOfControlExposure(exposure);
  const rowFor = (position: ChangeOfControlPosition) =>
    ranked.filter((row) => row.position === position);
  const documentFor = new Map(
    exposure.map((row) => [row.name, citedDocumentFor(row.name)]),
  );
  const cited = (counterparty: string) =>
    documentFor.get(counterparty) ??
    panic(`No cited document for ${counterparty}`);
  const positionField = {
    consent: "risk-finding",
    confirm: "tags",
    notice: "key-obligation",
  } as const satisfies Record<ChangeOfControlPosition, CitationField>;

  const tableRows = CHANGE_OF_CONTROL_POSITIONS.flatMap((position) =>
    rowFor(position).map((row) => {
      const document = cited(row.name);
      return `| ${row.name} | ${cite(agreementLabel(document), document, positionField[position], workspaceId)} | ${row.risk} | ${POSITION_LABELS[position]} |`;
    }),
  );
  const consentRows = rowFor("consent");
  const confirmRows = rowFor("confirm");
  const firstAnswer = [
    `I checked all ${String(EXPORT_REVIEW_DOC_NAMES.length)} documents in the data room. Every agreement requires written notice before an assignment, renewal or material service change, so a change of control triggers at least a notice everywhere. Only ${countWord(consentRows.length)} counterparties go further: their review extracts flag consent or termination rights that need partner review before signing.`,
    "",
    "| Counterparty | Agreement | Risk | Change-of-control position |",
    "| --- | --- | --- | --- |",
    ...tableRows,
    "",
    `The ${names(confirmRows)} agreements report no blocking issue, but each is tagged "consent needed", so confirm the consent position before signing.`,
  ].join("\n");

  // The prose names the two Critical agreements, Delta Logistics and Helios
  // Energy; fail the seed rather than film a sentence the data contradicts.
  const critical = consentRows.filter(({ risk }) => risk === "Critical");
  const helios = cited("Helios Energy a.s.");
  const delta = cited("Delta Logistics Kft.");
  if (
    critical.map(({ name }) => name).join(",") !==
    [delta, helios].map(({ metadata }) => metadata.counterparty).join(",")
  ) {
    panic("Delta Logistics and Helios Energy are no longer the Critical pair");
  }
  const secondAnswer = [
    `The ${shortName(helios.metadata.counterparty)} loan agreement is one of the ${countWord(critical.length)} Critical items. Its review extract records that "${helios.metadata.riskFinding}" ${cite("Risk finding", helios, "risk-finding", workspaceId)} That sits on top of the standard duty: "${helios.metadata.keyObligation}" ${cite("Key obligation", helios, "key-obligation", workspaceId)}`,
    "",
    `- **Governing law:** ${helios.metadata.governingLaw} ${cite("Governing law", helios, "governing-law", workspaceId)}`,
    `- **Expires:** ${helios.metadata.expiryDate} ${cite("Expiry date", helios, "expiry-date", workspaceId)}`,
    `- **Contract value:** ${exactMoney.format(helios.metadata.contractValue)} ${cite("Contract value", helios, "contract-value", workspaceId)}`,
  ].join("\n");

  const totalValue = exposure.reduce((sum, row) => sum + row.value, 0);
  const consentValue = consentRows.reduce((sum, row) => sum + row.value, 0);
  const thirdLead = `Here is the exposure by counterparty. ${percent.format(consentValue / totalValue)} of the contract value in the data room (${money.format(consentValue)} of ${money.format(totalValue)}) sits with the ${countWord(consentRows.length)} counterparties that need consent or termination review, led by the ${countWord(critical.length)} Critical agreements: ${cite(`${shortName(delta.metadata.counterparty)} · ${agreementLabel(delta)}`, delta, "risk-finding", workspaceId)} and ${cite(`${shortName(helios.metadata.counterparty)} · ${agreementLabel(helios)}`, helios, "risk-finding", workspaceId)}.`;
  const thirdFollowUp = `Next: confirm the consent position with ${names(confirmRows)}, then draft the consent requests for the ${countWord(consentRows.length)} counterparties under review.`;

  const { visualBytes, visualInput, visualOutput, visualPart } =
    buildExposureVisual({ fileId: visualFileId, toolCallId: visualToolCallId });

  const completed = (
    documents: readonly CitedDocument[],
  ): ChatMessageMetadata => ({
    sourceDocuments: documents.map((document) =>
      sourceDocument(document, workspaceId),
    ),
    turnOutcome: { type: "completed" },
  });
  const messages: {
    role: ChatMessage["role"];
    parts: ChatMessage["parts"];
    metadata?: ChatMessageMetadata;
  }[] = [
    {
      role: "user",
      parts: [{ type: "text", content: MARKETING_AGENT_QUESTIONS[0] }],
    },
    {
      role: "assistant",
      parts: [{ type: "text", content: firstAnswer }],
      metadata: completed(exposure.map(({ name }) => cited(name))),
    },
    {
      role: "user",
      parts: [{ type: "text", content: MARKETING_AGENT_QUESTIONS[1] }],
    },
    {
      role: "assistant",
      parts: [{ type: "text", content: secondAnswer }],
      metadata: completed([helios]),
    },
    {
      role: "user",
      parts: [{ type: "text", content: MARKETING_AGENT_QUESTIONS[2] }],
    },
    {
      role: "assistant",
      parts: [
        { type: "text", content: thirdLead },
        {
          type: "tool-call",
          id: visualToolCallId,
          name: VISUAL_PREVIEW_TOOL_NAME,
          arguments: JSON.stringify(visualInput),
          input: visualInput,
          state: "complete",
          output: visualOutput,
          metadata: {
            [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server",
            stellaStepId: visualToolCallId,
          },
        },
        visualPart,
        {
          type: "tool-result",
          toolCallId: visualToolCallId,
          content: visualOutput,
          state: "complete",
        },
        { type: "text", content: thirdFollowUp },
      ],
      metadata: completed([delta, helios]),
    },
  ];

  const rows = messages.map((message, index) => {
    const id = seedId<"chatMessage">(`marketing-agent-message-${index + 1}`);
    return {
      id,
      threadId,
      workspaceId,
      userId,
      role: message.role,
      content: chatMessageContentFromMessage(
        toPersistableChatMessage({
          id,
          role: message.role,
          parts: message.parts,
          ...(message.metadata === undefined
            ? {}
            : { metadata: message.metadata }),
        }),
      ),
      createdAt: new Date(createdAt.getTime() + at(MESSAGE_OFFSETS_MS, index)),
    };
  });
  const lastMessage = rows.at(-1) ?? panic("The agent thread has no messages");

  return {
    thread: {
      id: threadId,
      organizationId,
      userId,
      workspaceId,
      title: MARKETING_AGENT_THREAD_TITLE,
      createdAt,
      updatedAt: lastMessage.createdAt,
      // Pinned so reopening the thread shows this recap without a model call:
      // the API serves a cached recap while it names the last message and the
      // current prompt version.
      recapText: `You mapped change-of-control exposure across the Project Atlas data room: ${names(consentRows)} need consent or termination review, and an exposure view summarises it for the partner meeting. Still open: confirm the consent position for ${names(confirmRows)}.`,
      recapMessageId: lastMessage.id,
      recapPromptVersion: RECAP_PROMPT_VERSION,
      recapGeneratedAt: new Date(lastMessage.createdAt.getTime() + 86_400_000),
    },
    messages: rows,
    visualFile: {
      bytes: visualBytes,
      row: {
        id: visualFileId,
        userId,
        fileName: "generated-view.txt",
        mimeType: TEXT_PLAIN_MIME_TYPE,
        ...seedFileIdentity(visualBytes),
        s3Key: createUserFileKey({
          fileId: visualFileId,
          mimeType: TEXT_PLAIN_MIME_TYPE,
          organizationId,
        }),
        threadId,
        createdAt: lastMessage.createdAt,
        updatedAt: lastMessage.createdAt,
      },
      part: visualPart,
    },
  };
};
