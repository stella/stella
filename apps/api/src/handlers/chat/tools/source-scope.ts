import { Result } from "better-result";

import type { BusinessRegistrySlug, ChatSourceScope } from "@stll/api-contract";

import { BUSINESS_REGISTRY_LOOKUP_TOOL_NAME } from "@/api/handlers/chat/tools/business-registry-tools";
import type { BusinessRegistryCallScope } from "@/api/handlers/chat/tools/business-registry-tools";
import { corpusScopeDroppedTools } from "@/api/handlers/chat/tools/corpus-scope";
import { COUNTERPARTY_CHECK_TOOL_NAME } from "@/api/handlers/chat/tools/counterparty-check-tools";
import { toRegistryChatToolError } from "@/api/handlers/chat/tools/registry-adapter/registry-tool-error";
import { describeSourceScopes } from "@/api/handlers/chat/tools/source-scope-description";
import type { RegistryJurisdictionCode } from "@/api/lib/business-registries/dispatch";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import type { ChatToolError } from "@/api/lib/errors/tagged-errors";

/**
 * Per-turn source scope. Source chips on the latest user message (a public
 * corpus, a business registry, an MCP connector) limit that turn to the
 * sources they name, across all three kinds: a turn with any chip reads no
 * source a chip does not name. Public corpora follow `corpus-scope.ts`; this
 * module adds registries and connectors and composes the three. It only ever
 * narrows. Tenant and workspace tools always stay, since the same message may
 * also mention a matter, and so do tools that read no outside source.
 */

/** A connector as discovery loaded it: its slug and the names chat exposes its tools under. */
export type ScopedExternalConnector = {
  slug: string;
  exposedToolNames: readonly string[];
};

/** A business registry the turn may read, with the jurisdiction it serves. */
export type ScopedRegistry = {
  slug: BusinessRegistrySlug;
  country: RegistryJurisdictionCode;
};

const namedRegistries = (
  scopes: readonly ChatSourceScope[],
): BusinessRegistrySlug[] =>
  scopes.flatMap((scope) =>
    scope.kind === "registry" ? [scope.registry] : [],
  );

const namedConnectors = (scopes: readonly ChatSourceScope[]): Set<string> =>
  new Set(
    scopes.flatMap((scope) =>
      scope.kind === "connector" ? [scope.connector] : [],
    ),
  );

/**
 * The registries a scoped turn may look up: the ones its chips name that the
 * organization has enabled, in chip order. Null on an unscoped turn, where the
 * lookup tool keeps every enabled registry.
 */
export const scopedRegistries = ({
  scopes,
  enabled,
}: {
  scopes: readonly ChatSourceScope[];
  enabled: readonly ScopedRegistry[];
}): ScopedRegistry[] | null =>
  scopes.length === 0
    ? null
    : namedRegistries(scopes).flatMap((slug) =>
        enabled.filter((registry) => registry.slug === slug),
      );

/**
 * The connectors a turn keeps: every loaded one on an unscoped turn, else only
 * those a chip names. Filters the connectors' system-prompt hint as well as
 * their tools, so the model is not told about a connector it cannot call.
 */
export const scopedExternalConnectors = <
  TConnector extends ScopedExternalConnector,
>(
  scopes: readonly ChatSourceScope[],
  connectors: readonly TConnector[],
): TConnector[] => {
  if (scopes.length === 0) {
    return [...connectors];
  }
  const named = namedConnectors(scopes);
  return connectors.filter((connector) => named.has(connector.slug));
};

type SourceScopeToolsInput = {
  scopes: readonly ChatSourceScope[];
  /** Every external MCP tool loaded for the turn, by its tool-map name. */
  externalToolNames: readonly string[];
  connectors: readonly ScopedExternalConnector[];
  /** `scopedRegistries`: the registries a scoped turn may look up. */
  registries: readonly ScopedRegistry[] | null;
};

/**
 * The tools a scoped turn drops. Empty for an unscoped turn.
 *
 * - Public sources outside the corpus chips (`corpusScopeDroppedTools`).
 * - `business_registry_lookup` when no named registry is enabled: the lookup
 *   itself is held to the named ones (`scopeBusinessRegistryLookup`).
 * - The counterparty check, under every chip, a registry chip included. It
 *   screens the subject against the insolvency and VAT registers and the
 *   sanctions lists, none of which a chip can name, and it takes no registry
 *   argument, so it cannot be held to the named sources. A screening is asked
 *   for without chips.
 * - Every external MCP tool that is not one of a named connector's tools.
 *   Tools are matched through each connector's own `exposedToolNames` (the
 *   names chat offers), never by reading a connector out of a tool's name.
 */
