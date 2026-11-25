import { useEffect, useState } from "react";

import { useTranslations } from "use-intl";

import type { DesktopMatterResolution } from "@stll/api-contract/desktop-time-entries";
import { Button } from "@stll/ui/button";
import { Form } from "@stll/ui/form";
import { Trash2Icon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";

import type { MatterRule } from "./matter-learning";
import { useMatterRules } from "./matter-learning-store";
import { resolveMatters } from "./matter-resolve";
import { useRuleLabel } from "./matter-rule-label";

type MatterNames =
  | { type: "loading" }
  | { type: "failed" }
  | { type: "ready"; resolved: readonly DesktopMatterResolution[] };

/** The rules' matters, read under the member's current access: a matter the
 * member lost is "unavailable", never named from the rule. */
const useRuleMatterNames = (rules: readonly MatterRule[]) => {
  const [names, setNames] = useState<MatterNames>({ type: "loading" });
  const [attempt, setAttempt] = useState(0);
  const ids = [...new Set(rules.map(({ matterId }) => matterId))]
    .sort()
    .join(" ");
  // A retry asks again for the same ids.
  const request = `${String(attempt)}:${ids}`;
  useEffect(() => {
    let current = true;
    const asked = request.slice(request.indexOf(":") + 1);
    if (asked !== "") {
      resolveMatters(asked.split(" "))
        .then((resolved) => {
          if (current) {
            setNames({ type: "ready", resolved });
          }
          return undefined;
        })
        .catch(() => {
          if (current) {
            setNames({ type: "failed" });
          }
        });
    }
    return () => {
      current = false;
    };
  }, [request]);
  return {
    names: ids === "" ? { type: "ready", resolved: [] } : names,
    retry: () => setAttempt((count) => count + 1),
  } satisfies { names: MatterNames; retry: () => void };
};

const RuleRow = ({
  rule,
  matter,
  onSave,
  onDelete,
}: {
  rule: MatterRule;
  matter: string | null;
  onSave: (value: string) => void;
  onDelete: () => void;
}) => {
  const t = useTranslations("activity");
  const tClipboard = useTranslations("clipboard");
  const ruleLabel = useRuleLabel();
  const [value, setValue] = useState(rule.value);
  const changed = value.trim().length > 0 && value !== rule.value;
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <p className="text-sm text-pretty">
        <bdi>{ruleLabel(rule)}</bdi>
      </p>
      {matter === null ? null : (
        <p className="text-muted-foreground text-xs">
          {t("matterRuleFiles", { matter })}
        </p>
      )}
      <Form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed) {
            onSave(value.trim());
          }
        }}
      >
        <Input
          aria-label={t("matterRuleValue")}
          className="min-w-0 flex-1"
          onChange={(event) => setValue(event.target.value)}
          value={value}
        />
        <Button type="submit" variant="outline">
          {tClipboard("save")}
        </Button>
        <Button onClick={onDelete} type="button" variant="ghost">
          <Trash2Icon aria-hidden="true" />
          {t("matterRuleDelete")}
        </Button>
      </Form>
    </li>
  );
};

/** The member's own matter rules: what each files, under which matter;
 * editable and deletable, kept only on this computer. */
export const MatterRulesSettings = () => {
  const t = useTranslations("activity");
  const { state, saveFailed, update, retry } = useMatterRules();
  const rules = state.type === "ready" ? state.value : [];
  const { names, retry: retryNames } = useRuleMatterNames(rules);
  const matterLabel = (matterId: string) => {
    if (names.type !== "ready") {
      return null;
    }
    for (const resolution of names.resolved) {
      if (
        resolution.type === "accessible" &&
        resolution.matter.id === matterId
      ) {
        return resolution.matter.name;
      }
    }
    return t("matterUnavailable");
  };
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{t("matterRulesTitle")}</h3>
        <p className="text-muted-foreground text-xs text-pretty">
          {t("matterRulesDescription")}
        </p>
      </div>
      {state.type === "unavailable" ? (
        <p className="text-muted-foreground text-xs">
          {t("matterRulesUnavailable")}
        </p>
      ) : null}
      {state.type === "failed" ? (
        <div
          role="alert"
          className="text-destructive flex items-center gap-2 text-sm"
        >
          {t("matterLearningFailed")}
          <Button onClick={retry} variant="ghost">
            {t("retry")}
          </Button>
        </div>
      ) : null}
      {names.type === "failed" ? (
        <div
          role="alert"
          className="text-destructive flex items-center gap-2 text-sm"
        >
          {t("matterNamesFailed")}
          <Button onClick={retryNames} variant="ghost">
            {t("retry")}
          </Button>
        </div>
      ) : null}
      {saveFailed ? (
        <p role="alert" className="text-destructive text-sm">
          {t("matterLearningSaveFailed")}
        </p>
      ) : null}
      {state.type === "ready" && rules.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t("matterRulesEmpty")}</p>
      ) : null}
      {rules.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rules.map((rule) => (
            <RuleRow
              key={`${rule.id}:${rule.value}`}
              matter={matterLabel(rule.matterId)}
              onDelete={() =>
                update((current) => current.filter(({ id }) => id !== rule.id))
              }
              onSave={(value) =>
                update((current) =>
                  current.map((saved) =>
                    saved.id === rule.id
                      ? {
                          id: saved.id,
                          field: saved.field,
                          op: saved.op,
                          value,
                          matterId: saved.matterId,
                        }
                      : saved,
                  ),
                )
              }
              rule={rule}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
};
