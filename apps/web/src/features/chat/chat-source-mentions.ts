import {
  isBusinessRegistrySlug,
  isChatConnectorSlug,
} from "@stll/api-contract";
import type { ChatCorpusScope } from "@stll/api-contract";
import type { PublicCountry } from "@stll/api-contract/public-country-capability";

import type { ChatMentionOption } from "@/components/chat-mention-extension";

type NativeToolRow = { slug: string; displayName: string; enabled: boolean };

type ConnectorRow = { id: string; displayName: string };

type ConnectionRow = {
  connectorId: string;
  connectorSlug: string;
  enabled: boolean;
  status: string;
};

type SourceMentionInputs = {
  /** Public case-law countries, in picker order. */
  caseLawCountries: readonly PublicCountry[];
  /** Public legislation countries, in picker order. */
  legislationCountries: readonly PublicCountry[];
  /** "Case law · Czechia": the chip text a corpus scope reads as. */
  corpusLabel: (scope: ChatCorpusScope) => string;
  /**
   * The organization's connector catalog (`mcpConnectorsOptions()`): its
   * native tools and the connectors it lists, for their names. Null when the
   * catalog could not be read, which offers no registry or connector chips.
   */
  catalog: {
    nativeTools: readonly NativeToolRow[];
    connectors: readonly ConnectorRow[];
  } | null;
  /** The user's connections (`mcpConnectionsOptions().connections`). */
  connections: readonly ConnectionRow[];
};

/**
 * The connection states chat loads tools from: switched on and connected
 * (the server's `loadActiveMcpConnectionsForUser`). Any other connection has
 * no tools to scope a turn to.
 */
const isActiveConnection = (connection: ConnectionRow): boolean =>
  connection.enabled && connection.status === "connected";

/** Each public corpus by country, as the chip that scopes a turn to it. */
const corpusMentions = (
  caseLawCountries: readonly PublicCountry[],
  legislationCountries: readonly PublicCountry[],
  corpusLabel: (scope: ChatCorpusScope) => string,
): ChatMentionOption[] =>
  [
    ...caseLawCountries.map((country): ChatCorpusScope => ({
      corpus: "case_law",
      country,
    })),
    ...legislationCountries.map((country): ChatCorpusScope => ({
      corpus: "legislation",
      country,
    })),
  ].map((scope): ChatMentionOption => ({
    category: "corpus",
    kind: "corpus",
    label: corpusLabel(scope),
    mimeType: null,
    scope,
  }));

/**
 * The static Sources the picker offers as chips: each public corpus by
 * country, the organization's enabled business registries, and the user's
 * active MCP connectors. A chip scopes the turn to the sources it names.
 */
export const buildSourceMentionOptions = ({
  caseLawCountries,
  legislationCountries,
  corpusLabel,
  catalog,
  connections,
}: SourceMentionInputs): ChatMentionOption[] => {
  if (catalog === null) {
    return corpusMentions(caseLawCountries, legislationCountries, corpusLabel);
  }
  const { nativeTools, connectors } = catalog;
  const connectorNames = new Map(
    connectors.map((connector) => [connector.id, connector.displayName]),
  );
  return [
    ...corpusMentions(caseLawCountries, legislationCountries, corpusLabel),
    ...nativeTools.flatMap((tool): ChatMentionOption[] =>
      tool.enabled && isBusinessRegistrySlug(tool.slug)
        ? [
            {
              category: "registry",
              kind: "registry",
              label: tool.displayName,
              mimeType: null,
              registry: tool.slug,
            },
          ]
        : [],
    ),
    ...connections.flatMap((connection): ChatMentionOption[] => {
      const name = connectorNames.get(connection.connectorId);
      return isActiveConnection(connection) &&
        name !== undefined &&
        isChatConnectorSlug(connection.connectorSlug)
        ? [
            {
              category: "connector",
              kind: "connector",
              label: name,
              mimeType: null,
              connector: connection.connectorSlug,
            },
          ]
        : [];
    }),
  ];
};
