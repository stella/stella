import type { Plugin } from "@opencode-ai/plugin"

const hook: Plugin = async () => {
  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool.startsWith("ma_")) {
        output.metadata = { ...output.metadata, ma_audited: true, ma_tool: input.tool }
      }
    },
  }
}

export default hook
