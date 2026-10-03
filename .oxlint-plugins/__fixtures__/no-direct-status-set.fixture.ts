import { sql } from "drizzle-orm";

import { agentRegistration } from "@/api/db/agent-auth-schema";
import { flowRuns } from "@/api/db/schema";

declare const db: {
  update: (table: unknown) => {
    set: (values: unknown) => { where: (predicate: unknown) => unknown };
  };
  insert: (table: unknown) => {
    values: (row: unknown) => {
      onConflictDoUpdate: (options: unknown) => unknown;
    };
  };
  execute: (query: unknown) => unknown;
};
declare const eq: (id: unknown) => unknown;
declare const id: unknown;

// oxlint-disable-next-line no-direct-status-set/no-direct-status-set -- fixture proves an unfenced lifecycle write reaches the guard
db.update(flowRuns).set({ status: "running" }).where(eq(id));
// expect-clean: no-direct-status-set/no-direct-status-set
db.update(flowRuns).set({ updatedAt: new Date() });

// oxlint-disable-next-line no-direct-status-set/no-direct-status-set -- fixture proves agent-auth tables are inventoried too
db.update(agentRegistration).set({ status: "active" });
// oxlint-disable-next-line no-direct-status-set/no-direct-status-set -- fixture proves conflict updates cannot write lifecycle state
db.insert(flowRuns)
  .values({})
  .onConflictDoUpdate({ target: flowRuns.id, set: { status: "running" } });
// oxlint-disable-next-line no-direct-status-set/no-direct-status-set -- fixture proves raw SQL reaches the shared text backstop
db.execute(sql`UPDATE flow_runs SET status = 'running' WHERE id = ${id}`);
const changes = {};
Object.assign(changes, { status: "failed" });
// oxlint-disable-next-line no-direct-status-set/no-direct-status-set -- fixture proves mutated payloads cannot hide lifecycle keys
db.update(flowRuns).set(changes);
