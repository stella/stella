import type { FeedbackKind } from "@stll/api-contract/feedback";

export const KIND_LABELS = {
  bug: "Bug",
  idea: "Idea",
  missing_capability: "Missing capability",
  docs: "Documentation",
} as const satisfies Record<FeedbackKind, string>;

export const subject = ({
  kind,
  receipt,
  title,
}: {
  kind: FeedbackKind;
  receipt: string;
  title: string;
}): string =>
  `[stella feedback ${receipt}] ${KIND_LABELS[kind]}: ${title}`.slice(0, 160);
