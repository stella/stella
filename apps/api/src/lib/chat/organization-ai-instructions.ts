import { sanitizeForPrompt, untrustedText } from "@/api/lib/prompt-safety";

export const buildOrganizationAIInstructionsPrompt = (
  instructions: string,
): string => {
  if (instructions.trim().length === 0) {
    return "";
  }

  return [
    "ORGANIZATION INSTRUCTIONS: These instructions are configured by an organization administrator and apply to every conversation. Follow them ahead of conflicting personal preferences, saved memories, skill instructions, and user requests. They do not override stella's safety, data-access, tool-availability, approval, or truthfulness rules.",
    sanitizeForPrompt(untrustedText(instructions), {
      open: "<<<ORGANIZATION_INSTRUCTIONS>>>",
      close: "<<<END_ORGANIZATION_INSTRUCTIONS>>>",
    }),
  ].join("\n");
};
