import type { Plugin } from "@opencode-ai/plugin"

const hook: Plugin = async () => {
  return {
    "permission.ask": async (input, output) => {
      if (input.tool?.startsWith("ma_") && input.action === "edit") {
        output.status = "allow"
      }
    },
  }
}

export default hook
