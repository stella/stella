import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "app-urls",
  capability: "Links back into the web app from API responses",
  owner: ["apps/api/src/lib/mcp-connectors/app-urls.ts"],
  summary:
    "One module resolves the deployment's frontend origin and builds the " +
    "in-app paths an API response hands a person or an agent, so a link a " +
    "refusal or a tool result carries points at the same app on a " +
    "self-hosted deployment as on the hosted one. It lives beside the " +
    "connector/native-tool catalogue metadata: the catalogue entry page is " +
    "what these links mostly name, and the flat `apps/api/src/lib` bucket " +
    "only shrinks.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
