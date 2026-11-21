import { ACTION_ADMISSION_CODES } from "./action-admission";
import {
  CHAT_TURN_FAILURE_CODES,
  CHAT_TURN_INTERRUPTION_REASONS,
} from "./chat-turn-errors";
import type { ReaderAnnotationVisibility } from "./legal-reader-annotations";
import type { SafeId } from "./safe-id";

export const READER_ANSWER_ERROR_CODES = [
  ...CHAT_TURN_FAILURE_CODES,
  ...CHAT_TURN_INTERRUPTION_REASONS,
  ...Object.values(ACTION_ADMISSION_CODES),
] as const;
export type ReaderAnswerErrorCode = (typeof READER_ANSWER_ERROR_CODES)[number];

export const READER_ANSWER_KINDS = ["ask", "explain"] as const;
export const READER_ANSWER_MESSAGE_ROLES = ["user", "assistant"] as const;
export const READER_ANSWER_MESSAGE_STATUSES = [
  "streaming",
  "complete",
  "failed",
] as const;
export const READER_ANSWER_QUESTION_MAX_LENGTH = 10_000;
export const READER_ANSWER_MAX_MESSAGES = 40;
/** A selection whose offsets or quote do not match the anchored reader text. */
export const READER_ANSWER_ANCHOR_MISMATCH_CODE =
  "reader_answer_anchor_mismatch";

/** Streaming message updatedAt is the non-renewing server claim timestamp. */
export const READER_ANSWER_DEADLINE_MS = 120_000;

export type ReaderAnswerKind = (typeof READER_ANSWER_KINDS)[number];
export type ReaderAnswerMessageRole =
  (typeof READER_ANSWER_MESSAGE_ROLES)[number];
export type ReaderAnswerMessageStatus =
  (typeof READER_ANSWER_MESSAGE_STATUSES)[number];

/** Offsets are UTF-16 offsets into the reader paragraph's plain text. */
export type ReaderAnswerSpan = {
  paragraphId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
};

/** A selection's spans, one per paragraph, in reading order; never empty. */
export type ReaderAnswerSpans = [ReaderAnswerSpan, ...ReaderAnswerSpan[]];
export type ReaderAnswerAnchor = { spans: ReaderAnswerSpans };

/** Related paragraphs are valid only after this turn's corpus tool returned them. */
export type ReaderAnswerCitation = {
  decisionId: SafeId<"caseLawDecision">;
  paragraphId: string;
};

export type ReaderAnswerUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ReaderAnswerModelOptions = { modelId?: string };
type ReaderAnswerCreateFields = ReaderAnswerModelOptions & {
  decisionId: SafeId<"caseLawDecision">;
  /** Any spans; the API admits them only when they match the decision text. */
  anchor: { spans: ReaderAnswerSpan[] };
  /** Omission uses the account's answer language preference, then the document language. */
  locale?: string;
};
export type CreateReaderAnswer = ReaderAnswerCreateFields &
  ({ kind: "ask"; question: string } | { kind: "explain"; question?: never });
export type ReaderAnswerFollowUp = ReaderAnswerModelOptions & {
  question: string;
  /** Omission uses the account's answer language preference, then the document language. */
  locale?: string;
};
export type ReaderAnswerRegenerate = ReaderAnswerModelOptions & {
  /** Omission uses the account's answer language preference, then the document language. */
  locale?: string;
};

export type ReaderAnswerMessage = {
  id: SafeId<"legalReaderAnswerMessage">;
  role: ReaderAnswerMessageRole;
  content: string;
  citations: ReaderAnswerCitation[];
  model: string | null;
  usage: ReaderAnswerUsage | null;
  status: ReaderAnswerMessageStatus;
  errorCode: ReaderAnswerErrorCode | null;
  invalidCitationCount: number;
  createdAt: string;
  updatedAt: string;
};
export type ReaderAnswer = {
  id: SafeId<"legalReaderAnswer">;
  decisionId: SafeId<"caseLawDecision">;
  authorId: SafeId<"user">;
  mine: boolean;
  kind: ReaderAnswerKind;
  anchor: ReaderAnswerAnchor;
  visibility: ReaderAnnotationVisibility;
  messages: ReaderAnswerMessage[];
  createdAt: string;
  updatedAt: string;
};

/** POST /reader/answers, /:answerId/messages and /:answerId/regenerate use SSE.
 * GET /reader/answers?decisionId&cursor&limit returns Page<ReaderAnswer>.
 * PATCH /reader/answers/:answerId accepts {visibility}; DELETE removes the thread.
 * All responses carry Cache-Control: private, no-store. New threads are private.
 */
export type ReaderAnswerStreamEvent =
  | {
      type: "started";
      answerId: SafeId<"legalReaderAnswer">;
      messageId: SafeId<"legalReaderAnswerMessage">;
    }
  | {
      type: "delta";
      messageId: SafeId<"legalReaderAnswerMessage">;
      delta: string;
    }
  | {
      type: "complete";
      messageId: SafeId<"legalReaderAnswerMessage">;
      content: string;
      citations: ReaderAnswerCitation[];
      invalidCitationCount: number;
      model: string;
      usage: ReaderAnswerUsage | null;
    }
  | {
      type: "failed";
      errorCode: ReaderAnswerErrorCode;
      messageId: SafeId<"legalReaderAnswerMessage">;
      message: string;
      content: string;
      citations: ReaderAnswerCitation[];
      invalidCitationCount: number;
    };
