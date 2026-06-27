import * as v from "valibot"

export const PluginManifestSchema = v.strictObject({
  name: v.string(),
  version: v.string(),
  displayName: v.string(),
  category: v.string(),
  permissions: v.object({
    required: v.array(v.string()),
    optional: v.array(v.string()),
  }),
  agents: v.array(v.string()),
  skills: v.array(v.string()),
  tools: v.array(
    v.object({
      name: v.string(),
      sandbox: v.optional(v.string()),
    }),
  ),
  knowledgeIntegrations: v.optional(
    v.object({
      templates: v.array(v.string()),
      clauses: v.array(v.string()),
      skills: v.array(v.string()),
    }),
  ),
})
