import type { Plugin } from "@opencode-ai/plugin"

const STELLA_API = process.env.STELLA_API_URL ?? "http://api:3001"

const fetchWorkspacePlugins = async (workspaceId: string) => {
  try {
    const res = await fetch(`${STELLA_API}/workspaces/${workspaceId}/plugins`)
    if (!res.ok) return []
    return (await res.json()) as Array<{
      name: string
      displayName: string
      skills?: string[]
      tools?: { name: string }[]
    }>
  } catch {
    return []
  }
}

const plugin: Plugin = async () => {
  return {
    "chat.params": async (input, output) => {
      const workspaceId = input.sessionID.split("_").at(1) ?? null
      if (!workspaceId) return

      const manifests = await fetchWorkspacePlugins(workspaceId)
      const names = manifests.map((m) => m.displayName).join(", ")
      const skills = manifests.flatMap((m) => m.skills ?? [])

      output.options = {
        ...output.options,
        activePlugins: names,
        pluginSkills: skills.join(", "),
      }
    },
  }
}

export default plugin
