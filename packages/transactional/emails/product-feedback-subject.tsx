import type { ProductFeedbackKind } from "./product-feedback";

export const KIND_LABELS: Record<ProductFeedbackKind, string> = {
  bug: "Bug",
  feature_request: "Feature request",
  docs: "Documentation",
  other: "Other",
};

export const subject = ({
  kind,
  title,
}: {
  kind: ProductFeedbackKind;
  title: string;
}): string => `[stella feedback] ${KIND_LABELS[kind]}: ${title}`.slice(0, 160);
