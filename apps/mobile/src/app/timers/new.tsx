import { Suspense, useState, useTransition } from "react";

import { Result } from "better-result";
import { Stack, useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { useTranslations } from "use-intl";

import { Input } from "@stll/ui/input";
import { Loader } from "@stll/ui/loader";
import { Text } from "@stll/ui/text";

import { useChanged } from "@/components/changes";
import { DictateButton } from "@/components/dictate-button";
import { screenStyles } from "@/components/empty-state-screen";
import { MatterPicker } from "@/components/matter-picker";
import { useDictationField } from "@/components/use-dictation-field";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { listMatters } from "@/state/matters";
import { startTimer } from "@/state/timers";

/**
 * A new timer, presented as a sheet over the timers: what it is for and,
 * if any, its matter. Start begins counting at once and pauses whichever
 * timer was running.
 */
const NewTimerScreen = () => {
  const { state } = useSession();
  return state.status === "signed-in" ? (
    <NewTimerForm source={state.source} />
  ) : null;
};

const NewTimerForm = ({ source }: { source: AccessTokenSource }) => {
  const t = useTranslations("timers");
  const tabs = useTranslations("tabs");
  const words = useTranslations("timerActivity");
  const router = useRouter();
  const { end } = useSession();
  const changed = useChanged();
  const [description, setDescription] = useState("");
  const field = useDictationField(description, setDescription);
  const [matterId, setMatterId] = useState<string | null>(null);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [starting, startStarting] = useTransition();
  // Starting waits for a dictation to land in the description: closing the
  // form drops it.
  const [dictating, setDictating] = useState(false);
  const [matters] = useState(async () => {
    const result = await listMatters({ fetch, source });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    return result;
  });

  const start = () => {
    if (dictating) {
      return;
    }
    startStarting(async () => {
      setFailure(null);
      const started = await startTimer({
        description: description.trim() === "" ? null : description.trim(),
        fetch,
        matterId,
        source,
      });
      if (Result.isOk(started)) {
        changed("timers");
        router.back();
        return;
      }
      if (started.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      setFailure(writeFailure(started.error));
    });
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: t("newTimer"),
          unstable_headerLeftItems: () => [
            {
              label: tabs("close"),
              onPress: () => {
                router.back();
              },
              type: "button",
            },
          ],
          unstable_headerRightItems: () => [
            {
              disabled: starting || dictating,
              label: t("start"),
              onPress: start,
              type: "button",
              variant: "done",
            },
          ],
        }}
      />
      <ScrollView
        alwaysBounceVertical={false}
        className="bg-background flex-1"
        contentContainerStyle={screenStyles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <Input
          accessibilityLabel={t("description")}
          {...field.inputProps}
          placeholder={t("description")}
          value={description}
        />
        <DictateButton
          field="timer"
          matterId={matterId ?? undefined}
          onBusyChange={setDictating}
          onText={field.insert}
        />
        <WriteFailureNotice failure={failure} message={t("startFailed")} />
        <View className="gap-2">
          <View className="px-1">
            <Text variant="section">{t("matterTitle")}</Text>
          </View>
          <Suspense fallback={<Loader />}>
            <MatterPicker
              matters={matters}
              noneLabel={words("noMatter")}
              onSelect={setMatterId}
              selected={matterId}
            />
          </Suspense>
        </View>
      </ScrollView>
    </>
  );
};

export default NewTimerScreen;
