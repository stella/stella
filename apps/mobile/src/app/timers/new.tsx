import { Suspense, useState, useTransition } from "react";

import { Result } from "better-result";
import { Stack, useRouter } from "expo-router";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useTranslations } from "use-intl";

import { useChanged } from "@/components/changes";
import { screenStyles } from "@/components/empty-state-screen";
import { MatterPicker } from "@/components/matter-picker";
import { Text, TextInput } from "@/components/ui/text";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { listMatters } from "@/state/matters";
import { startTimer } from "@/state/timers";
import { useAppColors } from "@/theme";

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
  const colors = useAppColors();
  const router = useRouter();
  const { end } = useSession();
  const changed = useChanged();
  const [description, setDescription] = useState("");
  const [matterId, setMatterId] = useState<string | null>(null);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [starting, startStarting] = useTransition();
  const [matters] = useState(async () => {
    const result = await listMatters({ fetch, source });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end();
    }
    return result;
  });

  const start = () => {
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
        end();
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
              disabled: starting,
              label: t("start"),
              onPress: start,
              type: "button",
              variant: "done",
            },
          ],
        }}
      />
      <ScrollView
        className="bg-background flex-1"
        contentContainerStyle={screenStyles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <TextInput
          accessibilityLabel={t("description")}
          onChangeText={setDescription}
          placeholder={t("description")}
          value={description}
        />
        <WriteFailureNotice failure={failure} message={t("startFailed")} />
        <View className="gap-2">
          <View className="px-1">
            <Text variant="section">{t("matterTitle")}</Text>
          </View>
          <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
            <MatterPicker
              matters={matters}
              noneLabel={t("noMatter")}
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
