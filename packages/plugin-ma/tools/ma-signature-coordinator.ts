import type { ToolDefinition } from "@opencode-ai/plugin"

export const maSignatureCoordinator: ToolDefinition = {
  description: "Coordinate signature collection for M&A documents",
  parameters: {
    type: "object",
    properties: {
      documentId: { type: "string" },
      signers: { type: "array", items: { type: "string" } },
      deadline: { type: "string" },
    },
    required: ["documentId", "signers"],
  },
  execute: async (args: { documentId: string; signers: string[]; deadline?: string }) => {
    return `Coordinating signatures for ${args.documentId} with ${args.signers.length} signers (stub)`
  },
}
