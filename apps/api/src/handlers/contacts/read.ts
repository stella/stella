import { and, count, eq, gt, ilike, or } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { contacts, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { escapeLike } from "@/api/lib/escape-like";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type ReadContactsHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  limit?: number | undefined;
  cursor?: string | undefined;
  type?: "person" | "organization" | undefined;
  q?: string | undefined;
};

type DecodedCursor = {
  displayName: string;
  id: string;
};

const decodeCursor = (cursor: string): DecodedCursor | null => {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const [displayName, id] = decoded.split("\0");
    if (!displayName || !id) {
      return null;
    }
    return { displayName, id };
  } catch {
    return null;
  }
};

const encodeCursor = (displayName: string, id: string): string =>
  Buffer.from(`${displayName}\0${id}`, "utf8").toString("base64");

export const readContactsHandler = async ({
  scopedDb,
  organizationId,
  limit: rawLimit,
  cursor,
  type,
  q,
}: ReadContactsHandlerProps) => {
  const limit = Math.min(rawLimit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const conditions = [eq(contacts.organizationId, organizationId)];

  if (type) {
    conditions.push(eq(contacts.type, type));
  }

  if (q) {
    conditions.push(ilike(contacts.displayName, `%${escapeLike(q)}%`));
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      const cursorCondition = or(
        gt(contacts.displayName, decoded.displayName),
        and(
          eq(contacts.displayName, decoded.displayName),
          gt(contacts.id, decoded.id),
        ),
      );
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }
  }

  const items = await scopedDb((tx) =>
    tx
      .select({
        id: contacts.id,
        type: contacts.type,
        displayName: contacts.displayName,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        organizationName: contacts.organizationName,
        emails: contacts.emails,
        phones: contacts.phones,
        tags: contacts.tags,
        color: contacts.color,
        createdAt: contacts.createdAt,
        matterCount: count(workspaces.id),
      })
      .from(contacts)
      .leftJoin(
        workspaces,
        and(
          eq(workspaces.clientId, contacts.id),
          eq(workspaces.status, "active"),
        ),
      )
      .where(and(...conditions))
      .groupBy(contacts.id)
      .orderBy(contacts.displayName, contacts.id)
      .limit(limit + 1),
  );

  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const lastItem = page.at(-1);
  const nextCursor =
    hasMore && lastItem
      ? encodeCursor(lastItem.displayName, lastItem.id)
      : null;

  return { items: page, nextCursor };
};
