import { afterAll } from "bun:test";

import { assertStatementCeilingsSatisfied } from "../lib/db/statement-ceiling";

// Assert retained violations even when a transport converted them to a response.
afterAll(assertStatementCeilingsSatisfied);
