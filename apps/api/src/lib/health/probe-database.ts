import { sql } from "drizzle-orm";

import { db } from "@/api/db/root";

export const probeDatabase = () => db.execute(sql`SELECT 1`);
