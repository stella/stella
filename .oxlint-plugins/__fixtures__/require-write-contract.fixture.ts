import { createSafeHandler } from "@/api/lib/api-handlers";

const handler = () => undefined;

// oxlint-disable-next-line require-write-contract/require-write-contract
export const missing = createSafeHandler(
  { description: "Update tags" },
  handler,
);
// oxlint-disable-next-line require-write-contract/require-write-contract
export const mislabeled = createSafeHandler(
  { contract: "patch", description: "Replace tags" },
  handler,
);

// expect-clean: require-write-contract/require-write-contract
export const patch = createSafeHandler(
  { contract: "patch", description: "Update tags" },
  handler,
);
// expect-clean: require-write-contract/require-write-contract
export const replace = createSafeHandler(
  { contract: "replace", description: "Replace tags" },
  handler,
);
