import { panic } from "better-result";
import type { Result } from "better-result";
import { Link, useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { MatterIcon } from "@stll/ui/matter-icon";
import { Text } from "@stll/ui/text";

import { useLayout, useSelection } from "@/components/selection";
import { SwipeRow } from "@/components/swipe-row";
import type { SwipeAction } from "@/components/swipe-row";
import { useOptimisticWrite } from "@/components/use-optimistic-write";
import { usePickDocument } from "@/components/use-pick-document";
import { useScan } from "@/components/use-scan";
import { WriteFailureNotice } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { PauseIcon, PlayIcon } from "@/icons.gen";
import { canScan } from "@/native/document-scanner";
import type { ApiError } from "@/state/api-request";
import type { MatterSummary } from "@/state/matters";
import { matterTimerAction, startTimer, toggleTimer } from "@/state/timers";
import type { MatterTimerAction, Timer } from "@/state/timers";

/**
 * One matter: its name, then reference, client and the day of its last
 * activity. The day is a date, not "2 days ago": Hermes, the app's
 * JavaScript engine, cannot format relative times. Under its client's
 * heading the client goes unsaid. Tapping it opens the matter, beside the
 * list where the window has two columns, which marks it as the one open.
 * Swiping it starts a timer on it, or pauses or resumes the one it has.
 * Holding it adds to it without opening it: a task, or a scanned document
 * where the device can scan.
 */
export const MatterRow = ({
  matter,
  source,
  timers,
  underClient = false,
}: {
  matter: MatterSummary;
  source: AccessTokenSource;
  /** Every timer as the last load read them; null when they could not be read. */
  timers: readonly Timer[] | null;
  underClient?: boolean;
}) => {
  const format = useFormatter();
  const t = useTranslations("matter");
  const timerText = useTranslations("timers");
  const timer = timers === null ? null : matterTimerAction(timers, matter.id);
  const reportedRunning = timer?.type === "pause";
  const {
    failure,
    saving,
    value: running,
    write,
  } = useOptimisticWrite({
    from: timers ?? matter,
    kind: "timers",
    reported: reportedRunning,
    source,
  });
  const router = useRouter();
  const scan = useScan(matter.id);
  const pick = usePickDocument(matter.id);
  const layout = useLayout();
  const selection = useSelection();
  const open =
    layout.usesSplitView && selection.matter?.workspaceId === matter.id;
  const activity =
    matter.lastActivityAt === null || matter.lastActivityAt === undefined
      ? undefined
      : format.dateTime(new Date(matter.lastActivityAt), {
          day: "numeric",
          month: "short",
        });
  const details = [
    matter.reference,
    underClient ? undefined : matter.client?.displayName,
    activity,
    running ? t("timerRunning") : undefined,
  ].filter(
    (detail): detail is string =>
      detail !== undefined && detail !== null && detail !== "",
  );

  // Until the timers load again after a change, the timer to pause or
  // resume is not known, so the row offers nothing to swipe.
  const swipe =
    timer === null || saving || running !== reportedRunning
      ? null
      : timerSwipe({
          labels: {
            pause: t("pauseTimer"),
            resume: t("resumeTimer"),
            start: t("startTimer"),
          },
          matterId: matter.id,
          source,
          timer,
          write,
        });

  return (
    <SwipeRow action={swipe}>
      {(accessibility) => (
        <Link
          asChild
          href={{
            pathname: "/matter/[workspaceId]",
            params: { workspaceId: matter.id, name: matter.name },
          }}
          onPress={(event) => {
            if (layout.usesSplitView) {
              event.preventDefault();
              selection.select("matter", {
                name: matter.name,
                workspaceId: matter.id,
              });
            }
          }}
        >
          <Link.Trigger>
            <Pressable
              {...accessibility}
              accessibilityRole="button"
              accessibilityState={{ selected: open }}
              className={`border-border active:bg-accent flex-row gap-3 border-b py-3 ${open ? "bg-accent" : ""}`}
            >
              <View className="pt-0.5">
                <MatterIcon matter={matter} size={18} />
              </View>
              <View className="flex-1 gap-0.5">
                <Text numberOfLines={2} variant="rowTitle">
                  {matter.name}
                </Text>
                {details.length === 0 ? null : (
                  <Text numberOfLines={1} variant="caption">
                    {details.join(" · ")}
                  </Text>
                )}
                <WriteFailureNotice
                  failure={failure}
                  message={timerText(
                    timer?.type === "start" ? "startFailed" : "changeFailed",
                  )}
                />
              </View>
            </Pressable>
          </Link.Trigger>
          <Link.Menu>
            <Link.MenuAction
              icon="checklist"
              onPress={() => {
                router.push({
                  pathname: "/task/new",
                  params: { matterId: matter.id },
                });
              }}
            >
              {t("newTask")}
            </Link.MenuAction>
            <Link.MenuAction icon="doc" onPress={pick}>
              {t("uploadDocument")}
            </Link.MenuAction>
            <Link.MenuAction
              hidden={!canScan()}
              icon="doc.viewfinder"
              onPress={scan}
            >
              {t("scanDocument")}
            </Link.MenuAction>
          </Link.Menu>
        </Link>
      )}
    </SwipeRow>
  );
};

/**
 * The swipe for a matter's timer. Starting pauses whichever timer was
 * running elsewhere, as the server keeps only one counting.
 */
const timerSwipe = ({
  labels,
  matterId,
  source,
  timer,
  write,
}: {
  labels: Readonly<Record<MatterTimerAction["type"], string>>;
  matterId: string;
  source: AccessTokenSource;
  timer: MatterTimerAction;
  write: (
    running: boolean,
    save: () => Promise<Result<unknown, ApiError>>,
  ) => void;
}): SwipeAction => {
  switch (timer.type) {
    case "start":
      return {
        icon: PlayIcon,
        label: labels.start,
        name: "startTimer",
        run: () => {
          write(
            true,
            async () =>
              await startTimer({ description: null, fetch, matterId, source }),
          );
        },
      };
    case "pause":
    case "resume":
      return {
        icon: timer.type === "pause" ? PauseIcon : PlayIcon,
        label: labels[timer.type],
        name: `${timer.type}Timer`,
        run: () => {
          write(
            timer.type === "resume",
            async () =>
              await toggleTimer({ fetch, source, timer: timer.timer }),
          );
        },
      };
    default:
      timer satisfies never;
      return panic("unknown matter timer action");
  }
};
