import type { Plugin } from "@opencode-ai/plugin"

const plugin: Plugin = async (_input) => {
  return {
    tool: {
      get_citation_format: {
        description: "Get the legal citation format for a jurisdiction",
        parameters: {
          type: "object",
          properties: { jurisdiction: { type: "string" } },
          required: ["jurisdiction"],
        },
        execute: async ({ jurisdiction }: { jurisdiction: string }) => {
          const formats: Record<string, string> = {
            us: "Bluebook",
            uk: "OSCOLA",
            eu: "ECLI",
            ca: "McGill Guide",
            au: "AGLC",
          }
          return formats[jurisdiction.toLowerCase()] ?? "Unknown jurisdiction"
        },
      },
    },
  }
}

export default plugin
