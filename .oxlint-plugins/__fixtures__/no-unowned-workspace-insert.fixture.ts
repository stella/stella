import { workspaces } from "@/api/db/schema";

declare const tx: {
  insert: (table: unknown) => { values: (rows: unknown) => void };
};

// oxlint-disable-next-line no-unowned-workspace-insert/no-unowned-workspace-insert -- fixture: private matter creation requires its owner
tx.insert(workspaces).values({ visibility: "assigned_only" });

// expect-clean: no-unowned-workspace-insert/no-unowned-workspace-insert
tx.insert(workspaces).values({ visibility: "admins_and_assigned" });
