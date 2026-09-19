/**
 * The fill form's "Decided by AI" section: one chip per AI-decided condition,
 * showing what the decision model makes of the values entered so far and how
 * sure it is. Clicking a chip takes the answer over; clicking it twice more
 * hands it back. Without a decision backend the chips say so instead of
 * pretending to an answer — the condition is still resolved when the document
 * is generated.
 */

import {
  hashKey,
  keepPreviousData,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import { cn } from "@stll/ui/utils";

import type { ConditionChipState } from "@/components/templates/template-ai-conditions.logic";
import {
  activeConditionDecisions,
  conditionChipState,
  conditionRequestValues,
  describeConditionChip,
  effectiveConditionValues,
  formatProbability,
  hasEnteredValues,
  readConditionOverrides,
} from "@/components/templates/template-ai-conditions.logic";
import type { ResolvedField } from "@/components/templates/template-discover-types";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useFormatter } from "@/i18n/formatting-context";
import { api } from "@/lib/api";
import { optionalReadonlyArray } from "@/lib/arrays";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { STALE_TIME } from "@/lib/consts";
import { unwrapEden } from "@/lib/errors/api";
import { knowledgeKeys } from "@/lib/knowledge/queries";
import type { QueryOptionsInput } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

type AiDecidedConditionsProps = {
  /** Server-side fill only: the endpoint reads the stored template. */
  templateId: string;
  /** The AI-decided condition fields, in template order. */
  fields: readonly ResolvedField[];
  /** Live form values: a boolean under a condition's path is an override. */
  values: Record<string, unknown>;
  /** The debounced form values the decision model is asked about. */
  snapshot: Record<string, unknown>;
  /** Fields visible in the live form. Hidden values stay out of the model's
   *  request, matching the payload produced when the form is submitted. */
  visibleFields: readonly ResolvedField[];
  /** Form-state bookkeeping keys for the visible array fields. The form owns
   *  their naming convention; this component only applies the projection. */
  visibleArrayIndexPaths: readonly string[];
  onToggle: (path: string) => void;
  /** Effective answers (an override, else a settled model answer) for a host
   *  that previews the document while the form is filled. */
  onDecided?: ((decided: Record<string, boolean>) => void) | undefined;
};

