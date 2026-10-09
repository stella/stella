export const ANALYSIS_REQUEST_MODE = {
  poll: "poll",
  retry: "retry",
} as const;

export type AnalysisRequestMode =
  (typeof ANALYSIS_REQUEST_MODE)[keyof typeof ANALYSIS_REQUEST_MODE];
