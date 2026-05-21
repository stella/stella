import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";

export const probeDatabase = () => rootDb.execute(sql`SELECT 1`);