export const AiDecidedConditions = ({
  templateId,
  fields,
  values,
  snapshot,
  visibleFields,
  visibleArrayIndexPaths,
  onToggle,
  onDecided,
}: AiDecidedConditionsProps) => {
  const t = useTranslations();
  const organizationId = useAuthenticatedUser().activeOrganizationId;

  const conditionPaths = fields.map((field) => field.path);
  const overrides = readConditionOverrides(values, conditionPaths);
  const requestValues = conditionRequestValues({
    values: snapshot,
    conditionPaths,
    visibleFields,
    visibleArrayIndexPaths,
  });
  const requestEnabled = hasEnteredValues(requestValues);

  // `keepPreviousData` is what lets the pending state show the last answer
  // instead of blanking the chips on every burst of typing; the superseded
  // query's request is aborted through the `signal` its queryFn consumed.
  const { data, isError, isPlaceholderData, isFetching } = useQuery({
    ...decideConditionsOptions({
      key: { organizationId, templateId, valuesHash: hashKey([requestValues]) },
      context: { values: requestValues },
    }),
    enabled: requestEnabled,
    placeholderData: keepPreviousData,
  });

  const conditions = activeConditionDecisions(
    requestValues,
    optionalReadonlyArray(data?.conditions),
  );
  const decisionByPath = new Map(
    conditions.map((condition) => [condition.path, condition]),
  );
  const decided = effectiveConditionValues(conditions, overrides);

  // The host pushes these into the document preview, an imperative editor that
  // cannot read them during render. Keyed on the answers' stable hash so a
  // re-render carrying identical answers is a no-op and the push cannot
  // sustain itself through the host's state.
  const decidedHash = hashKey([decided]);
  const pushDecided = useLatestCallback(() => onDecided?.(decided));
  useExternalSyncEffect(() => {
    pushDecided();
  }, [pushDecided, decidedHash]);

  const queryFailed = requestEnabled && isError;
  const pending = requestEnabled && (isPlaceholderData || isFetching);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-foreground text-sm font-semibold">
        {t("templates.aiDecidedConditions")}
      </h3>
      {queryFailed && (
        <p className="text-destructive text-xs" role="alert">
          {t("common.unexpectedError")}
        </p>
      )}
      <ul className="flex flex-col gap-1.5">
        {fields.map((field) => {
          const condition = decisionByPath.get(field.path);
          return (
            <li className="min-w-0" key={field.path}>
              <ConditionChip
                label={condition?.label ?? field.label ?? field.path}
                onToggle={() => onToggle(field.path)}
                pending={pending}
                state={
                  queryFailed && typeof overrides[field.path] !== "boolean"
                    ? { kind: "error" }
                    : conditionChipState(
                        overrides[field.path],
                        condition?.decision,
                      )
                }
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
};

const ConditionChip = ({
  label,
  state,
  pending,
  onToggle,
}: {
  label: string;
  state: ConditionChipState;
  pending: boolean;
  onToggle: () => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const { tone, answer } = describeConditionChip(state);
  const percent = (probability: number) =>
    formatProbability(probability, (value, options) =>
      format.number(value, options),
    );

  const answerText = (): string => {
    switch (answer.kind) {
      case "decided":
        return answer.value
          ? t("templates.conditionDecidedYes", {
              probability: percent(answer.probability),
            })
          : t("templates.conditionDecidedNo", {
              probability: percent(answer.probability),
            });
      case "forced":
        return answer.value
          ? t("templates.conditionForcedYes")
          : t("templates.conditionForcedNo");
      case "error":
        return t("common.somethingWentWrong");
      case "notSettled":
        return t("templates.conditionNotSettled");
      case "onGenerate":
        return t("templates.conditionDecidedOnGenerate");
      default:
        answer satisfies never;
        return panic(`Unhandled chip answer: ${String(answer)}`);
    }
  };

  return (
    <button
      // The badge sits far below the 44px touch target, so the button carries
      // the hit area without changing how big the chip looks.
      className={cn(
        "flex min-h-11 w-full min-w-0 cursor-pointer items-center rounded-full transition-opacity",
        "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
        pending && "opacity-60",
      )}
      onClick={onToggle}
      title={t("templates.conditionOverrideHint")}
      type="button"
    >
      <ReviewStatusBadge
        // The label gives way before the answer does: a narrow inspector
        // truncates the condition's name and keeps the verdict readable.
        className="max-w-full"
        size="sm"
        tone={tone}
        variant={state.kind === "forced" ? "solid" : "outline"}
      >
        <span className="text-foreground min-w-0 truncate">{label}</span>
        <span className="shrink-0 tabular-nums">{answerText()}</span>
      </ReviewStatusBadge>
    </button>
  );
};

type DecideConditionsKey = {
  organizationId: string;
  templateId: string;
  /** The request values' stable TanStack hash: the values themselves ride in
   *  the context so a long form does not bloat the cache key. */
  valuesHash: string;
};

type DecideConditionsContext = {
  values: Record<string, unknown>;
};

type DecideConditionsOptionsInput = QueryOptionsInput<
  DecideConditionsKey,
  DecideConditionsContext
>;

const requestConditionDecisions =
  (key: DecideConditionsKey, values: Record<string, unknown>) =>
  async ({ signal }: { signal: AbortSignal }) =>
    unwrapEden(
      await api
        .templates({ templateId: toSafeId<"template">(key.templateId) })
        ["decide-conditions"].post({ values }, { fetch: { signal } }),
    );

const decideConditionsOptions = ({
  key,
  context,
}: DecideConditionsOptionsInput) =>
  queryOptions({
    queryKey: knowledgeKeys.templates.decideConditions(
      key.organizationId,
      key.templateId,
      key.valuesHash,
    ),
    queryFn: requestConditionDecisions(key, context.values),
    // A decision over a given set of values does not change on its own, and
    // the model call is not cheap: never re-ask for a form state already
    // answered.
    staleTime: STALE_TIME.FIVE.MINUTES,
    retry: false,
  });
