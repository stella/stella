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
import { MARKETING_LOCALE_MARKERS } from "@stll/playwright-tools/marketing-locales";
import type { MarketingLocale } from "@stll/playwright-tools/marketing-locales";

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

import { SEED_CONTENT_BY_LOCALE } from "./seed-content/locales";
import {
  buildExportReviewCitationSeeds,
  buildExportReviewDocNames,
  buildExportReviewMetadata,
  exportReviewCitationBlockId,
  exportReviewDocumentIds,
  isElevatedRisk,
  type ExportReviewCopy,
  type ExportReviewMetadata,
} from "./seed-export-review";
import { at, seedFileIdentity, seedId } from "./seed-utils";

// The seeded "agent" story: a finished change-of-control review in the
// Export Review ("Project Atlas") matter, filmed for the landing page's agent
// screenshot and video (apps/web/e2e/marketing/agent-thread.ts waits on and
// frames it). Every claim in the answers is derived from the export-review
// rows it cites, and every citation resolves to the exact review-extract line
// that states it, so opening a chip lands on text that supports the sentence.
// Each locale films its own data room; the prose around the derived facts is
// written per locale in its content pack (MarketingAgentCopy).

/** How a change of control affects a counterparty's agreements. */
export const CHANGE_OF_CONTROL_POSITIONS = [
  "consent",
  "confirm",
  "notice",
] as const;
type ChangeOfControlPosition = (typeof CHANGE_OF_CONTROL_POSITIONS)[number];

type ExposureViewLabels = (typeof exposureView)["data"]["labels"];

/** The answers' prose around the facts the data room supplies. */
export type MarketingAgentCopy = {
  /** Locale of the numbers, currency and lists in the answers and the view. */
  formattingLocale: string;
  /** The generated view's labels (its fixture holds the English ones). */
  viewLabels: ExposureViewLabels;
  /** "Customer Contract 2019": an agreement's type and vintage. */
  agreementLabel: (documentType: string, year: string) => string;
  firstAnswerIntro: (facts: {
    documentCount: number;
    consentCount: number;
  }) => string;
  tableColumns: readonly [string, string, string, string];
  firstAnswerOutro: (facts: { confirmNames: string }) => string;
  secondAnswerLead: (facts: {
    counterparty: string;
    criticalCount: number;
    riskFinding: string;
    riskFindingCitation: string;
    keyObligation: string;
    keyObligationCitation: string;
  }) => string;
  citationLabels: {
    riskFinding: string;
    keyObligation: string;
    governingLaw: string;
    expiryDate: string;
    contractValue: string;
  };
  factLabels: { governingLaw: string; expires: string; contractValue: string };
  thirdAnswerLead: (facts: {
    share: string;
    consentValue: string;
    totalValue: string;
    consentCount: number;
    criticalCount: number;
    firstCriticalCitation: string;
    secondCriticalCitation: string;
  }) => string;
  thirdAnswerFollowUp: (facts: {
    confirmNames: string;
    consentCount: number;
  }) => string;
  recap: (facts: { consentNames: string; confirmNames: string }) => string;
};

const exposureHtml = readFileSync(
  new URL(
    "../src/handlers/visual-sandbox/fixtures/showcase/change-of-control-exposure.html",
    import.meta.url,
  ),
  "utf-8",
);

/**
 * The position a review extract supports. High and Critical extracts record
 * that consent, notice or termination rights need partner review; the others
 * report no blocking issue, and those tagged "consent needed" still need the
 * consent position confirmed. Every extract requires written notice.
 */
const changeOfControlPosition = (
  copy: ExportReviewCopy,
  metadata: ExportReviewMetadata,
): ChangeOfControlPosition => {
  if (isElevatedRisk(copy, metadata.riskLevel)) {
    return "consent";
  }
  return metadata.tags.includes(copy.secondaryTags[0]) ? "confirm" : "notice";
};

type CounterpartyExposure = {
  name: string;
  agreement: string;
  documents: number;
  value: number;
  risk: string;
  position: ChangeOfControlPosition;
};

