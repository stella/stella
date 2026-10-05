import { createPublicSanctionsReader } from "@/api/db/root";

/** Anonymous screening receives only the column-restricted, read-only handle. */
export const sanctionsPublicReadDb = createPublicSanctionsReader();
