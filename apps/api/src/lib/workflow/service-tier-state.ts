import type { AIRequestServiceTier } from "@/api/lib/ai-config";

export const parseStoredWorkflowServiceTier = (
  value: string | null,
): AIRequestServiceTier => {
  if (value === "standard" || value === "flex" || value === "batch") {
    return value;
  }

  return "standard";
};
