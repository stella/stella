import { panic } from "better-result";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  SKILL_DRAFT_NAME_KINDS,
  type SkillDraftNameKind,
} from "@stll/api-contract";
import { normalizeUnicode } from "@stll/text-normalize";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  createChatThirdPartyBoundary,
  prepareTextForThirdParty,
} from "@/api/handlers/chat/third-party-boundary";
import type { SafeId } from "@/api/lib/branded-types";

/** One name a skill draft holds, as it is written there. */
export type SkillDraftName = { kind: SkillDraftNameKind; value: string };

// The anonymizer writes a placeholder per entity, `[PERSON_1]`: its label
// upper-cased, then a number.
const kindOfPlaceholder = (placeholder: string): SkillDraftNameKind | null =>
  SKILL_DRAFT_NAME_KINDS.find((kind) =>
    placeholder.startsWith(`[${kind.toUpperCase()}_`),
  ) ?? null;

const nameKey = (value: string): string =>
  normalizeUnicode(value, "NFKC").trim().toLocaleLowerCase();

/**
 * The names of people and organizations a skill draft holds, found by the
 * organization's own anonymizer and catalogs. Each distinct name once, in the
 * order the anonymizer met them.
 */
export const findSkillDraftNames = async ({
  organizationId,
  scopedDb,
  texts,
  workspaceId,
}: {
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  texts: readonly string[];
  /** The matter whose catalog terms count too; none for a firm-wide scan. */
  workspaceId: SafeId<"workspace"> | null;
}) => {
  const boundary = createChatThirdPartyBoundary({
    anonymizationScopeId: workspaceId ?? organizationId,
    organizationId,
    scopedDb,
    sendMode: CHAT_SEND_MODE.anonymized,
    threadRestorations: [],
    workspaceId: workspaceId ?? undefined,
  });
  if (boundary.type !== "anonymized") {
    return panic("An anonymized send mode yields an anonymized boundary");
  }
  const scanned = await prepareTextForThirdParty({
    boundary,
    text: texts.join("\n\n"),
  });
  return scanned.map(() => {
    const seen = new Set<string>();
    const names: SkillDraftName[] = [];
    for (const [placeholder, value] of boundary.redactionMap) {
      const kind = kindOfPlaceholder(placeholder);
      const key = nameKey(value);
      if (kind === null || key.length === 0 || seen.has(key)) {
        continue;
      }
      seen.add(key);
      names.push({ kind, value });
    }
    return names;
  });
};

/** The names a draft holds that its author has not approved. */
export const unapprovedSkillDraftNames = (
  names: readonly SkillDraftName[],
  approved: readonly string[],
): SkillDraftName[] => {
  const approvedKeys = new Set(approved.map(nameKey));
  return names.filter(({ value }) => !approvedKeys.has(nameKey(value)));
};
