import { panic } from "better-result";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import {
  entityFeatureGateMetadata,
  entityFeatureGatePropagationSql,
} from "../src/db/entity-feature-gate-metadata";
import * as schema from "../src/db/schema";

const path = new URL(
  "../drizzle/20261009112500_entity_feature_row_gates/migration.sql",
  import.meta.url,
);
const migration = await Bun.file(path).text();
const definition =
  /CREATE OR REPLACE FUNCTION public\.entity_feature_gate_propagate\(\)[\s\S]+?\$function\$;/u;
if (!definition.test(migration)) {
  panic("Entity feature gate migration has no propagation routine");
}
const tables = Object.values(schema).filter((table) => is(table, PgTable));
const generated = entityFeatureGatePropagationSql(
  entityFeatureGateMetadata(tables),
);
await Bun.write(
  path,
  migration.replace(definition, () => generated),
);
