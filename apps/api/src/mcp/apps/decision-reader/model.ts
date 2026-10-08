import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Result } from "better-result";
import * as v from "valibot";

import type { DecisionParagraphRange } from "@stll/api-contract/decision-paragraph-range";
import { blockSchema } from "@stll/legal-ast/document-ast";
import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";
import { resolveDecisionParagraphRange } from "@stll/legal-ast/paragraph-range";

import {
  APP_OPEN_DECISION_SCHEMA,
  APP_DECISION_BLOCKS_SCHEMA,
  APP_PROVISION_PREVIEW_SCHEMA,
} from "../shared/contracts";

export type OpenDecision = v.InferOutput<typeof APP_OPEN_DECISION_SCHEMA>;
export type ReaderPage = v.InferOutput<typeof APP_DECISION_BLOCKS_SCHEMA>;
export type ProvisionPreview = v.InferOutput<
  typeof APP_PROVISION_PREVIEW_SCHEMA
>;
type AvailablePage = Extract<ReaderPage["content"], { status: "available" }>;

export const parseOpenDecision = (payload: unknown) => {
  const parsed = v.safeParse(APP_OPEN_DECISION_SCHEMA, payload);
  return parsed.success ? parsed.output : undefined;
};
export const parseReaderPage = (payload: unknown) => {
  const parsed = v.safeParse(APP_DECISION_BLOCKS_SCHEMA, payload);
  return parsed.success ? parsed.output : undefined;
};
export const parseProvisionPreview = (payload: unknown) => {
  const parsed = v.safeParse(APP_PROVISION_PREVIEW_SCHEMA, payload);
  return parsed.success ? parsed.output : undefined;
};

const READER_CURSOR_CONFLICT_CODE = "conflict";
const cursorConflictSchema = v.object({
  error: v.object({ code: v.literal(READER_CURSOR_CONFLICT_CODE) }),
});

export const isReaderCursorConflict = (
  result: Pick<CallToolResult, "isError" | "content"> | undefined,
) => {
  if (result?.isError !== true) {
    return false;
  }
  return result.content.some((content) => {
    if (content.type !== "text") {
      return false;
    }
    const parsed = Result.try((): unknown => JSON.parse(content.text));
    return (
      Result.isOk(parsed) &&
      v.safeParse(cursorConflictSchema, parsed.value).success
    );
  });
};

type PendingFragment = { blockId: string; totalChars: number; json: string };
type ReaderPagerData = {
  metadata: ReaderPage["metadata"];
  blocks: Block[];
  citationAnchors: AvailablePage["citationAnchors"];
  provisionAnchors: AvailablePage["provisionAnchors"];
  nextCursor: string | null;
  complete: boolean;
  phase: AvailablePage["phase"];
  pendingFragment: PendingFragment | null;
  seenCursors: readonly string[];
};
export type ReaderPager = ReaderPagerData &
  (
    | { status: "available" }
    | {
        status: "withheld";
        withheldReason: Extract<
          ReaderPage["content"],
          { status: "withheld" }
        >["withheldReason"];
      }
    | { status: "unavailable" }
  );
export const createReaderPager = (
  metadata: ReaderPage["metadata"],
): ReaderPager => ({
  metadata,
  status: "available",
  blocks: [],
  citationAnchors: [],
  provisionAnchors: [],
  nextCursor: null,
  complete: false,
  phase: "blocks",
  pendingFragment: null,
  seenCursors: [],
});

const invalidPage = (reason: string) =>
  ({ status: "invalid", reason }) as const;
const phases = { blocks: 0, citations: 1, provisions: 2 } as const;
type AppendReaderPageOptions = {
  state: ReaderPager;
  page: ReaderPage;
  cursor: string | null;
};
type ValidateReaderPageContentOptions = {
  state: ReaderPager;
  content: AvailablePage;
  cursor: string | null;
};
const validateReaderPageContent = ({
  state,
  content,
  cursor,
}: ValidateReaderPageContentOptions) => {
  if (
    content.nextCursor !== null &&
    (content.nextCursor.trim().length === 0 ||
      content.nextCursor === cursor ||
      state.seenCursors.includes(content.nextCursor))
  ) {
    return invalidPage("Reader cursor did not advance");
  }
  if (
    phases[content.phase] < phases[state.phase] ||
    phases[content.phase] > phases[state.phase] + 1 ||
    (cursor === null && content.phase !== "blocks")
  ) {
    return invalidPage("Reader phase did not advance in order");
  }
  if (
    (content.phase !== "blocks" &&
      (content.items.length > 0 || content.blockFragments.length > 0)) ||
    (content.phase !== "citations" && content.citationAnchors.length > 0) ||
    (content.phase !== "provisions" && content.provisionAnchors.length > 0)
  ) {
    return invalidPage("Reader page mixed content phases");
  }
  if (state.pendingFragment !== null && content.items.length > 0) {
    return invalidPage("Reader page interrupted a block fragment");
  }
  return null;
};

