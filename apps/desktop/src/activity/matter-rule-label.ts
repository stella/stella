import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { MatchReason } from "./day-review-logic";
import type {
  MatterRule,
  MatterRuleField,
  MatterRuleOp,
} from "./matter-learning";

const RULE_LABEL_KEYS = {
  title: { contains: "ruleTitleContains", startsWith: "ruleTitleStartsWith" },
  documentPath: {
    contains: "ruleDocumentPathContains",
    startsWith: "ruleDocumentPathStartsWith",
  },
  app: { contains: "ruleAppContains", startsWith: "ruleAppStartsWith" },
} as const satisfies Record<MatterRuleField, Record<MatterRuleOp, string>>;

/** What a rule matches, in one phrase: "Window title contains “X”". */
export const useRuleLabel = () => {
  const t = useTranslations("activity");
  return ({ field, op, value }: Pick<MatterRule, "field" | "op" | "value">) =>
    t(RULE_LABEL_KEYS[field][op], { value });
};

/** Why a suggestion names its matter, in one line; `null` when the member
 * chose the matter themselves or nothing named one. */
export const useMatchReasonLabel = () => {
  const t = useTranslations("activity");
  const ruleLabel = useRuleLabel();
  return (reason: MatchReason): string | null => {
    switch (reason.type) {
      case "assigned":
      case "none":
        return null;
      case "session":
        return t("matchReasonSession");
      case "rule":
        return t("matchReasonRule", { rule: ruleLabel(reason.rule) });
      case "reference":
        return t("matchReasonReference", { reference: reason.reference });
      case "name":
        return t("matchReasonName", { token: reason.token });
      case "learned":
        return t("matchReasonLearned", { token: reason.token });
      default:
        reason satisfies never;
        return panic("Unknown match reason");
    }
  };
};
