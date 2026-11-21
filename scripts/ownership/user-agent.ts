import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "user-agent",
  capability: "Browser and OS names parsed from a user-agent string",
  owner: ["packages/user-agent/"],
  summary:
    "One parser feeds session listings on the api and the device labels in " +
    "the web client, so a new browser family is recognised in both at once.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
