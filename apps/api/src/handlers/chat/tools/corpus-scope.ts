import { Result } from "better-result";

import type { ChatCorpus, ChatSourceScope } from "@stll/api-contract";

import type { RegistryReadToolName } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { toRegistryChatToolError } from "@/api/handlers/chat/tools/registry-adapter/registry-tool-error";
import {
  CORPUS_LABELS,
  describeSourceScopes,
} from "@/api/handlers/chat/tools/source-scope-description";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Per-turn corpus scope. A corpus chip in the latest user message
 * ("@Case law · Czechia") pins that turn's public-corpus reads to the corpora
 * and countries the chips name. A turn whose chips name only registries or
 * connectors names no corpus, so it reads none. The server enforces it here
 * rather than in the prompt, and it only ever narrows: tenant and workspace
 * tools are left alone, since the same message may also mention a matter.
 */

/**
 * Where a read's country comes from: its own country argument, or, for a read
 * keyed by decision ids or statute ELIs, the resources it names. A keyed read
 * can follow an id from an earlier, unscoped turn, so the resource's stored
 * country is checked, never the model's word for it.
 */
type CorpusReadCountry =
  | { type: "argument"; field: string; optional: boolean }
  | { type: "decision"; keys: (args: Record<string, unknown>) => unknown[] }
  | { type: "statute"; keys: (args: Record<string, unknown>) => unknown[] };

type CorpusReadTool = {
  corpus: ChatCorpus;
  country: CorpusReadCountry;
};

/**
 * Looks up the stored country of the public resources a keyed read names.
 * An id missing from the answer is unknown and the read is refused.
 */
export type CorpusResourceCountryResolver = {
  decisions: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  statutes: (elis: readonly string[]) => Promise<ReadonlyMap<string, string>>;
};

/** One field's value as a list: a single key, or a batch of them. */
const keysAt = (args: Record<string, unknown>, field: string): unknown[] => {
  const value = args[field];
  return Array.isArray(value) ? value : [value];
};

/** The ELI of every entry of a provision batch. */
const batchElis = (args: Record<string, unknown>): unknown[] => {
  const items = args["items"];
  return Array.isArray(items)
    ? items.map((item: unknown) => (isRecord(item) ? item["eli"] : undefined))
    : [undefined];
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
    country: { type: "argument", field: "country", optional: false },
  },
  case_law_coverage: {
    corpus: "case_law",
    country: { type: "argument", field: "country", optional: true },
  },
  read_case_law_decision: {
    corpus: "case_law",
    country: { type: "decision", keys: (args) => keysAt(args, "decision_ids") },
  },
  read_case_law_citations: {
    corpus: "case_law",
    country: { type: "decision", keys: (args) => keysAt(args, "decision_id") },
  },
  search_legislation: {
    corpus: "legislation",
    country: { type: "argument", field: "country", optional: false },
  },
  read_statute: {
    corpus: "legislation",
    country: { type: "statute", keys: (args) => keysAt(args, "eli") },
  },
  read_statute_provisions: {
    corpus: "legislation",
    country: { type: "statute", keys: batchElis },
  },
  read_provision_history: {
    corpus: "legislation",
    country: { type: "statute", keys: (args) => keysAt(args, "eli") },
  },
} as const satisfies Record<CorpusReadToolName, CorpusReadTool>;

/**
 * Other public sources (direct tools and script reads alike), each with the
 * corpus and jurisdiction it reads. A scoped turn keeps one only when a chip
 * names that corpus for that country: InfoSoud stays beside a Czech case-law
 * chip, and Spain's BOE and BORME go under any chip, since none names Spain.
 */
export const PUBLIC_SOURCE_JURISDICTIONS = {
  boe_search_legislation: { corpus: "legislation", country: "ESP" },
  boe_get_law: { corpus: "legislation", country: "ESP" },
  boe_get_law_structure: { corpus: "legislation", country: "ESP" },
  boe_get_law_block: { corpus: "legislation", country: "ESP" },
  boe_find_related_laws: { corpus: "legislation", country: "ESP" },
  borme_get_summary: { corpus: "legislation", country: "ESP" },
  search_boe_legislation: { corpus: "legislation", country: "ESP" },
  infosoud_lookup_case: { corpus: "case_law", country: "CZE" },
} as const satisfies Record<string, { corpus: ChatCorpus; country: string }>;

const isPublicSourceName = (
  name: string,
): name is keyof typeof PUBLIC_SOURCE_JURISDICTIONS =>
  Object.hasOwn(PUBLIC_SOURCE_JURISDICTIONS, name);

/** Whether a scoped turn keeps this public source. */
const scopeAdmitsPublicSource = (
  scopes: readonly ChatSourceScope[],
  name: keyof typeof PUBLIC_SOURCE_JURISDICTIONS,
): boolean => {
  const source: { corpus: ChatCorpus; country: string } =
    PUBLIC_SOURCE_JURISDICTIONS[name];
  return scopes.some(
    (scope) =>
      scope.kind === "corpus" &&
      scope.corpus === source.corpus &&
      scope.country === source.country,
  );
};

/** The public sources a scoped turn drops. Empty for an unscoped turn. */
export const corpusScopeDroppedTools = (
  scopes: readonly ChatSourceScope[],
): string[] =>
  scopes.length === 0
    ? []
    : Object.keys(PUBLIC_SOURCE_JURISDICTIONS).filter(
        (name) =>
          isPublicSourceName(name) && !scopeAdmitsPublicSource(scopes, name),
      );

