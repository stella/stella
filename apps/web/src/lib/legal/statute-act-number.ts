/**
 * A statute's document identity badge, read off its ELI. The act's number
 * and name labels live in `@stll/api-contract/statute-act-number`, shared
 * with the MCP reader.
 */

import { statuteEliParts } from "@stll/api-contract/statute-act-number";
import type { DocumentIdentity } from "@stll/ui/document-identity-badge.logic";

export const statuteDocumentIdentity = (eli: string | null | undefined) => {
  const { number, year } = statuteEliParts(eli);
  return { kind: "statute", number, year } as const satisfies DocumentIdentity;
};
