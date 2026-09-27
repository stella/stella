import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";
import type {
  ChatOracleId,
  OracleViolation,
} from "@/api/tests/helpers/chat-oracles";

const { providerWireFinish: finish, providerWireUsage: usage } = CHAT_ORACLE;

/** Why an unmet run is on the ledger: `upstream design` where the adapter
 *  behaves as its maintainers chose (we follow upstream, and our boundary
 *  cannot tell), `upstream gap` where upstream drops what we need. */
type UnmetEntry = { oracles: readonly ChatOracleId[]; reason: string };

/**
 * Runs that do not meet the wire contract yet, with the oracles they fail
 * at. The ledger only shrinks: each entry must still fail at exactly its
 * oracles, an entry whose run now meets the contract fails until it is
 * removed, and its size is pinned to UNMET_SIZE, which only goes down. The
 * recorder keeps a recording whose run fails at exactly its entry's oracles.
 */
export const UNMET: Readonly<Record<string, UnmetEntry>> = {
  "anthropic/length": { oracles: [usage], reason: "upstream gap" },
  "anthropic/refusal": { oracles: [finish], reason: "upstream design" },
  "bedrock/early-eof": { oracles: [finish], reason: "upstream design" },
  "mistral/early-eof": { oracles: [finish], reason: "upstream design" },
  "mistral/malformed-chunk": { oracles: [finish], reason: "upstream design" },
  "openai/length": { oracles: [usage], reason: "upstream gap" },
  "openrouter/early-eof": { oracles: [finish], reason: "upstream design" },
};

/** The ledger's size. Lower it with every entry removed; never raise it. */
export const UNMET_SIZE = 7;

/** The distinct oracles `violations` fail at, sorted. */
export const violatedOracles = (
  violations: readonly OracleViolation[],
): ChatOracleId[] =>
  [...new Set(violations.map(({ oracle }) => oracle))].toSorted();

/** Whether `violations` are exactly the ledger's entry for `key`. */
export const matchesUnmetEntry = (
  key: string,
  violations: readonly OracleViolation[],
): boolean => {
  const entry = UNMET[key];
  return (
    entry !== undefined &&
    violations.length > 0 &&
    JSON.stringify(violatedOracles(violations)) ===
      JSON.stringify(entry.oracles.toSorted())
  );
};
