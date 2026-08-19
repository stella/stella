import {
  p,
  pUuid,
  user,
  userPolicies,
  timestamptz,
} from "./common";

export const notifications = p.pgTable(
  "notifications",
  {
    id: pUuid<"notification">().primaryKey(),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: p.text("title").notNull(),
    message: p.text("message").notNull(),
    isRead: p.boolean("is_read").notNull().default(false),
    readAt: timestamptz("read_at"),
    entityType: p.text("entity_type"), // Optional type, e.g. "matter", "document", etc.
    entityId: p.text("entity_id"),     // Optional ID
    idempotencyKey: p.text("idempotency_key").unique(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p.index("notifications_user_id_idx").on(table.userId),
    p.index("notifications_user_id_created_at_idx").on(table.userId, table.createdAt.desc()),
    p.index("notifications_user_id_is_read_idx").on(table.userId, table.isRead),
    ...userPolicies(),
  ],
);