export const appendReaderPage = ({
  state,
  page,
  cursor,
}: AppendReaderPageOptions) => {
  if (state.complete || cursor !== state.nextCursor) {
    return invalidPage("Unexpected reader page cursor");
  }
  const metadataEntries = new Map(Object.entries(page.metadata));
  const stripFragment = (url: string | null) => url?.split("#", 1).at(0);
  if (
    Object.entries(state.metadata).some(
      ([key, value]) => key !== "appUrl" && metadataEntries.get(key) !== value,
    ) ||
    stripFragment(state.metadata.appUrl) !== stripFragment(page.metadata.appUrl)
  ) {
    return invalidPage("Decision metadata changed between pages");
  }
  const content = page.content;
  if (content.status !== "available") {
    const base = {
      metadata: state.metadata,
      blocks: [],
      citationAnchors: [],
      provisionAnchors: [],
      nextCursor: null,
      complete: true,
      phase: "blocks",
      pendingFragment: null,
      seenCursors: [],
    } satisfies ReaderPagerData;
    if (content.status === "withheld") {
      return {
        status: "accepted",
        state: {
          ...base,
          status: "withheld",
          withheldReason: content.withheldReason,
        } satisfies ReaderPager,
      } as const;
    }
    return {
      status: "accepted",
      state: { ...base, status: "unavailable" } satisfies ReaderPager,
    } as const;
  }
  const contentIssue = validateReaderPageContent({ state, content, cursor });
  if (contentIssue !== null) {
    return contentIssue;
  }
  const blocks = [...state.blocks];
  const blockIds = new Set(blocks.map(({ id }) => id));
  for (const block of content.items) {
    if (blockIds.has(block.id)) {
      return invalidPage("Reader page repeated a block");
    }
    blockIds.add(block.id);
    blocks.push(block);
  }
  let pendingFragment = state.pendingFragment;
  for (const fragment of content.blockFragments) {
    if (
      !Number.isSafeInteger(fragment.offset) ||
      !Number.isSafeInteger(fragment.totalChars) ||
      fragment.totalChars < 1 ||
      fragment.json.length === 0 ||
      blockIds.has(fragment.blockId)
    ) {
      return invalidPage("Invalid reader block fragment");
    }
    if (pendingFragment === null) {
      if (fragment.offset !== 0) {
        return invalidPage("Reader block fragment has no prefix");
      }
      pendingFragment = {
        blockId: fragment.blockId,
        totalChars: fragment.totalChars,
        json: "",
      };
    }
    if (
      pendingFragment.blockId !== fragment.blockId ||
      pendingFragment.totalChars !== fragment.totalChars ||
      fragment.offset !== pendingFragment.json.length ||
      fragment.offset + fragment.json.length > fragment.totalChars
    ) {
      return invalidPage("Reader block fragments are not contiguous");
    }
    pendingFragment = {
      blockId: fragment.blockId,
      totalChars: fragment.totalChars,
      json: pendingFragment.json + fragment.json,
    };
    if (pendingFragment.json.length !== pendingFragment.totalChars) {
      continue;
    }
    const completeJson = pendingFragment.json;
    const parsed = Result.try((): unknown => JSON.parse(completeJson));
    if (Result.isError(parsed)) {
      return invalidPage("Reader block fragment is invalid JSON");
    }
    const block = v.safeParse(blockSchema, parsed.value);
    if (!block.success || block.output.id !== pendingFragment.blockId) {
      return invalidPage("Reader block fragment is not a matching block");
    }
    blocks.push(block.output);
    blockIds.add(block.output.id);
    pendingFragment = null;
  }
  if (
    pendingFragment !== null &&
    (content.nextCursor === null || content.phase !== "blocks")
  ) {
    return invalidPage("Reader page ended with an incomplete block");
  }
  return {
    status: "accepted",
    state: {
      metadata: state.metadata,
      status: "available",
      blocks,
      citationAnchors: [...state.citationAnchors, ...content.citationAnchors],
      provisionAnchors: [
        ...state.provisionAnchors,
        ...content.provisionAnchors,
      ],
      nextCursor: content.nextCursor,
      complete: content.nextCursor === null,
      phase: content.phase,
      pendingFragment,
      seenCursors:
        cursor === null ? state.seenCursors : [...state.seenCursors, cursor],
    } satisfies ReaderPager,
  } as const;
};

const readerDocumentAst = ({ metadata, blocks }: ReaderPager): DocumentAst => ({
  version: 1,
  source: {
    system: metadata.country,
    documentId: metadata.decisionId,
    webUrl: metadata.appUrl ?? "",
    printUrl: "",
  },
  metadata: {
    caseNumber: metadata.caseNumber,
    ecli: metadata.ecli,
    court: metadata.court,
    decisionDate: metadata.date,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});
export const resolveReaderRange = (
  state: ReaderPager,
  range: DecisionParagraphRange,
) => resolveDecisionParagraphRange(readerDocumentAst(state), range);
