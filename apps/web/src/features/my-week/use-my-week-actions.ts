import { useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { ManualTimeEntryValues } from "@/components/billing/manual-time-entry-form";
import type {
  MySuggestion,
  MySuggestionMatter,
  MyTimeEntry,
} from "@/features/my-week/my-week-day";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { allInvoicesQueryRoot } from "@/lib/resource-query-roots.logic";
import {
  useDecideTimeSuggestion,
  useUpdateTimeEntry,
} from "@/lib/workspaces/mutations/time-entries";
import { myTimeEntriesKeys } from "@/lib/workspaces/queries/my-time-entries";
import { myTimeSuggestionsKeys } from "@/lib/workspaces/queries/my-time-suggestions";
import { timeApprovalsKeys } from "@/lib/workspaces/queries/time-approvals";
import { timeEntriesKeys } from "@/lib/workspaces/queries/time-entries";

export type SuggestionTarget = {
  matter: MySuggestionMatter["matter"];
  date: string;
  suggestion: MySuggestion;
};

export type SubmitWeekRequest = {
  startDate: string;
  endDate: string;
  /** Approve in the same step what the person is the approver of. */
  approve: boolean;
};

type AcceptValues = Pick<
  ManualTimeEntryValues,
  "durationMinutes" | "narrative" | "narrativeLanguage" | "billable"
>;

/**
 * The week's writes: decide a suggestion in its own matter, or edit a draft.
 * Each refreshes the person's week (entries, totals and suggestions) once it
 * lands, and a suggestion stays disabled until its own decision settles.
 */
export const useMyWeekActions = ({
  organizationId,
  timezoneId,
}: {
  organizationId: string;
  timezoneId: string;
}) => {
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const decideSuggestion = useDecideTimeSuggestion();
  const updateEntry = useUpdateTimeEntry();
  const [busyFingerprints, setBusyFingerprints] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const refreshWeek = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: myTimeEntriesKeys.all(organizationId),
      }),
      queryClient.invalidateQueries({
        queryKey: myTimeSuggestionsKeys.all(organizationId),
      }),
    ]);
  };

  const submitWeek = useMutation({
    mutationFn: async (body: SubmitWeekRequest) =>
      await invokeCapability(
        "time-entries.me.submissions.create",
        async (request) =>
          unwrapApiResponse(
            await api["time-entries"].me.submissions.post(body, request),
          ),
      ),
    // A submission spans matters: their time lists change, and with approval
    // so does what they can invoice.
    onSuccess: async () => {
      await Promise.all([
        refreshWeek(),
        queryClient.invalidateQueries({ queryKey: timeApprovalsKeys.root }),
        queryClient.invalidateQueries({ queryKey: timeEntriesKeys.root() }),
        queryClient.invalidateQueries({ queryKey: allInvoicesQueryRoot() }),
      ]);
    },
  });

  const decide = async (
    { matter, date, suggestion }: SuggestionTarget,
    decision: Parameters<typeof decideSuggestion.mutateAsync>[0]["decision"],
  ) => {
    const { fingerprint } = suggestion;
    setBusyFingerprints((current) => new Set(current).add(fingerprint));
    const settle = () =>
      setBusyFingerprints((current) => {
        const next = new Set(current);
        next.delete(fingerprint);
        return next;
      });
    // The row stays busy until the decision and the week refresh settle.
    await decideSuggestion
      .mutateAsync({
        workspaceId: matter.id,
        fingerprint,
        date,
        timezoneId,
        decision,
      })
      .then(async () => await refreshWeek())
      .finally(settle);
  };

  const accept = async (target: SuggestionTarget, values: AcceptValues) =>
    await decide(target, {
      type: "accept",
      durationMinutes: values.durationMinutes,
      narrative: values.narrative,
      narrativeLanguage: values.narrativeLanguage,
      // The value the person saw, even the default, so a rate change in the
      // meantime cannot flip it.
      billable: values.billable,
    });

  const dismiss = async (target: SuggestionTarget) =>
    await decide(target, { type: "dismiss" });

  const editEntry = async (
    entry: MyTimeEntry,
    values: ManualTimeEntryValues,
  ) => {
    if (entry.workspaceId === null) {
      return;
    }
    await updateEntry.mutateAsync({
      workspaceId: entry.workspaceId,
      id: entry.id,
      timezoneId,
      ...values,
    });
    await refreshWeek();
  };

  const reportFailure = (error: unknown) => {
    notifyUserError(error, tErrors("actionFailed"));
  };

  /** Runs a write from a row and tells the person when it fails. */
  const fromRow = async (write: Promise<void>) => {
    await write.catch(reportFailure);
  };

  return {
    busyFingerprints,
    pending: decideSuggestion.isPending || updateEntry.isPending,
    submitWeek: submitWeek.mutateAsync,
    submitting: submitWeek.isPending,
    accept,
    dismiss,
    editEntry,
    fromRow,
    reportFailure,
  };
};
