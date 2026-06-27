import type { Plugin } from "@opencode-ai/plugin"

const plugin: Plugin = async (_input) => {
  return {
    "tool.execute.after": async (_input, output) => {
      output.title = "audit-logged"
      output.metadata = { audited: true, timestamp: Date.now() }
    },
  }
}

export default plugin
