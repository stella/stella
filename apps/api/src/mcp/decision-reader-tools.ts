import { panic, Result } from "better-result";
import * as v from "valibot";

import { decisionParagraphFragment } from "@stll/api-contract/decision-paragraph-range";

import type { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import type { readProvisionPreviewHandler } from "@/api/handlers/legislation/provision-preview";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedLegislationDocumentId,
} from "@/api/lib/safe-id-boundaries";

import type { McpRequestContext } from "./context";
import {
  blocksDecisionOutput,
  openDecisionArgs,
  openDecisionOutput,
  previewProvisionArgs,
  provisionPreviewOutput,
  READER_PAGE_MAX_CHARS,
  READER_WITHHELD_TEXT_POLICY,
  readDecisionBlocksArgs,
} from "./decision-reader-contract";
import type { ReaderWithheldTextPolicy } from "./decision-reader-contract";
import {
  decodeReaderCursor,
  packReaderSourcePage,
  readerOutline,
  selectReaderWindow,
} from "./decision-reader.logic";
import type { ReaderSource } from "./decision-reader.logic";
import { defineMcpToolSet } from "./tool-types";
import type { McpToolDefinition, TypedMcpToolHandler } from "./tool-types";
import {
  buildCaseLawDecisionAppUrl,
  internalFailureResult,
  invalidCursorResult,
  notFoundResult,
  structuredErrorResult,
  toolDataResult,
  validationErrorResult,
} from "./tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "./valibot-tool-definition";

const defaultReadSource: typeof readDecisionReaderSource = async (options) =>
  await (
    await import("@/api/handlers/case-law/decisions/reader")
  ).readDecisionReaderSource(options);
const defaultReadPreview: typeof readProvisionPreviewHandler = async (
  options,
) =>
  await (
    await import("@/api/handlers/legislation/provision-preview")
  ).readProvisionPreviewHandler(options);
const withheldReason = {
  code: "source_licence",
  message:
    "The source licence does not permit AI use of the full text. Open the decision in stella.",
} as const;
const metadataOf = ({ decision }: ReaderSource) => ({
  decisionId: decision.id,
  caseNumber: decision.caseNumber.slice(0, 256),
  court: decision.court.slice(0, 256),
  country: decision.country,
  date: decision.decisionDate,
  ecli: decision.ecli,
  appUrl: buildCaseLawDecisionAppUrl({
    decisionId: decision.id,
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    language: decision.language,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  }),
});
const readSource = async (
  context: McpRequestContext,
  options: Parameters<typeof readDecisionReaderSource>[0],
) =>
  await Result.tryPromise(
    async () =>
      await (
        context.testDependencies?.readDecisionReaderSource ?? defaultReadSource
      )(options),
  );
const conflict = () =>
  structuredErrorResult({
    code: "conflict",
    message: "The decision or its anchors changed.",
    hint: "Call read_case_law_decision_blocks without cursor to restart.",
  });
const tooLarge = () =>
  structuredErrorResult({
    code: "result_too_large",
    message: "This reader selection exceeds the page limit.",
    hint: "Open the decision using appUrl in stella, or call open_case_law_decision with a smaller paragraph range.",
  });
const missing = () =>
  notFoundResult(
    "Decision not found",
    "Pass a decisionId returned by search_case_law or lookup_case_law.",
  );

const openTool: TypedMcpToolHandler<
  v.InferInput<typeof openDecisionOutput>
