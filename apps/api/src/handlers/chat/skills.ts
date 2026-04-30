import { listSkillMetadata } from "@stll/skills";
import type { SkillMetadata } from "@stll/skills";

let chatSkillMetadata: SkillMetadata[] | undefined;

export const getChatSkillMetadata = (): SkillMetadata[] => {
  chatSkillMetadata ??= listSkillMetadata();
  return chatSkillMetadata;
};
