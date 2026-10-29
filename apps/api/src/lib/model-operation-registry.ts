import type MODEL_OPERATIONS from "../../../../scripts/ownership/model-operation-callers.ts";

/** The ownership declaration is the source of truth for production generators. */
export type ModelOperationId = (typeof MODEL_OPERATIONS.owner)[number];

/** One boundary list feeds admission, provenance and request-send policy. */
export const MODEL_OPERATION_BOUNDARIES = {
  facade: [
    "collectTanStackTextRun",
    "generateTanStackChatObject",
    "generateTanStackObjectForTask",
    "generateTanStackTextForTask",
    "streamTanStackChatRun",
    "streamTanStackObjectForTask",
    "streamTanStackTextForTask",
  ],
  runtime: ["generateChatObject", "streamChatChunks", "streamChatObject"],
} as const;
export const MODEL_OPERATION_NAMES = Object.values(
  MODEL_OPERATION_BOUNDARIES,
).flat();
