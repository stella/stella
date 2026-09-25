/**
 * What the add-columns composer holds, and what each target stores it as.
 *
 * The reader types one thing — a name or a question, a kind of value, a
 * select's options — and the target decides what that becomes: a matter
 * property, or an organization's case-law question column. Keeping the two
 * mappings here is what makes them testable without a dialog, and what stops
 * the question column drifting away from the property it is modelled on.
 */

import { panic, Result } from "better-result";

import type { CaseLawResearchAnswerType } from "@stll/api-contract";

import type { CreatableContentType } from "@/components/workspaces/properties/composer-primitives";
import type {
  QuestionColumn,
  QuestionColumnContent,
} from "@/features/case-law/research/question-columns.logic";
import type { SelectPropertyOption } from "@/lib/types";

type DraftTool = "ai-model" | "manual-input";

export type Draft = {
  id: number;
  name: string;
  prompt: string;
  mentions: string[];
  fileIds: string[];
  contentType: CreatableContentType;
  tool: DraftTool;
  options: SelectPropertyOption[];
  fallback: string | null;
};

export const makeEmptyDraft = (
  id: number,
  defaultFileIds: string[],
): Draft => ({
  id,
  name: "",
  prompt: "",
  mentions: [],
  fileIds: defaultFileIds,
  contentType: "text",
  tool: "ai-model",
  options: [],
  fallback: null,
});

const NO_FILE_IDS: string[] = [];

/**
 * Every kind the composer offers is a kind a question may be asked in.
 *
 * The composer's chips and the answer kinds are two lists with one meaning:
 * a content type the model cannot produce a value for must never reach a
 * question column, because no run could ever fill it. Adding such a kind to
 * the composer fails here rather than shipping a column that stays empty.
 */
true satisfies CreatableContentType extends CaseLawResearchAnswerType
  ? true
  : never;

/**
 * A draft as the question column stores it: the same content a matter property
 * of that kind carries, minus the fallback — a decision honestly not settling
 * a question is an answer, and substituting a default would fabricate one.
 */
export const questionColumnContent = (draft: Draft): QuestionColumnContent => {
  switch (draft.contentType) {
    case "single-select":
    case "multi-select":
      return {
        version: 1,
        type: draft.contentType,
        options: draft.options,
        fallback: null,
      };
    case "date":
    case "int":
      return { version: 1, type: draft.contentType };
    case "text":
      return { version: 1, type: "text" };
    default:
      draft.contentType satisfies never;
      return panic(`Unhandled content type: ${String(draft.contentType)}`);
  }
};

/** The stored question, back in the shape the composer edits. */
export const questionDraft = (column: QuestionColumn): Draft => ({
  ...makeEmptyDraft(0, NO_FILE_IDS),
  name: column.question,
  contentType: column.content.type,
  ...(column.content.type === "single-select" ||
  column.content.type === "multi-select"
    ? { options: column.content.options }
    : {}),
});

type SettleColumnWritesOptions = {
  /** One column's create or update each; they name disjoint columns. */
  writes: readonly (() => Promise<unknown>)[];
  /** Re-reads the target's columns. */
  refresh: () => Promise<void>;
};

/**
 * Runs every write to completion, refreshes the columns, then reports the
 * first failure.
 *
 * Settling rather than rejecting at the first error is what keeps the cache
 * honest: the writes are independent requests, so one may commit while another
 * is refused (two drafts competing for the organization's last free column),
 * and the column that did land has to reach the cache even though the dialog
 * reports the other's failure.
 */
export const settleColumnWrites = async ({
  writes,
  refresh,
}: SettleColumnWritesOptions): Promise<Result<void, Error>> => {
  const [, failures] = await Result.partitionAsync(
    writes.map(
      async (write) =>
        await Result.tryPromise({
          try: write,
          // An `APIError` arrives as itself, so the dialog reports the
          // failure exactly as it would without the batching.
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        }),
    ),
  );
  await refresh();
  const failure = failures.at(0);
  return failure === undefined ? Result.ok(undefined) : Result.err(failure);
};
