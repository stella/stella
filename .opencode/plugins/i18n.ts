import type { Plugin } from "@opencode-ai/plugin"

const plugin: Plugin = async (_input) => {
  return {
    "chat.headers": async (_input, output) => {
      output.headers = { "x-i18n-locale": "en" }
    },
  }
}

export default plugin
