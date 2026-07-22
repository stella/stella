import * as v from "valibot";

const identifierSchema = v.pipe(v.string(), v.uuid());
const timestampSchema = v.pipe(v.string(), v.isoTimestamp());
const chatThreadSchema = v.strictObject({
  createdAt: timestampSchema,
  id: identifierSchema,
  title: v.string(),
  updatedAt: timestampSchema,
});

const recentChatThreadsPageSchema = v.strictObject({
  global: v.array(chatThreadSchema),
  nextCursor: v.nullable(v.string()),
  workspaces: v.array(
    v.strictObject({
      threads: v.array(chatThreadSchema),
      workspaceId: identifierSchema,
      workspaceName: v.string(),
    }),
  ),
});

export type RecentChatThreadsPage = v.InferOutput<
  typeof recentChatThreadsPageSchema
>;

export type RecentChatThread =
  | {
      id: string;
      scope: "global";
      title: string;
      updatedAt: string;
    }
  | {
      id: string;
      scope: "workspace";
      title: string;
      updatedAt: string;
      workspaceId: string;
      workspaceName: string;
    };

export const parseRecentChatThreadsPage = (
  input: unknown,
): RecentChatThreadsPage => v.parse(recentChatThreadsPageSchema, input);

export const mergeRecentChatThreadPages = (
  pages: readonly RecentChatThreadsPage[] | undefined,
): RecentChatThread[] => {
  const threadsById = new Map<string, RecentChatThread>();

  for (const page of pages ?? []) {
    for (const thread of page.global) {
      if (!threadsById.has(thread.id)) {
        threadsById.set(thread.id, {
          id: thread.id,
          scope: "global",
          title: thread.title,
          updatedAt: thread.updatedAt,
        });
      }
    }

    for (const workspace of page.workspaces) {
      for (const thread of workspace.threads) {
        if (!threadsById.has(thread.id)) {
          threadsById.set(thread.id, {
            id: thread.id,
            scope: "workspace",
            title: thread.title,
            updatedAt: thread.updatedAt,
            workspaceId: workspace.workspaceId,
            workspaceName: workspace.workspaceName,
          });
        }
      }
    }
  }

  return Array.from(threadsById.values()).sort((left, right) => {
    const updatedAtOrder = right.updatedAt.localeCompare(left.updatedAt);
    return updatedAtOrder === 0
      ? right.id.localeCompare(left.id)
      : updatedAtOrder;
  });
};
