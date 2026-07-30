import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

export const chatPreviewPassageScopeSql = (): SQL =>
  sql`passage.thread_id = cst.thread_id`;

export const contactPreviewPassageScopeSql = (): SQL =>
  sql`passage.contact_id = csd.contact_id`;

export const documentPreviewPassageScopeSql = (): SQL =>
  sql`passage.entity_id = sd.entity_id`;

export const workspacePreviewPassageScopeSql = (): SQL =>
  sql`passage.workspace_id = wsd.workspace_id`;
