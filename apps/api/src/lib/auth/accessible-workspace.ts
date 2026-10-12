import type { InferSelectModel } from "drizzle-orm";

import type { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type AccessibleWorkspace = {
  id: SafeId<"workspace">;
  status: InferSelectModel<typeof workspaces>["status"];
};
