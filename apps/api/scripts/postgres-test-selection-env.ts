import { decodePostgresTestSelection } from "../../../scripts/plan-output-codec";

/**
 * The CI plan's encoded Postgres selection as gated-test JSON. An empty or
 * absent value is no explicit selection, which runs every discovered suite.
 */
export const postgresTestSelectionFromEnv = (
  encoded: string | undefined,
): string | undefined =>
  encoded === undefined || encoded === ""
    ? undefined
    : JSON.stringify(decodePostgresTestSelection(encoded));
