import { Result } from "better-result";

import type { ChatCorpus, ChatCorpusScope } from "@stll/api-contract";

import type { RegistryReadToolName } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { toRegistryChatToolError } from "@/api/handlers/chat/tools/registry-adapter/registry-tool-error";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

/**
 * Per-turn corpus scope. A corpus chip in the latest user message
 * ("@Case law · Czechia") pins that turn's public-corpus reads to the corpora
 * and countries the chips name. The server enforces it here rather than in
 * the prompt, and it only ever narrows: tenant and workspace tools are left
 * alone, since the same message may also mention a matter.
 */

type CorpusReadTool = {
  corpus: ChatCorpus;
  /**
   * The tool's country property, or null for a read keyed by a decision or
   * statute id. Such a read follows an id the model already holds, so the
   * scope has no country to compare it with.
   */
  country: { field: string; optional: boolean } | null;
};

/** The registry reads over the corpora a chip can name. */
type CorpusReadToolName = Extract<
  RegistryReadToolName,
  | "search_case_law"
  | "case_law_coverage"
  | "read_case_law_decision"
  | "read_case_law_citations"
  | "search_legislation"
  | "read_statute"
  | "read_statute_provisions"
  | "read_provision_history"
>;

const CORPUS_READ_TOOLS = {
  search_case_law: {
    corpus: "case_law",
    country: { field: "country", optional: false },
  },
  case_law_coverage: {
    corpus: "case_law",
    country: { field: "country", optional: true },
  },
  read_case_law_decision: { corpus: "case_law", country: null },
  read_case_law_citations: { corpus: "case_law", country: null },
  search_legislation: {
    corpus: "legislation",
    country: { field: "country", optional: false },
  },
  read_statute: { corpus: "legislation", country: null },
  read_statute_provisions: { corpus: "legislation", country: null },
  read_provision_history: { corpus: "legislation", country: null },
} as const satisfies Record<CorpusReadToolName, CorpusReadTool>;

/**
 * Public-corpus sources outside the corpora a chip can name (Spain's BOE,
 * Czech court-proceedings lookups). A scoped turn asked for stella's own
 * corpus for the named countries, so these are out of scope for any chip.
 */
const OUT_OF_SCOPE_CORPUS_READ_TOOLS = new Set<RegistryReadToolName>([
  "search_boe_legislation",
]);

/** The direct (non-script) chat tools over public corpora a chip cannot name. */
export const OUT_OF_SCOPE_CORPUS_DIRECT_TOOLS: ReadonlySet<string> = new Set([
  "boe_search_legislation",
  "boe_get_law",
  "boe_get_law_structure",
  "boe_get_law_block",
  "boe_find_related_laws",
  "borme_get_summary",
  "infosoud_lookup_case",
]);

const isCorpusReadToolName = (name: string): name is CorpusReadToolName =>
  Object.hasOwn(CORPUS_READ_TOOLS, name);

const CORPUS_LABELS = {
  case_law: "case law",
  legislation: "legislation",
} as const satisfies Record<ChatCorpus, string>;

const describeScopes = (scopes: readonly ChatCorpusScope[]): string =>
  scopes
    .map(({ corpus, country }) => `${CORPUS_LABELS[corpus]} (${country})`)
    .join(", ");

const scopedCountries = (
  scopes: readonly ChatCorpusScope[],
  corpus: ChatCorpus,
): string[] => [
  ...new Set(
    scopes.filter((scope) => scope.corpus === corpus).map((s) => s.country),
  ),
];

const outOfScopeError = (scopes: readonly ChatCorpusScope[]): ChatToolError =>
  new ChatToolError({
    kind: "unavailable",
    message:
      `The user limited this turn to ${describeScopes(scopes)}; this tool ` +
      "reads another corpus and is not available until they remove the scope.",
  });

/** Drop the direct tools a scoped turn cannot use. Unscoped turns pass through. */
export const restrictChatToolsToCorpusScope = (
  tools: ChatToolMap,
  scopes: readonly ChatCorpusScope[],
): ChatToolMap =>
  scopes.length === 0
    ? tools
    : Object.fromEntries(
        Object.entries(tools).filter(
          ([name]) => !OUT_OF_SCOPE_CORPUS_DIRECT_TOOLS.has(name),
        ),
      );

/** Why a dropped direct tool is missing, for a script that tries to call it. */
export const corpusScopeUnavailableReason = (
  scopes: readonly ChatCorpusScope[],
): string => `the user limited this turn to ${describeScopes(scopes)}`;

type ScopeCorpusReadProps = {
  scopes: readonly ChatCorpusScope[];
  toolName: RegistryReadToolName;
  /** The read's arguments after boundary normalization (canonical alpha-3). */
  args: Record<string, unknown>;
};

/**
 * Hold one registry read to the turn's corpus scope: refuse a read of a
 * corpus no chip names, refuse a country outside the chips for its corpus
 * (naming the allowed ones, never rewriting the call), and fill an omitted
 * optional country when exactly one is scoped. It runs after boundary
 * normalization, so a required country is already present and every country
 * is in its canonical spelling.
 */
export const scopeCorpusRead = ({
  scopes,
  toolName,
  args,
}: ScopeCorpusReadProps): Result<Record<string, unknown>, ChatToolError> => {
  if (scopes.length === 0) {
    return Result.ok(args);
  }
  if (OUT_OF_SCOPE_CORPUS_READ_TOOLS.has(toolName)) {
    return Result.err(outOfScopeError(scopes));
  }
  if (!isCorpusReadToolName(toolName)) {
    return Result.ok(args);
  }
  const tool: CorpusReadTool = CORPUS_READ_TOOLS[toolName];
  const allowed = scopedCountries(scopes, tool.corpus);
  if (allowed.length === 0) {
    return Result.err(outOfScopeError(scopes));
  }
  if (tool.country === null) {
    return Result.ok(args);
  }

  const { field, optional } = tool.country;
  const country = args[field];
  const [only] = allowed;
  if (
    country === undefined &&
    optional &&
    only !== undefined &&
    allowed.length === 1
  ) {
    return Result.ok({ ...args, [field]: only });
  }
  // An omitted country with several scoped would read every jurisdiction, so
  // it is refused like a foreign one.
  if (typeof country === "string" && allowed.includes(country)) {
    return Result.ok(args);
  }
  return Result.err(
    toRegistryChatToolError({
      type: "structured",
      code: "validation_error",
      message: `The user limited ${CORPUS_LABELS[tool.corpus]} to ${allowed.join(", ")} for this turn.`,
      hint: `Set \`${field}\` to ${allowed.join(" or ")}.`,
      retryable: false,
    }),
  );
};
