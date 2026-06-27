import type { ToolDefinition } from "@opencode-ai/plugin"

export const maPrecedentSearch: ToolDefinition = {
  description: "Search M&A precedent transactions by industry, size, jurisdiction",
  parameters: {
    type: "object",
    properties: {
      industry: { type: "string" },
      minDealSize: { type: "number" },
      maxDealSize: { type: "number" },
      jurisdiction: { type: "string" },
    },
    required: ["industry"],
  },
  execute: async (args: { industry: string; minDealSize?: number; maxDealSize?: number; jurisdiction?: string }) => {
    return `Searching precedents for ${args.industry}... (stub)`
  },
}
