import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "publisher-fetch",
  capability:
    "Fetching publisher HTTP resources under robots and pacing policy",
  owner: ["packages/fetch/src/publisher.ts"],
  summary:
    "`politePublisherFetch` caches bounded robots.txt responses per origin, " +
    "selects stella's RFC 9309 group, evaluates path rules, serializes callers " +
    "through one crawl-delay scheduler and returns typed policy refusals. Licensed " +
    "and audit bypasses emit structured evidence before the request proceeds.",
  enforcement: {
    kind: "custom-rule",
    rule: "require-polite-publisher-fetch/require-polite-publisher-fetch",
    reason:
      "Publisher ingestion and research tooling reject raw fetch bindings; existing script findings are held in the shrink-only design lint baseline.",
  },
} as const satisfies OwnershipEntry;
