import {
  p,
  pUuid,
  user,
  userPolicies,
  timestamptz,
} from "./common";
import { jsonb } from "@/api/db/columns";

export const NOTIFICATION_ENTITY_TYPES = [
  "entity",
  "flow_run",
  "report_export",
  "announcement",
] as const;

export const notifications = p.pgTable(
  "notifications",
  {
    id: pUuid<"notification">().primaryKey(),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: p.text("kind").notNull(),
    metadata: jsonb("metadata").$type<Record<string, string | number | boolean | null>>(),
    isRead: p.boolean("is_read").notNull().default(false),
    readAt: timestamptz("read_at"),
    entityType: p.text("entity_type", { enum: NOTIFICATION_ENTITY_TYPES }),
    entityId: p.text("entity_id"),
    idempotencyKey: p.text("idempotency_key"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p.uniqueIndex("notifications_user_id_idempotency_key_uidx").on(table.userId, table.idempotencyKey),
    p.index("notifications_user_id_created_at_idx").on(table.userId, table.createdAt.desc()),
    p.index("notifications_user_id_is_read_idx").on(table.userId, table.isRead),
    ...userPolicies(),
  ],
);
