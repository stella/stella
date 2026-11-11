import { windowBoundText } from "@/api/lib/bound-text-window";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

/**
 * Characters of one skill resource a read returns. A resource may be stored
 * far larger (`LIMITS.agentSkillResourceMaxChars`); a model reads it a window
 * at a time, never more of it at once than it may hold.
 */
export const SKILL_RESOURCE_WINDOW_CHARS =
  LIMITS.agentSkillResourceModelContextMaxChars;

export type SkillResourceWindow =
  | { type: "invalid-cursor" }
  | {
      type: "window";
      /** This window's text; whole code points only. */
      content: string;
      /** Length of the whole resource in UTF-16 code units. */
      charCount: number;
      /** Pass back as `cursor` for the next window; null at the end. */
      nextCursor: string | null;
    };

/**
 * One window of a skill resource. The cursor is bound to the skill, the path
 * and the resource's whole text, so it is refused for another resource and
 * once the resource changes, instead of stitching two versions together.
 */
export const windowSkillResource = ({
  content,
  cursor,
  path,
  skillId,
  skillName,
}: {
  content: string;
  cursor: string | undefined;
  path: string;
  /** Stored skill id; null for a skill shipped with stella. */
  skillId: SafeId<"agentSkill"> | null;
  skillName: string;
}): SkillResourceWindow => {
  const window = windowBoundText({
    cursor,
    limit: SKILL_RESOURCE_WINDOW_CHARS,
    // A stored id never contains ":", so a shipped slug cannot pose as one.
    subject: JSON.stringify([
      "skill-resource",
      skillId ?? `built-in:${skillName}`,
      path,
    ]),
    text: content,
  });
  if (window.type === "invalid-cursor") {
    return window;
  }
  return {
    type: "window",
    content: window.text,
    charCount: content.length,
    nextCursor: window.nextTextCursor,
  };
};
