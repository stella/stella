import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import {
  entityFeatureGateGraphSql,
  entityFeatureGateMetadata,
  entityFeatureGatePropagationSql,
} from "../src/db/entity-feature-gate-metadata";
import { readEffectiveEntityFeatureGateDefinitions } from "../src/db/entity-feature-gate-migrations";
import * as schema from "../src/db/schema";

const tables = Object.values(schema).filter((table) => is(table, PgTable));
const descriptors = entityFeatureGateMetadata(tables);
const effective = await readEffectiveEntityFeatureGateDefinitions();
const definitions = [
  ["entity_feature_gate_graph", entityFeatureGateGraphSql(descriptors)],
  [
    "entity_feature_gate_propagate",
    entityFeatureGatePropagationSql(descriptors),
  ],
] as const;
const changed = definitions.flatMap(([name, sql]) =>
  effective.functions.get(name) === sql ? [] : [sql],
);

if (changed.length > 0) {
  const drizzle = new URL("../drizzle/", import.meta.url);
  const newest = (
    await Array.fromAsync(
      new Bun.Glob("*/migration.sql").scan({ cwd: drizzle.pathname }),
    )
  )
    .map((path) => path.split("/").at(0) ?? "")
    .toSorted()
    .at(-1);
  const stamp = String(
    Number.parseInt(newest?.slice(0, 14) ?? "0", 10) + 1,
  ).padStart(14, "0");
  const folder = new URL(`${stamp}_entity_feature_gate_registry/`, drizzle);
  await Bun.write(
    new URL("migration.sql", folder),
    `SET lock_timeout = '2s';\nSET statement_timeout = '5min';\n--> statement-breakpoint\n${changed.join("\n--> statement-breakpoint\n")}\n`,
  );
  console.log(folder.pathname);
}