/**
 * One row per counterparty across the whole data room, in first-appearance
 * order. Panics when a counterparty's rows disagree on agreement type, risk
 * or position, because the thread and the view describe each counterparty
 * with one position.
 */
export const aggregateChangeOfControlExposure = (
  copy: ExportReviewCopy,
): CounterpartyExposure[] => {
  const byCounterparty = new Map<string, CounterpartyExposure>();
  const docNames = buildExportReviewDocNames(copy);
  for (let index = 0; index < docNames.length; index++) {
    const metadata = buildExportReviewMetadata(copy, index);
    const position = changeOfControlPosition(copy, metadata);
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
export const riskSeverity = (copy: ExportReviewCopy) =>
  copy.riskLevels.toReversed();

/**
 * The order the answer's table and the generated view list counterparties
 * in: by change-of-control position, then the most severe risk, then the
 * largest contract value, so the Critical rows the prose cites lead.
 */
export const rankChangeOfControlExposure = (
  copy: ExportReviewCopy,
  rows: readonly CounterpartyExposure[],
): CounterpartyExposure[] => {
  const severity = riskSeverity(copy);
  return rows.toSorted(
    (a, b) =>
      CHANGE_OF_CONTROL_POSITIONS.indexOf(a.position) -
        CHANGE_OF_CONTROL_POSITIONS.indexOf(b.position) ||
      severity.indexOf(a.risk) - severity.indexOf(b.risk) ||
      b.value - a.value,
  );
};

type CitedDocument = {
  fileName: string;
  metadata: ExportReviewMetadata;
  ids: ReturnType<typeof exportReviewDocumentIds>;
};

/** The counterparty's first DOCX row: DOCX citations highlight the passage. */
const citedDocumentFor = (
  copy: ExportReviewCopy,
  counterparty: string,
): CitedDocument => {
  const docNames = buildExportReviewDocNames(copy);
  for (let index = 0; index < docNames.length; index++) {
    const fileName = at(docNames, index);
    const metadata = buildExportReviewMetadata(copy, index);
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
  copy: ExportReviewCopy,
  document: CitedDocument,
  field: CitationField,
  workspaceId: SafeId<"workspace">,
): ChatSourceCitationTarget => {
  const citationSeed =
    buildExportReviewCitationSeeds(copy, document.metadata).find(
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

/** "Delta_Logistics_Customer_Contract_2019.docx" -> "Customer Contract 2019". */
const agreementLabel = (copy: MarketingAgentCopy, document: CitedDocument) => {
  const year = /_(?<year>\d{4})\.docx$/u.exec(document.fileName)?.groups?.[
    "year"
  ];
  return year === undefined
    ? panic(`Export review file ${document.fileName} has no vintage year`)
    : copy.agreementLabel(document.metadata.documentType, year);
};

/** "Delta Logistics Kft." -> "Delta Logistics"; "Delta Logistika, s.r.o." -> "Delta Logistika". */
const shortName = (counterparty: string) =>
  counterparty.split(" ").slice(0, 2).join(" ").replace(/,$/u, "");

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

const formatters = (formattingLocale: string) => {
  const conjunction = new Intl.ListFormat(formattingLocale, {
    type: "conjunction",
  });
  return {
    money: new Intl.NumberFormat(formattingLocale, {
      style: "currency",
      currency: exposureView.data.currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }),
    exactMoney: new Intl.NumberFormat(formattingLocale, {
      style: "currency",
      currency: exposureView.data.currency,
      maximumFractionDigits: 0,
    }),
    /** "Delta Logistics, Granite Properties and Helios Energy". */
    names: (rows: readonly { name: string }[]) =>
      conjunction.format(rows.map(({ name }) => shortName(name))),
    percent: new Intl.NumberFormat(formattingLocale, {
      style: "percent",
      maximumFractionDigits: 0,
    }),
  };
};

const MESSAGE_OFFSETS_MS = [0, 40_000, 180_000, 222_000, 360_000, 415_000];

// The data room's two Critical agreements, which the answers name: a
// customer contract and a loan agreement (ExportReviewCopy.counterparties).
const FIRST_CRITICAL_COUNTERPARTY = 3;
const SECOND_CRITICAL_COUNTERPARTY = 7;

/**
 * The final turn's `show_visual` call as a real one leaves it: the model's
 * input, the page the store keeps (prepared, as the store writes it), the
 * resource part that points at it, and the tool's result.
 */
const buildExposureVisual = ({
  fileId,
  locale,
  toolCallId,
}: {
  fileId: SafeId<"userFile">;
  locale: MarketingLocale;
  toolCallId: string;
}) => {
  const { agent, exportReview } = SEED_CONTENT_BY_LOCALE[locale];
  // The page is the fixture; its labels are the locale's and the data room
  // is the seed's.
  const visualInput = v.parse(generatedVisualInputSchema, {
    ...exposureView,
    title: MARKETING_LOCALE_MARKERS[locale].agent.viewTitle,
    data: {
      ...exposureView.data,
      formattingLocale: agent.formattingLocale,
      labels: agent.viewLabels,
      positions: CHANGE_OF_CONTROL_POSITIONS,
      risks: riskSeverity(exportReview),
      counterparties: aggregateChangeOfControlExposure(exportReview),
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
  locale: MarketingLocale;
  organizationId: SafeId<"organization">;
  userId: string;
  workspaceId: SafeId<"workspace">;
};

type WriteAnswersInput = {
  locale: MarketingLocale;
  workspaceId: SafeId<"workspace">;
};

/**
 * The three answers' prose and their cited documents, in the locale's words
 * around the facts its data room supplies.
 */
const writeAnswers = ({ locale, workspaceId }: WriteAnswersInput) => {
  const { agent: copy, exportReview } = SEED_CONTENT_BY_LOCALE[locale];
  const { exactMoney, money, names, percent } = formatters(
    copy.formattingLocale,
  );
  const cite = (label: string, document: CitedDocument, field: CitationField) =>
    `[${label}](${toChatSourceCitationHref(
      citationTarget(exportReview, document, field, workspaceId),
    )})`;
  const exposure = aggregateChangeOfControlExposure(exportReview);
  const ranked = rankChangeOfControlExposure(exportReview, exposure);
  const rowFor = (position: ChangeOfControlPosition) =>
    ranked.filter((row) => row.position === position);
  const documentFor = new Map(
    exposure.map((row) => [row.name, citedDocumentFor(exportReview, row.name)]),
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
      return `| ${row.name} | ${cite(agreementLabel(copy, document), document, positionField[position])} | ${row.risk} | ${copy.viewLabels.positions[position]} |`;
    }),
  );
  const consentRows = rowFor("consent");
  const confirmRows = rowFor("confirm");
  const [firstColumn, secondColumn, thirdColumn, fourthColumn] =
    copy.tableColumns;
  const firstAnswer = [
    copy.firstAnswerIntro({
      documentCount: buildExportReviewDocNames(exportReview).length,
      consentCount: consentRows.length,
    }),
    "",
    `| ${firstColumn} | ${secondColumn} | ${thirdColumn} | ${fourthColumn} |`,
    "| --- | --- | --- | --- |",
    ...tableRows,
    "",
    copy.firstAnswerOutro({ confirmNames: names(confirmRows) }),
  ].join("\n");

  // The prose names the two Critical agreements; fail the seed rather than
  // film a sentence the data contradicts.
  const criticalRisk = exportReview.riskLevels[3];
  const critical = consentRows.filter(({ risk }) => risk === criticalRisk);
  const delta = cited(
    at(exportReview.counterparties, FIRST_CRITICAL_COUNTERPARTY),
  );
  const helios = cited(
    at(exportReview.counterparties, SECOND_CRITICAL_COUNTERPARTY),
  );
  if (
    critical.map(({ name }) => name).join(",") !==
    [delta, helios].map(({ metadata }) => metadata.counterparty).join(",")
  ) {
    panic("The named Critical pair no longer matches the data room");
  }
  const { citationLabels, factLabels } = copy;
  const secondAnswer = [
    copy.secondAnswerLead({
      counterparty: shortName(helios.metadata.counterparty),
      criticalCount: critical.length,
      riskFinding: helios.metadata.riskFinding,
      riskFindingCitation: cite(
        citationLabels.riskFinding,
        helios,
        "risk-finding",
      ),
      keyObligation: helios.metadata.keyObligation,
      keyObligationCitation: cite(
        citationLabels.keyObligation,
        helios,
        "key-obligation",
      ),
    }),
    "",
    `- **${factLabels.governingLaw}:** ${helios.metadata.governingLaw} ${cite(citationLabels.governingLaw, helios, "governing-law")}`,
    `- **${factLabels.expires}:** ${helios.metadata.expiryDate} ${cite(citationLabels.expiryDate, helios, "expiry-date")}`,
    `- **${factLabels.contractValue}:** ${exactMoney.format(helios.metadata.contractValue)} ${cite(citationLabels.contractValue, helios, "contract-value")}`,
  ].join("\n");

  const totalValue = exposure.reduce((sum, row) => sum + row.value, 0);
  const consentValue = consentRows.reduce((sum, row) => sum + row.value, 0);
  const thirdLead = copy.thirdAnswerLead({
    share: percent.format(consentValue / totalValue),
    consentValue: money.format(consentValue),
    totalValue: money.format(totalValue),
    consentCount: consentRows.length,
    criticalCount: critical.length,
    firstCriticalCitation: cite(
      `${shortName(delta.metadata.counterparty)} · ${agreementLabel(copy, delta)}`,
      delta,
      "risk-finding",
    ),
    secondCriticalCitation: cite(
      `${shortName(helios.metadata.counterparty)} · ${agreementLabel(copy, helios)}`,
      helios,
      "risk-finding",
    ),
  });
  const thirdFollowUp = copy.thirdAnswerFollowUp({
    confirmNames: names(confirmRows),
    consentCount: consentRows.length,
  });

  return {
    citedDocuments: exposure.map(({ name }) => cited(name)),
    delta,
    firstAnswer,
    helios,
    recapText: copy.recap({
      consentNames: names(consentRows),
      confirmNames: names(confirmRows),
    }),
    secondAnswer,
    thirdFollowUp,
    thirdLead,
  };
};

export const buildMarketingAgentThread = ({
  createdAt,
  locale,
  organizationId,
  userId,
  workspaceId,
}: BuildMarketingAgentThreadInput) => {
  const markers = MARKETING_LOCALE_MARKERS[locale].agent;
  const threadId = seedId<"chatThread">("marketing-agent-thread");
  const visualFileId = seedId<"userFile">("marketing-agent-visual");
  const visualToolCallId = "call-marketing-agent-visual";
  const {
    citedDocuments,
    delta,
    firstAnswer,
    helios,
    recapText,
    secondAnswer,
    thirdFollowUp,
    thirdLead,
  } = writeAnswers({ locale, workspaceId });

  const { visualBytes, visualInput, visualOutput, visualPart } =
    buildExposureVisual({
      fileId: visualFileId,
      locale,
      toolCallId: visualToolCallId,
    });

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
      parts: [{ type: "text", content: markers.questions[0] }],
    },
    {
      role: "assistant",
      parts: [{ type: "text", content: firstAnswer }],
      metadata: completed(citedDocuments),
    },
    {
      role: "user",
      parts: [{ type: "text", content: markers.questions[1] }],
    },
    {
      role: "assistant",
      parts: [{ type: "text", content: secondAnswer }],
      metadata: completed([helios]),
    },
    {
      role: "user",
      parts: [{ type: "text", content: markers.questions[2] }],
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
      title: markers.threadTitle,
      createdAt,
      updatedAt: lastMessage.createdAt,
      // Pinned so reopening the thread shows this recap without a model call:
      // the API serves a cached recap while it names the last message and the
      // current prompt version.
      recapText,
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
