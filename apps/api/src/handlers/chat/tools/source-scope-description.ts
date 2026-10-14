import { panic } from "better-result";

import type { ChatCorpus, ChatSourceScope } from "@stll/api-contract";

export const CORPUS_LABELS = {
  case_law: "case law",
  legislation: "legislation",
} as const satisfies Record<ChatCorpus, string>;

const describeSourceScope = (scope: ChatSourceScope): string => {
  switch (scope.kind) {
    case "corpus":
      return `${CORPUS_LABELS[scope.corpus]} (${scope.country})`;
    case "registry":
      return `the ${scope.registry} business registry`;
    case "connector":
      return `the ${scope.connector} connector`;
    default:
      scope satisfies never;
      return panic(`Unhandled source scope: ${String(scope)}`);
  }
};

/** The sources a turn's chips name, as the model reads them in a refusal. */
export const describeSourceScopes = (
  scopes: readonly ChatSourceScope[],
): string => scopes.map(describeSourceScope).join(", ");
