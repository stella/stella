import type { MentionContext } from "@/components/mentionable-prompt-input";

/** Mention context for global (non-workspace) chat surfaces.
 *  Provides workspace + contact + template + clause mentions. */
export const GLOBAL_MENTION_CONTEXT: MentionContext = {
  categories: ["workspace", "contact", "template", "clause"],
};

/** Build a mention context for workspace-scoped chat.
 *  Entity mentions from the current workspace are the
 *  primary category; other matters can be cross-referenced. */
export const workspaceMentionContext = (
  workspaceId: string,
): MentionContext => ({
  workspaceId,
  categories: ["workspace"],
});
