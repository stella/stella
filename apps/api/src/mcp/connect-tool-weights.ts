/**
 * Connect-time weight of the MCP tool list: what a client loads into its
 * context when it connects. One estimator shared by the committed weight table
 * (apps/api/scripts/export-mcp-tool-registry.ts) and the budget test.
 */
export const CONNECT_WEIGHT_ESTIMATOR = {
  proseCharactersPerToken: 3,
  jsonCharactersPerToken: 2.4,
  note: "Estimate = ceil((name + description chars) / 3 + input-schema JSON chars / 2.4). Character counts use JavaScript string length.",
} as const;

type ConnectTool = {
  name: string;
  description: string;
  inputSchema: unknown;
};

export type ConnectToolWeight = {
  name: string;
  nameChars: number;
  descriptionChars: number;
  inputSchemaChars: number;
  totalChars: number;
  estimatedTokens: number;
};

export const measureConnectTool = ({
  name,
  description,
  inputSchema,
}: ConnectTool): ConnectToolWeight => {
  const nameChars = name.length;
  const descriptionChars = description.length;
  const inputSchemaChars = JSON.stringify(inputSchema).length;
  return {
    name,
    nameChars,
    descriptionChars,
    inputSchemaChars,
    totalChars: nameChars + descriptionChars + inputSchemaChars,
    estimatedTokens: Math.ceil(
      (nameChars + descriptionChars) /
        CONNECT_WEIGHT_ESTIMATOR.proseCharactersPerToken +
        inputSchemaChars / CONNECT_WEIGHT_ESTIMATOR.jsonCharactersPerToken,
    ),
  };
};

const byName = (left: ConnectToolWeight, right: ConnectToolWeight): number => {
  if (left.name === right.name) {
    return 0;
  }
  return left.name < right.name ? -1 : 1;
};

/** The committed weight table: per-tool weights sorted by name, plus totals. */
export const connectToolWeights = (tools: readonly ConnectTool[]) => {
  const weights = tools.map(measureConnectTool).toSorted(byName);
  return {
    estimator: CONNECT_WEIGHT_ESTIMATOR,
    tools: weights,
    totals: {
      characters: weights.reduce((total, tool) => total + tool.totalChars, 0),
      estimatedTokens: weights.reduce(
        (total, tool) => total + tool.estimatedTokens,
        0,
      ),
    },
  };
};