export const sourceScopeDroppedTools = ({
  scopes,
  externalToolNames,
  connectors,
  registries,
}: SourceScopeToolsInput): string[] => {
  if (scopes.length === 0) {
    return [];
  }
  const keptExternal = new Set(
    scopedExternalConnectors(scopes, connectors).flatMap(
      (connector) => connector.exposedToolNames,
    ),
  );
  return [
    ...corpusScopeDroppedTools(scopes),
    ...(registries === null || registries.length === 0
      ? [BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]
      : []),
    COUNTERPARTY_CHECK_TOOL_NAME,
    ...externalToolNames.filter((name) => !keptExternal.has(name)),
  ];
};

/** Drop the tools a scoped turn cannot use. Unscoped turns pass through. */
export const restrictChatToolsToSourceScope = (
  tools: ChatToolMap,
  input: SourceScopeToolsInput,
): ChatToolMap => {
  const dropped = new Set(sourceScopeDroppedTools(input));
  return dropped.size === 0
    ? tools
    : Object.fromEntries(
        Object.entries(tools).filter(([name]) => !dropped.has(name)),
      );
};

/** Why a dropped tool is missing, for a script that tries to call it. */
export const sourceScopeUnavailableReason = (
  scopes: readonly ChatSourceScope[],
): string => `the user limited this turn to ${describeSourceScopes(scopes)}`;

const registryRefusal = ({
  registries,
  message,
  hint,
}: {
  registries: readonly ScopedRegistry[];
  message: string;
  hint: string;
}): ChatToolError =>
  toRegistryChatToolError({
    type: "structured",
    code: "validation_error",
    message: `The user limited business registry lookups to ${describeRegistries(registries)} for this turn. ${message}`,
    hint,
    retryable: false,
  });

const describeRegistries = (registries: readonly ScopedRegistry[]): string =>
  registries.map(({ slug, country }) => `${slug} (${country})`).join(", ");

const callFor = ({ slug, country }: ScopedRegistry): string =>
  `jurisdiction ${country} with registry ${slug}`;

/**
 * Hold one `business_registry_lookup` call to the turn's named registries.
 * A named registry must serve the call's jurisdiction; with no registry
 * argument, the one named registry that serves it is pinned. A registry the
 * chips do not name, a jurisdiction none of them serves, or a choice between
 * several is refused with a hint naming the calls that are allowed, never
 * rewritten into another jurisdiction.
 */
export const scopeBusinessRegistryLookup = ({
  registries,
  jurisdiction,
  registry,
}: {
  registries: readonly ScopedRegistry[];
  jurisdiction: RegistryJurisdictionCode;
  registry: BusinessRegistrySlug | undefined;
}): Result<BusinessRegistrySlug, ChatToolError> => {
  const allowedCalls = `Call it with ${registries.map(callFor).join(", or ")}.`;
  if (registry !== undefined) {
    const named = registries.find(({ slug }) => slug === registry);
    if (named === undefined) {
      return Result.err(
        registryRefusal({
          registries,
          message: `Registry ${registry} is not one of them.`,
          hint: allowedCalls,
        }),
      );
    }
    return named.country === jurisdiction
      ? Result.ok(registry)
      : Result.err(
          registryRefusal({
            registries,
            message: `Registry ${registry} serves ${named.country}, not ${jurisdiction}.`,
            hint: `Call it with ${callFor(named)}.`,
          }),
        );
  }
  const serving = registries.filter(({ country }) => country === jurisdiction);
  const [only, ...others] = serving;
  if (only === undefined) {
    return Result.err(
      registryRefusal({
        registries,
        message: `None of them serves ${jurisdiction}.`,
        hint: allowedCalls,
      }),
    );
  }
  if (others.length > 0) {
    return Result.err(
      registryRefusal({
        registries,
        message: `Several of them serve ${jurisdiction}.`,
        hint: `Set registry to ${serving.map(({ slug }) => slug).join(" or ")}.`,
      }),
    );
  }
  return Result.ok(only.slug);
};

/** The lookup tool's per-call scope: none on an unscoped turn. */
export const businessRegistryCallScope = (
  registries: readonly ScopedRegistry[] | null,
): BusinessRegistryCallScope | undefined =>
  registries === null
    ? undefined
    : (call) => scopeBusinessRegistryLookup({ registries, ...call });
