import { useId, useState } from "react";

import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/button";
import { Label } from "@stll/ui/label";
import { Textarea } from "@stll/ui/textarea";

import {
  MatterCombobox,
  type MatterOption,
} from "@/components/workspaces/matter-combobox";
import { useTimerMutation } from "@/features/time-timers/mutations";
import { TimerError } from "@/features/time-timers/timer-error";
import type { TimeTimer } from "@/features/time-timers/timer.logic";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { schemaFormOptions } from "@/lib/schema";
import { organizationSettingsOptions } from "@/queries/organization-settings";

type TimerFormProps = {
  timer: TimeTimer | null;
  initialMatter: MatterOption | null;
  onDone: () => void;
};

export const TimerForm = ({ timer, initialMatter, onDone }: TimerFormProps) => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const id = useId();
  const [matter, setMatter] = useState(initialMatter);
  const mutation = useTimerMutation();
  const [prepared, setPrepared] = useState<{
    matterId: string;
    description: string;
  } | null>(null);
  const policy = useQuery(
    organizationSettingsOptions({
      organizationId: user.activeOrganizationId,
      userId: user.id,
    }),
  );
  const requiresNarrative =
    timer !== null && policy.data?.timeNarrativeRequired === true;
  const form = useForm(
    schemaFormOptions({
      defaultValues: {
        description: timer?.description ?? "",
        matterId: initialMatter?.id ?? "",
      },
      schema: v.object({
        description: v.pipe(
          v.string(),
          v.maxLength(10_000),
          v.check(
            (value) => !requiresNarrative || value.trim().length > 0,
            t("billing.globalTimer.narrativeRequired"),
          ),
        ),
        matterId: v.pipe(
          v.string(),
          v.check(
            (value) => timer === null || value.length > 0,
            t("billing.matterRequired"),
          ),
        ),
      }),
      submitValues: "schema-output",
      onSubmit: ({ value }) => {
        mutation.mutate(
          timer === null
            ? {
                type: "start",
                matterId: value.matterId || null,
                description: value.description,
              }
            : {
                type: "confirm",
                id: timer.id,
                preparation:
                  prepared?.matterId === value.matterId &&
                  prepared.description === value.description
                    ? { type: "prepared" }
                    : {
                        type: "update",
                        matterId: value.matterId,
                        description: value.description,
                        onPrepared: () => setPrepared(value),
                      },
              },
          { onSuccess: onDone },
        );
      },
    }),
  );

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (mutation.isPending || (timer !== null && !policy.data)) {
          return;
        }
        detached(form.handleSubmit(), "timer-form.submit");
      }}
    >
      <form.Field name="matterId">
        {(field) => (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-matter`}>{t("common.matter")}</Label>
            <MatterCombobox
              activeOrganizationId={user.activeOrganizationId}
              userId={user.id}
              id={`${id}-matter`}
              value={matter}
              onChange={(value) => {
                setMatter(value);
                field.handleChange(value?.id ?? "");
              }}
            />
            {field.state.meta.errors.map(
              (error) =>
                error && (
                  <p
                    className="text-destructive text-sm"
                    key={error.message}
                    role="alert"
                  >
                    {error.message}
                  </p>
                ),
            )}
          </div>
        )}
      </form.Field>
      <form.Field name="description">
        {(field) => (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-description`}>
              {t("billing.narrative")}
            </Label>
            <Textarea
              id={`${id}-description`}
              maxLength={10_000}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              required={requiresNarrative}
            />
            {field.state.meta.errors.map(
              (error) =>
                error && (
                  <p
                    className="text-destructive text-sm"
                    key={error.message}
                    role="alert"
                  >
                    {error.message}
                  </p>
                ),
            )}
          </div>
        )}
      </form.Field>
      <TimerError error={mutation.error} />
      {timer !== null && policy.error !== null && (
        <div className="flex items-center gap-2">
          <p className="text-destructive text-sm" role="alert">
            {policy.error.message}
          </p>
          <Button
            onClick={() =>
              detached(policy.refetch(), "timer-form.retry-policy")
            }
            type="button"
            variant="ghost"
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          disabled={mutation.isPending}
          onClick={onDone}
          type="button"
          variant="ghost"
        >
          {t("common.cancel")}
        </Button>
        <Button
          disabled={mutation.isPending || (timer !== null && !policy.data)}
          type="submit"
        >
          {t(
            timer === null
              ? "billing.startTimer"
              : "billing.globalTimer.confirm",
          )}
        </Button>
      </div>
    </form>
  );
};
