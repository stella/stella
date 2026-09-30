import { useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  TIME_ENTRY_ACTIVITY_GROUP,
  type TimeEntryActivityGroup,
} from "@stll/api-contract";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogFooter,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Label } from "@stll/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";

import { timerActivityOptions } from "@/components/billing/global-timer-confirmation.logic";
import { QuickEntryRefusal } from "@/components/quick-entry-refusal";
import {
  MatterCombobox,
  type MatterOption,
} from "@/components/workspaces/matter-combobox";
import { usePermissions } from "@/hooks/use-permissions";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import {
  globalTimeTimersKeys,
  globalTimeTimersOptions,
  type listMyTimers,
} from "@/lib/workspaces/queries/global-time-timers";
import { myTimeEntriesKeys } from "@/lib/workspaces/queries/my-time-entries";
import { timeEntriesKeys } from "@/lib/workspaces/queries/time-entries";

type Timer = Awaited<ReturnType<typeof listMyTimers>>["items"][number];

const TimerConfirmation = ({
  timer,
  onClose,
}: {
  timer: Timer;
  onClose: () => void;
}) => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const client = useQueryClient();
  const analytics = useAnalytics();
  const activityOptions = timerActivityOptions(timer.matterId);
  const [activityGroup, setActivityGroup] = useState<TimeEntryActivityGroup>(
    activityOptions.defaultActivityGroup,
  );
  const [matter, setMatter] = useState<MatterOption | null>(null);
  const [description, setDescription] = useState(timer.description ?? "");
  const [detailsSaved, setDetailsSaved] = useState(false);
  const effectiveMatterId =
    activityGroup === TIME_ENTRY_ACTIVITY_GROUP.CLIENT
      ? (timer.matterId ?? matter?.id ?? null)
      : null;
  const confirmation = useMutation({
    mutationFn: async () => {
      const timerApi = api["time-timers"]({ id: timer.id });
      if (!detailsSaved) {
        unwrapEden(
          await timerApi.patch({ description, matterId: effectiveMatterId }),
        );
        setDetailsSaved(true);
      }
      return unwrapEden(
        await timerApi.confirm.post({
          timezoneId: user.timezoneId,
          activityGroup,
        }),
      );
    },
    onError: (error) => analytics.captureError(error),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: globalTimeTimersKeys.all(
            user.activeOrganizationId,
            user.id,
          ),
        }),
        client.invalidateQueries({
          queryKey: myTimeEntriesKeys.all(user.activeOrganizationId),
        }),
        ...(effectiveMatterId === null
          ? []
          : [
              client.invalidateQueries({
                queryKey: timeEntriesKeys.all(effectiveMatterId),
              }),
            ]),
      ]);
      stellaToast.add({
        type: "success",
        title: t("billing.quickEntry.entrySaved"),
      });
      onClose();
    },
  });
  const needsMatter =
    activityGroup === TIME_ENTRY_ACTIVITY_GROUP.CLIENT &&
    timer.matterId === null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !confirmation.isPending) {
          onClose();
        }
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("common.logTime")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {confirmation.error !== null && (
            <QuickEntryRefusal error={confirmation.error} />
          )}
          <fieldset
            className="flex flex-col gap-4"
            disabled={confirmation.isPending}
          >
            {timer.matterId === null && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${timer.id}-activity`}>
                  {t("billing.activityGroup")}
                </Label>
                <Select
                  value={activityGroup}
                  onValueChange={(value) => {
                    if (
                      (value === TIME_ENTRY_ACTIVITY_GROUP.CLIENT ||
                        value === TIME_ENTRY_ACTIVITY_GROUP.INTERNAL) &&
                      activityOptions.activityGroups.some(
                        (group) => group === value,
                      )
                    ) {
                      setActivityGroup(value);
                      setDetailsSaved(false);
                    }
                  }}
                >
                  <SelectTrigger id={`${timer.id}-activity`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={TIME_ENTRY_ACTIVITY_GROUP.CLIENT}>
                      {t("billing.clientWork")}
                    </SelectItem>
                    <SelectItem value={TIME_ENTRY_ACTIVITY_GROUP.INTERNAL}>
                      {t("timesheets.day.internalWork")}
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            )}
            {needsMatter && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${timer.id}-matter`}>
                  {t("common.matter")}
                </Label>
                <MatterCombobox
                  activeOrganizationId={user.activeOrganizationId}
                  id={`${timer.id}-matter`}
                  order="recent"
                  onChange={(value) => {
                    setMatter(value);
                    setDetailsSaved(false);
                  }}
                  value={matter}
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${timer.id}-narrative`}>
                {t("common.description")}
              </Label>
              <Textarea
                id={`${timer.id}-narrative`}
                maxLength={10_000}
                value={description}
                onChange={(event) => {
                  setDescription(event.currentTarget.value);
                  setDetailsSaved(false);
                }}
              />
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={confirmation.isPending}
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={
              confirmation.isPending || (needsMatter && matter === null)
            }
            onClick={() => confirmation.mutate()}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

export const GlobalTimerConfirmation = () => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const canRead = usePermissions({ timeEntry: ["read"] });
  const canCreate = usePermissions({ timeEntry: ["create"] });
  const canUpdate = usePermissions({ timeEntry: ["update"] });
  const [open, setOpen] = useState(false);
  const timers = useInfiniteQuery({
    ...globalTimeTimersOptions(user.activeOrganizationId, user.id),
    enabled: canRead && open,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const items = timers.data?.pages.flatMap((page) => page.items) ?? [];
  const selected = items.find((timer) => timer.id === selectedId);
  if (!canRead) {
    return null;
  }
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {t("billing.timers")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("billing.timers")}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            {timers.isPending && <p>{t("common.loading")}</p>}
            {timers.error !== null && (
              <QuickEntryRefusal error={timers.error} />
            )}
            {items.map((timer) => (
              <div
                key={timer.id}
                className="flex items-center justify-between gap-3"
              >
                <BidiText className="text-sm">
                  {timer.description ||
                    t(
                      timer.matterId === null
                        ? "timesheets.day.internalWork"
                        : "billing.clientWork",
                    )}
                </BidiText>
                <Button
                  variant="outline"
                  disabled={!canCreate || !canUpdate}
                  onClick={() => {
                    setSelectedId(timer.id);
                    setOpen(false);
                  }}
                >
                  {t("common.logTime")}
                </Button>
              </div>
            ))}
            {timers.hasNextPage && (
              <Button
                variant="ghost"
                disabled={timers.isFetchingNextPage}
                onClick={() => {
                  detached(
                    timers.fetchNextPage(),
                    "global-timer-confirmation.load-more",
                  );
                }}
              >
                {t("common.loadMore")}
              </Button>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      {selected !== undefined && (
        <TimerConfirmation
          key={selected.id}
          timer={selected}
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );
};
