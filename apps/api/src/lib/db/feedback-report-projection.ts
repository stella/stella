import type { feedbackReports } from "@/api/db/schema";

/** Reporter-owned sanitized content, excluding maintainer context and delivery state. */
export const projectFeedbackReportForAccountExport = ({
  receipt,
  kind,
  area,
  title,
  whatHappened,
  expected,
  steps,
  evidence,
  via,
  createdAt,
}: Pick<
  typeof feedbackReports.$inferSelect,
  | "receipt"
  | "kind"
  | "area"
  | "title"
  | "whatHappened"
  | "expected"
  | "steps"
  | "evidence"
  | "via"
  | "createdAt"
>) => ({
  receipt,
  kind,
  area,
  title,
  whatHappened,
  expected,
  steps,
  evidence,
  via,
  createdAt: createdAt.toISOString(),
});
