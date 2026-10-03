import { flowRuns } from "@/api/db/schema";

declare const db: {
  update: (table: unknown) => {
    set: (values: unknown) => { where: (predicate: unknown) => unknown };
  };
};
declare const eq: (id: unknown) => unknown;
declare const id: unknown;

// oxlint-disable-next-line no-direct-status-set/no-direct-status-set -- fixture proves an unfenced lifecycle write reaches the guard
db.update(flowRuns).set({ status: "running" }).where(eq(id));
// expect-clean: no-direct-status-set/no-direct-status-set
db.update(flowRuns).set({ updatedAt: new Date() });