const isCorpusReadToolName = (name: string): name is CorpusReadToolName =>
  Object.hasOwn(CORPUS_READ_TOOLS, name);

const scopedCountries = (
  scopes: readonly ChatSourceScope[],
  corpus: ChatCorpus,
): string[] => [
  ...new Set(
    scopes.flatMap((scope) =>
      scope.kind === "corpus" && scope.corpus === corpus ? [scope.country] : [],
    ),
  ),
];

const outOfScopeError = (scopes: readonly ChatSourceScope[]): ChatToolError =>
  new ChatToolError({
    kind: "unavailable",
    message:
      `The user limited this turn to ${describeSourceScopes(scopes)}; this tool ` +
      "reads another source and is not available until they remove the scope.",
  });

type ScopeCorpusReadProps = {
  scopes: readonly ChatSourceScope[];
  toolName: RegistryReadToolName;
  /** The read's arguments after boundary normalization (canonical alpha-3). */
  args: Record<string, unknown>;
  resolveCountries: CorpusResourceCountryResolver;
};

type ScopedRead = Result<Record<string, unknown>, ChatToolError>;

const foreignCountryError = ({
  corpus,
  allowed,
  hint,
}: {
  corpus: ChatCorpus;
  allowed: readonly string[];
  hint: string;
}): ChatToolError =>
  toRegistryChatToolError({
    type: "structured",
    code: "validation_error",
    message: `The user limited ${CORPUS_LABELS[corpus]} to ${allowed.join(", ")} for this turn.`,
    hint,
    retryable: false,
  });

const SEARCH_TOOL = {
  case_law: "search_case_law",
  legislation: "search_legislation",
} as const satisfies Record<ChatCorpus, string>;

/**
 * Hold a keyed read to the scope by the stored country of every resource it
 * names. An id the store does not know is refused too: nothing shows its
 * country is in scope.
 */
const scopeKeyedRead = async ({
  args,
  allowed,
  corpus,
  keys,
  resolve,
}: {
  args: Record<string, unknown>;
  allowed: readonly string[];
  corpus: ChatCorpus;
  keys: readonly unknown[];
  resolve: (keys: readonly string[]) => Promise<ReadonlyMap<string, string>>;
}): Promise<ScopedRead> => {
  const searchInScope = `Find it with ${SEARCH_TOOL[corpus]} in ${allowed.join(" or ")} first.`;
  const ids = keys.filter((key): key is string => typeof key === "string");
  if (ids.length === 0 || ids.length !== keys.length) {
    return Result.err(
      foreignCountryError({ corpus, allowed, hint: searchInScope }),
    );
  }
  // The lookup reads the public database. A failed read is the tool's error,
  // never a rejection: code-mode reads handle only returned results.
  const resolved = await Result.tryPromise(
    async () => await resolve([...new Set(ids)]),
  );
  if (Result.isError(resolved)) {
    return Result.err(
      new ChatToolError({
        kind: "transient",
        message: "The scope of this read could not be checked. Try again.",
        cause: resolved.error,
      }),
    );
  }
  const countries = resolved.value;
  for (const id of ids) {
    const country = countries.get(id);
    if (country === undefined) {
      return Result.err(
        foreignCountryError({ corpus, allowed, hint: searchInScope }),
      );
    }
    if (!allowed.includes(country)) {
      return Result.err(
        foreignCountryError({
          corpus,
          allowed,
          hint: `${id} is from ${country}; this turn reads only ${allowed.join(" or ")}. ${searchInScope}`,
        }),
      );
    }
  }
  return Result.ok(args);
};

/**
 * Hold one registry read to the turn's corpus scope: refuse a read of a
 * corpus no chip names, refuse a country outside the chips for its corpus
 * (naming the allowed ones, never rewriting the call), and fill an omitted
 * optional country when exactly one is scoped. A read keyed by decision ids
 * or ELIs is held to the stored country of what it names. It runs after
 * boundary normalization, so ids are dehydrated, a required country is
 * present and every country is in its canonical spelling.
 */
export const scopeCorpusRead = async ({
  scopes,
  toolName,
  args,
  resolveCountries,
}: ScopeCorpusReadProps): Promise<ScopedRead> => {
  if (scopes.length === 0) {
    return Result.ok(args);
  }
  if (isPublicSourceName(toolName)) {
    return scopeAdmitsPublicSource(scopes, toolName)
      ? Result.ok(args)
      : Result.err(outOfScopeError(scopes));
  }
  if (!isCorpusReadToolName(toolName)) {
    return Result.ok(args);
  }
  const tool: CorpusReadTool = CORPUS_READ_TOOLS[toolName];
  const allowed = scopedCountries(scopes, tool.corpus);
  if (allowed.length === 0) {
    return Result.err(outOfScopeError(scopes));
  }
  if (tool.country.type !== "argument") {
    return await scopeKeyedRead({
      args,
      allowed,
      corpus: tool.corpus,
      keys: tool.country.keys(args),
      resolve:
        tool.country.type === "decision"
          ? resolveCountries.decisions
          : resolveCountries.statutes,
    });
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
    foreignCountryError({
      corpus: tool.corpus,
      allowed,
      hint: `Set \`${field}\` to ${allowed.join(" or ")}.`,
    }),
  );
};
