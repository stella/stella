import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "parameter-store",
  capability: "Reading deployment parameters",
  owner: ["packages/parameter-store/"],
  summary:
    "One parameter read returns a typed Result with a value and version, " +
    "a five-second deadline, cancellation, and sanitized failure reasons. " +
    "API configuration owns grant parsing and refresh scheduling.",
  enforcement: {
    kind: "import",
    specifiers: ["@aws-sdk/client-ssm"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
