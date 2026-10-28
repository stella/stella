import { useState, useTransition } from "react";

import { Result } from "better-result";
import { View } from "react-native";
import { useTimeZone, useTranslations } from "use-intl";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import {
  clockOf,
  discardTimer,
  elapsedSeconds,
  saveTimer,
  toggleTimer,
} from "@/state/timers";
import type { Timer } from "@/state/timers";

/**
 * One timer: its clock, counting while it runs, what it is for and its
 * matter, and what can be done with it: pause or resume, save it as a draft
 * time entry, or discard it. The screen loads afresh after each.
 */
export const TimerCard = ({
  matterName,
  now,
  onChanged,
  source,
  timer,
}: {
  matterName: string | undefined;
  now: number;
  onChanged: () => void;
  source: AccessTokenSource;
  timer: Timer;
}) => {
  const t = useTranslations("timers");
  const timeZone = useTimeZone() ?? "UTC";
  const { end } = useSession();
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [busy, startBusy] = useTransition();
  const running = timer.state === "running";

  const act = (change: () => Promise<Result<unknown, ApiError>>) => {
    startBusy(async () => {
      setFailure(null);
      const changed = await change();
      if (Result.isOk(changed)) {
        onChanged();
        return;
      }
      if (changed.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      setFailure(writeFailure(changed.error));
    });
  };

  return (
    <View className="border-border bg-card gap-3 rounded-xl border p-4">
      <View className="gap-0.5">
        <Text
          accessibilityLabel={t(running ? "running" : "paused")}
          variant={running ? "title" : "headline"}
        >
          {clockOf(elapsedSeconds(timer, now))}
        </Text>
        <Text numberOfLines={2} variant="rowTitle">
          {timer.description === null ||
          timer.description === undefined ||
          timer.description === ""
            ? t("noDescription")
            : timer.description}
        </Text>
        <Text numberOfLines={1} variant="caption">
          {[
            matterName ?? t("noMatter"),
            t(running ? "running" : "paused"),
          ].join(" · ")}
        </Text>
      </View>
      <View className="flex-row gap-2">
        <Button
          className="flex-1"
          disabled={busy}
          label={t(running ? "pause" : "resume")}
          onPress={() => {
            act(async () => await toggleTimer({ fetch, source, timer }));
          }}
          variant="outline"
        />
        <Button
          className="flex-1"
          disabled={busy}
          label={t("save")}
          onPress={() => {
            act(
              async () => await saveTimer({ fetch, source, timeZone, timer }),
            );
          }}
        />
      </View>
      <Button
        disabled={busy}
        label={t("discard")}
        onPress={() => {
          act(async () => await discardTimer({ fetch, source, timer }));
        }}
        size="sm"
        variant="destructive-ghost"
      />
      <WriteFailureNotice failure={failure} message={t("changeFailed")} />
    </View>
  );
};
