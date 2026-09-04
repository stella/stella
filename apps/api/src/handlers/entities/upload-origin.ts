import { panic } from "better-result";

export const UPLOAD_ENTITY_ORIGIN = {
  GENERATED_DOCUMENT: "generated-document",
  USER: "user",
} as const;

type UploadEntityOrigin =
  (typeof UPLOAD_ENTITY_ORIGIN)[keyof typeof UPLOAD_ENTITY_ORIGIN];

export const uploadTriggeredFlowPolicy = (
  origin: UploadEntityOrigin,
): "skip" | "start" => {
  switch (origin) {
    case UPLOAD_ENTITY_ORIGIN.GENERATED_DOCUMENT:
      return "skip";
    case UPLOAD_ENTITY_ORIGIN.USER:
      return "start";
    default:
      origin satisfies never;
      return panic(`Unhandled origin: ${String(origin)}`);
  }
};
