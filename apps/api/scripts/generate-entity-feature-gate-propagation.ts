import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import {
  entityFeatureGateMetadata,
  entityFeatureGatePropagationSql,
} from "../src/db/entity-feature-gate-metadata";
import * as schema from "../src/db/schema";

const tables = Object.values(schema).filter((table) => is(table, PgTable));
const generated = entityFeatureGatePropagationSql(
  entityFeatureGateMetadata(tables),
);
// Print for a new migration; merged migration files are immutable.
process.stdout.write(`${generated}\n`);
