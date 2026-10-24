import { afterAll } from "bun:test";

import {
  assertStatementCeilingsSatisfied,
  enableTemporaryResetCensusForTesting,
} from "../lib/db/statement-ceiling";

// Temporary initial census; the finalizer still fails with its exact maximum.
const { CI: ci } = process.env;
if (ci === "true") {
  enableTemporaryResetCensusForTesting();
}

// Assert retained violations even when a transport converted them to a response.
afterAll(assertStatementCeilingsSatisfied);
