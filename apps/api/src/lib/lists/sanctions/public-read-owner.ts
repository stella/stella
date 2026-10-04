import { rlsDb } from "@/api/db/root";
import { createSanctionsPublicReadDb } from "@/api/lib/lists/sanctions/read-db";

/** Anonymous screening receives only the column-restricted, read-only handle. */
export const sanctionsPublicReadDb = createSanctionsPublicReadDb(rlsDb);
