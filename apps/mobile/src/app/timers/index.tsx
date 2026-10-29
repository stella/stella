import { Suspense, use, useState, useTransition } from "react";

import { Result } from "better-result";
import { Stack, useRouter } from "expo-router";
import { ActivityIndicator, RefreshControl, ScrollView } from "react-native";
import { useTranslations } from "use-intl";

import { useChanged, useRevision } from "@/components/changes";
import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { RetryButton } from "@/components/retry-button";
import { TimerCard } from "@/components/timer-card";
import { useGlyphImage } from "@/components/ui/use-glyph-image";
import { useNow } from "@/components/use-now";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import { listMatters } from "@/state/matters";
import { listTimers } from "@/state/timers";
import type { Timer } from "@/state/timers";
import { useAppColors } from "@/theme";

type TimersLoad = {
  readonly timers: Result<Timer[], ApiError>;
  /** The names of the person's matters, by id, for the timers that have one. */
  readonly matterNames: ReadonlyMap<string, string>;
};

/**
 * The person's running and paused timers, opened from More, with the bar's
 * "+" to start another. Each can be paused or resumed, saved as a draft
 * time entry, or discarded.
 */
const TimersScreen = () => {
  const { state } = useSession();
  const revision = useRevision("timers");
  const t = useTranslations("timers");
  const router = useRouter();
  const plusGlyph = useGlyphImage("plus");

  return (
    <>
      <Stack.Screen
        options={{
          title: t("title"),
          unstable_headerRightItems: () =>
            plusGlyph === null
              ? []
              : [
                  {
                    icon: { source: plusGlyph, type: "image" },
                    label: t("startTimer"),
                    onPress: () => {
                      router.push("/timers/new");
                    },
                    type: "button",
                  },
                ],
        }}
      />
      {state.status === "signed-in" ? (
        <TimersLoader key={revision} source={state.source} />
      ) : null}
    </>
  );
};

const TimersLoader = ({ source }: { source: AccessTokenSource }) => {
  const colors = useAppColors();
  const { end } = useSession();
  const loadTimers = async (): Promise<TimersLoad> => {
    const [timers, matters] = await Promise.all([
      listTimers({ fetch, source }),
      listMatters({ fetch, source }),
    ]);
    if (Result.isError(timers) && timers.error._tag === "SignedOutError") {
      end(source);
    }
    return {
      timers,
      matterNames: new Map(
        Result.isOk(matters)
          ? matters.value.map((matter) => [matter.id, matter.name])
          : [],
      ),
    };
  };
  const [load, setLoad] = useState(loadTimers);
  const [refreshing, startRefresh] = useTransition();
  const reload = () => {
    startRefresh(() => {
      setLoad(loadTimers());
    });
  };

  return (
    <Suspense
      fallback={<ActivityIndicator className="flex-1" color={colors.muted} />}
    >
      <LoadedTimers
        load={load}
        onReload={reload}
        refreshing={refreshing}
        source={source}
      />
    </Suspense>
  );
};

const LoadedTimers = ({
  load,
  onReload,
  refreshing,
  source,
}: {
  load: Promise<TimersLoad>;
  onReload: () => void;
  refreshing: boolean;
  source: AccessTokenSource;
}) => {
  const colors = useAppColors();
  const changed = useChanged();
  const { matterNames, timers } = use(load);
  const now = useNow(
    Result.isOk(timers) &&
      timers.value.some(({ state }) => state === "running"),
  );

  // The session provider is already returning to sign-in.
  if (Result.isError(timers) && timers.error._tag === "SignedOutError") {
    return null;
  }

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerStyle={screenStyles.content}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={
        <RefreshControl
          onRefresh={onReload}
          refreshing={refreshing}
          tintColor={colors.muted}
        />
      }
    >
      <TimersBody
        matterNames={matterNames}
        now={now}
        onChanged={() => {
          changed("timers");
        }}
        onReload={onReload}
        source={source}
        timers={timers}
      />
    </ScrollView>
  );
};

/** The timers, or why there are none to show. */
const TimersBody = ({
  matterNames,
  now,
  onChanged,
  onReload,
  source,
  timers,
}: {
  matterNames: ReadonlyMap<string, string>;
  now: number;
  onChanged: () => void;
  onReload: () => void;
  source: AccessTokenSource;
  timers: Result<Timer[], ApiError>;
}) => {
  const t = useTranslations("timers");

  if (Result.isError(timers)) {
    // An organization without time billing answers the timers as forbidden
    // or missing; anything else may pass on a retry.
    const { error } = timers;
    return error._tag === "ApiRequestError" &&
      (error.status === 403 || error.status === 404) ? (
      <EmptyCard description={t("unavailable")} title={t("emptyTitle")} />
    ) : (
      <EmptyCard description={t("loadFailed")} title={t("emptyTitle")}>
        <RetryButton label={t("retry")} onPress={onReload} />
      </EmptyCard>
    );
  }
  if (timers.value.length === 0) {
    return (
      <EmptyCard description={t("emptyDescription")} title={t("emptyTitle")} />
    );
  }
  return timers.value.map((timer) => (
    <TimerCard
      key={timer.id}
      matterName={
        timer.matterId === null || timer.matterId === undefined
          ? undefined
          : matterNames.get(timer.matterId)
      }
      now={now}
      onChanged={onChanged}
      source={source}
      timer={timer}
    />
  ));
};

export default TimersScreen;
