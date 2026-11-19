import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { invoices } from "@/api/db/schema";

/** Capture ordered invoice rows and their prior state inside the transition's update statement. */
export const lockedInvoiceTransitionSource = (predicate: SQL) => sql`
  SELECT ${invoices.id} AS source_id, ${invoices.status} AS previous_status
  FROM ${invoices}
  WHERE ${predicate}
  ORDER BY ${invoices.id}
  FOR UPDATE
`;
