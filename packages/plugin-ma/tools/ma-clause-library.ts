import type { ToolDefinition } from "@opencode-ai/plugin"

export const maClauseLibrary: ToolDefinition = {
  description: "Retrieve M&A clause templates from the clause library",
  parameters: {
    type: "object",
    properties: {
      clauseType: { type: "string", enum: ["indemnity", "earnout", "reps-warranties", "non-compete", "price-adjustment"] },
    },
    required: ["clauseType"],
  },
  execute: async (args: { clauseType: string }) => {
    return `Retrieving ${args.clauseType} clause from library... (stub)`
  },
}
