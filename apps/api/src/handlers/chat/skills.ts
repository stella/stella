import { listSkillMetadata } from "@stella/skills";
import type { SkillMetadata } from "@stella/skills";

let chatSkillMetadata: SkillMetadata[] | undefined;

export const getChatSkillMetadata = (): SkillMetadata[] => {
  chatSkillMetadata ??= listSkillMetadata();
  return chatSkillMetadata;
};
