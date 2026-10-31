import { panic, Result } from "better-result";

import type {
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@/components/legal-reader/annotations/annotation-types";
import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";

/** How many of the reader's own steps one document keeps for undo. */
export const READER_ANNOTATION_HISTORY_LIMIT = 50;

type AnnotationSubject = ReaderAnnotation["kind"];

/** One named change, without the mark it is applied to. */
type AnnotationChange = UpdateAnnotationInput extends infer Change
  ? Change extends UpdateAnnotationInput
    ? Omit<Change, "id">
    : never
  : never;

/**
 * What takes one step back. Each entry is the inverse of something the reader
 * did, written in the same three operations the reader has: a created mark is
 * removed, a removed mark is created again from what it held, and a change is
 * set back. `rowIds` are every row of the mark, so the step still finds the
 * mark when only some of its rows are on screen.
 */
export type ReaderAnnotationInverse =
  | {
      /**
       * What the created mark held, one value per kind of change it can
       * take: the step removes it only while it still holds all of them.
       */
      expected: readonly AnnotationChange[];
      op: "remove";
      rowIds: readonly string[];
      subject: AnnotationSubject;
    }
  | {
      input: CreateAnnotationInput;
      op: "restore";
      rowIds: readonly string[];
      subject: AnnotationSubject;
    }
  | {
      /** The value the mark holds while this step is still valid. */
      expected: AnnotationChange;
      op: "revert";
      /** The value the step puts back. */
      restore: AnnotationChange;
      rowIds: readonly string[];
      subject: AnnotationSubject;
    };

export type ReaderAnnotationHistoryEntry = {
  inverse: ReaderAnnotationInverse;
  /** When the step began, so steps that finish out of order stay in order. */
  seq: number;
};

export type ReaderAnnotationHistoryDirection = "redo" | "undo";

export type ReaderAnnotationHistory = Readonly<
  Record<
    ReaderAnnotationHistoryDirection,
    readonly ReaderAnnotationHistoryEntry[]
  >
>;

export const EMPTY_READER_ANNOTATION_HISTORY: ReaderAnnotationHistory = {
  redo: [],
  undo: [],
};

const bounded = (
  entries: readonly ReaderAnnotationHistoryEntry[],
): readonly ReaderAnnotationHistoryEntry[] =>
  entries.length > READER_ANNOTATION_HISTORY_LIMIT
    ? entries.slice(entries.length - READER_ANNOTATION_HISTORY_LIMIT)
    : entries;

/**
 * Something the reader just did. It lands in the order it began, and a new
 * step forgets what could have been redone, as every editor does.
 */
export const recordReaderAnnotationStep = (
  history: ReaderAnnotationHistory,
  entry: ReaderAnnotationHistoryEntry,
): ReaderAnnotationHistory => {
  const after = history.undo.findIndex((known) => known.seq > entry.seq);
  const undo =
    after === -1
      ? [...history.undo, entry]
      : [...history.undo.slice(0, after), entry, ...history.undo.slice(after)];
  return { redo: [], undo: bounded(undo) };
};

/** The latest step in one direction, and the history without it. */
export const takeReaderAnnotationStep = (
  history: ReaderAnnotationHistory,
  direction: ReaderAnnotationHistoryDirection,
): {
  entry: ReaderAnnotationHistoryEntry;
  history: ReaderAnnotationHistory;
} | null => {
  const entry = history[direction].at(-1);
  if (entry === undefined) {
    return null;
  }
  return {
    entry,
    history: { ...history, [direction]: history[direction].slice(0, -1) },
  };
};

/**
 * Puts a step on top of one direction: the opposite of a step just taken, or
 * the step itself when taking it failed and it is still owed.
 */
const pushReaderAnnotationStep = (
  history: ReaderAnnotationHistory,
  direction: ReaderAnnotationHistoryDirection,
  entry: ReaderAnnotationHistoryEntry,
): ReaderAnnotationHistory => ({
  ...history,
  [direction]: bounded([...history[direction], entry]),
});

/**
 * A mark created again gets new rows. Every step that names its old rows
 * names the new ones instead, row for row, so an older step still reaches it.
 */
export const remapReaderAnnotationRows = (
  history: ReaderAnnotationHistory,
  from: readonly string[],
  to: readonly string[],
): ReaderAnnotationHistory => {
  const first = to.at(0);
  if (first === undefined) {
    return history;
  }
  const mapRow = (id: string): string => {
    const index = from.indexOf(id);
    return index === -1 ? id : (to.at(index) ?? first);
  };
  const mapEntries = (entries: readonly ReaderAnnotationHistoryEntry[]) =>
    entries.map((entry) =>
      entry.inverse.rowIds.some((id) => from.includes(id))
        ? {
            ...entry,
            inverse: {
              ...entry.inverse,
              rowIds: entry.inverse.rowIds.map(mapRow),
            },
          }
        : entry,
    );
  return { redo: mapEntries(history.redo), undo: mapEntries(history.undo) };
};

/** Every row of the mark one row belongs to, in reading order. */
const markRows = (
  rows: readonly ReaderAnnotation[],
  id: string,
): ReaderAnnotation[] => {
  const target = rows.find((row) => row.id === id);
  if (target === undefined) {
    return [];
  }
  return target.groupId === null
    ? [target]
    : rows.filter((row) => row.groupId === target.groupId);
};

/** What a mark holds for one kind of change; null where it holds nothing. */
const currentValue = (
  rows: readonly ReaderAnnotation[],
  change: AnnotationChange["change"],
): AnnotationChange | null => {
  const first = rows.at(0);
  if (first === undefined) {
    return null;
  }
  switch (change) {
    case "body": {
      const body = rows.find((row) => row.body !== null)?.body ?? null;
      return body === null ? null : { body, change };
    }
    case "color": {
      return first.color === null ? null : { change, color: first.color };
    }
    case "style": {
      return first.style === null ? null : { change, style: first.style };
    }
    case "visibility": {
      return { change, visibility: first.visibility };
    }
    default: {
      change satisfies never;
      return panic(`Unhandled change: ${String(change)}`);
    }
  }
};

const sameValue = (
  left: AnnotationChange,
  right: AnnotationChange,
): boolean => {
  switch (left.change) {
    case "body": {
      return right.change === "body" && right.body === left.body;
    }
    case "color": {
      return right.change === "color" && right.color === left.color;
    }
    case "style": {
      return right.change === "style" && right.style === left.style;
    }
    case "visibility": {
      return (
        right.change === "visibility" && right.visibility === left.visibility
      );
    }
    default: {
      left satisfies never;
      return panic(`Unhandled change: ${String(left)}`);
    }
  }
};

/** What a mark created from `input` holds for each change it can take. */
const createdValues = (
  input: CreateAnnotationInput,
): readonly AnnotationChange[] => {
  switch (input.kind) {
    case "highlight": {
      return [
        { change: "color", color: input.color },
        { change: "style", style: input.style },
        { change: "visibility", visibility: input.visibility },
      ];
    }
    case "comment": {
      return [
        { body: input.body, change: "body" },
        { change: "visibility", visibility: input.visibility },
      ];
    }
    default: {
      input satisfies never;
      return panic(`Unhandled annotation kind: ${String(input)}`);
    }
  }
};

/** Whether a mark still holds every value in `expected`. */
const holdsValues = (
  mark: readonly ReaderAnnotation[],
  expected: readonly AnnotationChange[],
): boolean =>
  expected.every((value) => {
    const now = currentValue(mark, value.change);
    return now !== null && sameValue(now, value);
  });

/** The step back from a mark the reader just created. */
export const inverseOfCreate = (
  input: CreateAnnotationInput,
  rowIds: readonly string[],
): ReaderAnnotationInverse | null =>
  rowIds.length === 0
    ? null
    : {
        expected: createdValues(input),
        op: "remove",
        rowIds,
        subject: input.kind,
      };

/**
 * The step back from a change, read off the mark before the change lands.
 * Null when the change would leave the mark as it is: there is nothing to
 * take back.
 */
export const inverseOfUpdate = (
  rows: readonly ReaderAnnotation[],
  { id, ...change }: UpdateAnnotationInput,
): ReaderAnnotationInverse | null => {
  const mark = markRows(rows, id);
  const first = mark.at(0);
  const before = currentValue(mark, change.change);
  if (first === undefined || before === null || sameValue(before, change)) {
    return null;
  }
  return {
    expected: change,
    op: "revert",
    restore: before,
    rowIds: mark.map((row) => row.id),
    subject: first.kind,
  };
};

/**
 * The step back from removing a mark: everything needed to create it again,
 * read off the mark before it goes. A comment's words sit on its first row,
 * so that row leads.
 */
export const inverseOfRemove = (
  rows: readonly ReaderAnnotation[],
  id: string,
): ReaderAnnotationInverse | null => {
  const mark = markRows(rows, id);
  const bodyRow = mark.find((row) => row.body !== null);
  const ordered =
    bodyRow === undefined
      ? mark
      : [bodyRow, ...mark.filter((row) => row !== bodyRow)];
  const first = ordered.at(0);
  if (first === undefined) {
    return null;
  }
  const spans = ordered.map((row) => ({
    blockAnchorId: row.blockAnchorId,
    endOffset: row.endOffset,
    quote: row.quote,
    startOffset: row.startOffset,
  }));
  const rowIds = ordered.map((row) => row.id);
  switch (first.kind) {
    case "highlight": {
      if (first.color === null || first.style === null) {
        return null;
      }
      return {
        input: {
          color: first.color,
          kind: "highlight",
          spans,
          style: first.style,
          visibility: first.visibility,
        },
        op: "restore",
        rowIds,
        subject: "highlight",
      };
    }
    case "comment": {
      if (bodyRow?.body === undefined || bodyRow.body === null) {
        return null;
      }
      return {
        input: {
          body: bodyRow.body,
          kind: "comment",
          spans,
          visibility: first.visibility,
        },
        op: "restore",
        rowIds,
        subject: "comment",
      };
    }
    default: {
      first.kind satisfies never;
      return panic(`Unhandled annotation kind: ${String(first.kind)}`);
    }
  }
};

/**
 * The write that takes a step. A write that removes or updates carries the
 * step that would take it back; a create learns its opposite from the rows
 * the store gives the mark.
 */
export type ReaderAnnotationStepPlan =
  | { status: "gone" }
  | { status: "changed" }
  | {
      status: "ready";
      write:
        | {
            id: string;
            kind: "remove";
            opposite: ReaderAnnotationInverse | null;
          }
        | {
            input: UpdateAnnotationInput;
            kind: "update";
            opposite: ReaderAnnotationInverse;
          }
        | { input: CreateAnnotationInput; kind: "create" };
    };

/**
 * Whether a step can still be taken against the marks as they are now. A mark
 * that is gone, or that changed since the reader's own step (in another tab,
 * say), is left alone: taking the step would overwrite something the reader
 * did not do here.
 */
export const planReaderAnnotationStep = (
  rows: readonly ReaderAnnotation[],
  inverse: ReaderAnnotationInverse,
): ReaderAnnotationStepPlan => {
  const present = inverse.rowIds.find((id) =>
    rows.some((row) => row.id === id),
  );
  switch (inverse.op) {
    case "remove": {
      if (present === undefined) {
        return { status: "gone" };
      }
      if (!holdsValues(markRows(rows, present), inverse.expected)) {
        return { status: "changed" };
      }
      return {
        status: "ready",
        write: {
          id: present,
          kind: "remove",
          opposite: inverseOfRemove(rows, present),
        },
      };
    }
    case "restore": {
      return {
        status: "ready",
        write: { input: inverse.input, kind: "create" },
      };
    }
    case "revert": {
      if (present === undefined) {
        return { status: "gone" };
      }
      const now = currentValue(
        markRows(rows, present),
        inverse.expected.change,
      );
      if (now === null || !sameValue(now, inverse.expected)) {
        return { status: "changed" };
      }
      return {
        status: "ready",
        write: {
          input: { id: present, ...inverse.restore },
          kind: "update",
          opposite: {
            expected: inverse.restore,
            op: "revert",
            restore: inverse.expected,
            rowIds: inverse.rowIds,
            subject: inverse.subject,
          },
        },
      };
    }
    default: {
      inverse satisfies never;
      return panic(`Unhandled annotation step: ${String(inverse)}`);
    }
  }
};

/** How taking a step ended. */
export type ReaderAnnotationStepResult =
  | {
      opposite: ReaderAnnotationInverse | null;
      /** The rows a mark created again was given, in the order it had. */
      recreatedRows?: readonly string[];
      status: "done";
    }
  | { status: "changed" }
  | { status: "failed" }
  | { status: "gone" };

/**
 * A write to wherever the marks are kept. It has already told the reader when
 * it failed and put the marks back, so a caller only learns whether it held.
 */
type AnnotationWrite<Value> = Promise<Result<Value, Error>>;

/** The three writes a store offers, and the marks as the store now holds them. */
export type ReaderAnnotationWrites = {
  /** Resolves to the new mark's rows, in span order. */
  create: (input: CreateAnnotationInput) => AnnotationWrite<readonly string[]>;
  remove: (id: string) => AnnotationWrite<void>;
  /** The freshest marks known: read at the moment a step is taken. */
  rows: () => readonly ReaderAnnotation[];
  update: (input: UpdateAnnotationInput) => AnnotationWrite<void>;
};

/**
 * Takes one step through the store's ordinary writes, so what the server holds
 * afterwards is exactly what the reader sees.
 */
export const performReaderAnnotationStep = async (
  writes: ReaderAnnotationWrites,
  inverse: ReaderAnnotationInverse,
): Promise<ReaderAnnotationStepResult> => {
  const plan = planReaderAnnotationStep(writes.rows(), inverse);
  if (plan.status !== "ready") {
    return plan;
  }
  switch (plan.write.kind) {
    case "create": {
      const created = await writes.create(plan.write.input);
      if (Result.isError(created)) {
        return { status: "failed" };
      }
      return {
        opposite: inverseOfCreate(plan.write.input, created.value),
        recreatedRows: created.value,
        status: "done",
      };
    }
    case "remove": {
      const removed = await writes.remove(plan.write.id);
      return Result.isError(removed)
        ? { status: "failed" }
        : { opposite: plan.write.opposite, status: "done" };
    }
    case "update": {
      const updated = await writes.update(plan.write.input);
      return Result.isError(updated)
        ? { status: "failed" }
        : { opposite: plan.write.opposite, status: "done" };
    }
    default: {
      plan.write satisfies never;
      return panic(`Unhandled annotation write: ${String(plan.write)}`);
    }
  }
};

const OPPOSITE_DIRECTION = {
  redo: "undo",
  undo: "redo",
} as const satisfies Record<
  ReaderAnnotationHistoryDirection,
  ReaderAnnotationHistoryDirection
>;

export const oppositeDirection = (
  direction: ReaderAnnotationHistoryDirection,
): ReaderAnnotationHistoryDirection => OPPOSITE_DIRECTION[direction];

/**
 * The history once a step taken off `direction` has ended. A step that held
 * offers its opposite the other way; one that failed is owed again; one that
 * found its mark gone or changed is dropped, because it can never be taken.
 */
export const settleReaderAnnotationStep = ({
  direction,
  entry,
  history,
  result,
}: {
  direction: ReaderAnnotationHistoryDirection;
  entry: ReaderAnnotationHistoryEntry;
  /** The history with `entry` already taken off. */
  history: ReaderAnnotationHistory;
  result: ReaderAnnotationStepResult;
}): ReaderAnnotationHistory => {
  switch (result.status) {
    case "changed":
    case "gone": {
      return history;
    }
    case "failed": {
      return pushReaderAnnotationStep(history, direction, entry);
    }
    case "done": {
      const remapped =
        result.recreatedRows === undefined
          ? history
          : remapReaderAnnotationRows(
              history,
              entry.inverse.rowIds,
              result.recreatedRows,
            );
      return result.opposite === null
        ? remapped
        : pushReaderAnnotationStep(remapped, oppositeDirection(direction), {
            inverse: result.opposite,
            seq: entry.seq,
          });
    }
    default: {
      result satisfies never;
      return panic(`Unhandled step result: ${String(result)}`);
    }
  }
};

/** What the reader is told a step did. */
export type ReaderAnnotationStepOutcome =
  | "colorRestored"
  | "commentRemoved"
  | "commentRestored"
  | "highlightRemoved"
  | "highlightRestored"
  | "styleRestored"
  | "textRestored"
  | "visibilityRestored";

export const readerAnnotationStepOutcome = (
  inverse: ReaderAnnotationInverse,
): ReaderAnnotationStepOutcome => {
  switch (inverse.op) {
    case "remove": {
      return inverse.subject === "highlight"
        ? "highlightRemoved"
        : "commentRemoved";
    }
    case "restore": {
      return inverse.subject === "highlight"
        ? "highlightRestored"
        : "commentRestored";
    }
    case "revert": {
      switch (inverse.restore.change) {
        case "body": {
          return "textRestored";
        }
        case "color": {
          return "colorRestored";
        }
        case "style": {
          return "styleRestored";
        }
        case "visibility": {
          return "visibilityRestored";
        }
        default: {
          inverse.restore satisfies never;
          return panic(`Unhandled change: ${String(inverse.restore)}`);
        }
      }
    }
    default: {
      inverse satisfies never;
      return panic(`Unhandled annotation step: ${String(inverse)}`);
    }
  }
};