> = async ({ args, context }) => {
  const parsed = v.safeParse(openDecisionArgs, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const read = await readSource(context, {
    decisionId: brandPersistedCaseLawDecisionId(parsed.output.decision_id),
    phase: "blocks",
    withheldTextPolicy: "metadata-only",
  });
  if (Result.isError(read)) {
    return internalFailureResult(read.error);
  }
  if (read.value === null) {
    return missing();
  }
  if (read.value.status === "conflict") {
    return conflict();
  }
  const source = read.value;
  const metadata = metadataOf(source);
  // Model-visible open never carries licence-withheld body text, whichever widget policy is selected.
  if (!source.decision.source.allowsDerivedAi) {
    return toolDataResult({ status: "withheld", metadata, withheldReason });
  }
  if (source.ast === null) {
    return toolDataResult({ status: "unavailable", metadata });
  }
  const selected = selectReaderWindow({
    ast: source.ast,
    paragraphs: parsed.output.paragraphs,
  });
  switch (selected.status) {
    case "not_found":
      return notFoundResult(
        "Court paragraph range not found",
        "Read the decision in stella and use its printed court paragraph numbers.",
      );
    case "too_large":
      return tooLarge();
    case "selected":
      return toolDataResult({
        status: "available",
        metadata: {
          ...metadata,
          appUrl:
            metadata.appUrl === null || parsed.output.paragraphs === undefined
              ? metadata.appUrl
              : `${metadata.appUrl}#${decisionParagraphFragment(parsed.output.paragraphs)}`,
        },
        outline: readerOutline(source.ast.blocks),
        window: selected.window,
        truncated: selected.truncated,
      });
    default:
      selected satisfies never;
      return panic("Unknown reader selection status");
  }
};

export const createReaderBlocksTool =
  (
    withheldTextPolicy: ReaderWithheldTextPolicy,
  ): TypedMcpToolHandler<v.InferInput<typeof blocksDecisionOutput>> =>
  async ({ args, context }) => {
    const parsed = v.safeParse(readDecisionBlocksArgs, args);
    if (!parsed.success) {
      return validationErrorResult(parsed.issues);
    }
    const { decision_id, cursor } = parsed.output;
    const position = cursor === undefined ? null : decodeReaderCursor(cursor);
    if (
      cursor !== undefined &&
      (position === null || position.decisionId !== decision_id)
    ) {
      return invalidCursorResult({
        cursor,
        tool: "read_case_law_decision_blocks",
      });
    }
    const phase = position?.phase ?? "blocks";
    const referenceCursor = position?.referenceCursor ?? undefined;
    const read = await readSource(context, {
      decisionId: brandPersistedCaseLawDecisionId(decision_id),
      phase,
      ...(referenceCursor === undefined ? {} : { referenceCursor }),
      withheldTextPolicy,
    });
    if (Result.isError(read)) {
      return internalFailureResult(read.error);
    }
    if (read.value === null) {
      return missing();
    }
    if (read.value.status === "conflict") {
      return conflict();
    }
    const source = read.value;
    const metadata = metadataOf(source);
    if (
      !source.decision.source.allowsDerivedAi &&
      withheldTextPolicy === "metadata-only"
    ) {
      return toolDataResult({
        metadata,
        content: { status: "withheld", withheldReason },
      });
    }
    if (source.ast === null) {
      return toolDataResult({ metadata, content: { status: "unavailable" } });
    }
    const page = packReaderSourcePage({ ast: source.ast, source, position });
    switch (page.status) {
      case "conflict":
        return conflict();
      case "invalid_offset":
        return invalidCursorResult({
          cursor: cursor ?? "",
          tool: "read_case_law_decision_blocks",
        });
      case "too_large":
        return tooLarge();
      case "packed":
        break;
      default:
        page satisfies never;
        return panic("Unknown reader page status");
    }
    const payload = {
      metadata,
      content: {
        status: "available",
        phase: page.phase,
        items: page.items,
        blockFragments: page.blockFragments,
        citationAnchors: page.citationAnchors,
        provisionAnchors: page.provisionAnchors,
        nextCursor: page.nextCursor,
        limit: READER_PAGE_MAX_CHARS,
      },
    } as const;
    if (JSON.stringify(payload).length > READER_PAGE_MAX_CHARS) {
      return tooLarge();
    }
    return toolDataResult(payload);
  };

const blocksTool = createReaderBlocksTool(READER_WITHHELD_TEXT_POLICY);

const previewTool: TypedMcpToolHandler<
  v.InferInput<typeof provisionPreviewOutput>
> = async ({ args, context }) => {
  const parsed = v.safeParse(previewProvisionArgs, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const provision = parsed.output.provision;
  const preview = await Result.tryPromise(
    async () =>
      await (
        context.testDependencies?.readProvisionPreviewHandler ??
        defaultReadPreview
      )({
        documentId: brandPersistedLegislationDocumentId(provision.document_id),
        anchor: provision.anchor,
        citedAnchor: provision.cited_anchor,
        legislationDb: legislationPublicReadDb,
      }),
  );
  if (Result.isError(preview)) {
    return internalFailureResult(preview.error);
  }
  if (!("blocks" in preview.value)) {
    return notFoundResult(
      "Cited provision not found",
      "Use the provision reference returned by read_case_law_decision_blocks.",
    );
  }
  if (JSON.stringify(preview.value).length > READER_PAGE_MAX_CHARS) {
    return tooLarge();
  }
  return toolDataResult(preview.value);
};

const common = {
  consumesServices: true,
  access: "read",
  readClass: "public",
  anonymized: { exposure: "passthrough" },
  feature: "FEATURE_PUBLIC_LAW",
  scope: "stella:read",
} as const;
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;
const DECISION_READER_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
    ...common,
    name: "open_case_law_decision",
    annotations: { ...readOnlyAnnotations, title: "Open case-law decision" },
    description:
      "Open one decision when the user asks to read or open it. Returns metadata, outline and a small target window. paragraphs names the court's printed numbers (48 or 48-53); appUrl opens the web reader at that range. At most once per answer.",
    inputSchema: openDecisionArgs,
    _meta: { ui: { visibility: ["model", "app"] } },
  }),
  defineValibotMcpTool({
    ...common,
    name: "read_case_law_decision_blocks",
    annotations: {
      ...readOnlyAnnotations,
      title: "Read case-law decision blocks",
    },
    description: `Widget-only decision AST and precomputed anchor streams, at most ${READER_PAGE_MAX_CHARS} JSON characters per page. Concatenate blockFragments.json by blockId/offset and parse when totalChars is reached. Follow nextCursor until null; anchor-only pages complete the decision's links.`,
    inputSchema: readDecisionBlocksArgs,
    _meta: { ui: { visibility: ["app"] } },
  }),
  defineValibotMcpTool({
    ...common,
    name: "preview_cited_provision",
    annotations: { ...readOnlyAnnotations, title: "Preview cited provision" },
    description:
      "Widget-only preview of the exact consolidated provision supplied by a decision anchor.",
    inputSchema: previewProvisionArgs,
    _meta: { ui: { visibility: ["app"] } },
  }),
] as const satisfies readonly McpToolDefinition[];
export const DECISION_READER_TOOL_SET = defineMcpToolSet(
  DECISION_READER_TOOL_DEFINITIONS,
  {
    open_case_law_decision: openTool,
    read_case_law_decision_blocks: blocksTool,
    preview_cited_provision: previewTool,
  },
  {
    open_case_law_decision: defineMcpToolOutput(openDecisionOutput),
    read_case_law_decision_blocks: defineMcpToolOutput(blocksDecisionOutput),
    preview_cited_provision: defineMcpToolOutput(provisionPreviewOutput),
  },
);
