import { Suspense, useState, useTransition } from "react";

import { Result } from "better-result";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useTimeZone, useTranslations } from "use-intl";

import { useChanged } from "@/components/changes";
import { screenStyles } from "@/components/empty-state-screen";
import { MatterPicker } from "@/components/matter-picker";
import { Text, TextInput } from "@/components/ui/text";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { listMatters } from "@/state/matters";
import { createTask, dayAt } from "@/state/tasks";
import { useAppColors, useUiColors } from "@/theme";

/** The due dates the sheet offers, as days from today; null leaves it undated. */
const DUE_CHOICES = [
  { key: "none", days: null },
  { key: "today", days: 0 },
  { key: "tomorrow", days: 1 },
  { key: "nextWeek", days: 7 },
] as const;

type DueChoice = (typeof DUE_CHOICES)[number]["key"];

/**
 * A new task, presented as a sheet over the tasks: its name, when it is due
 * and the matter it belongs to. The bar's Add creates it, and the tasks
 * underneath load afresh.
 */
const NewTaskScreen = () => {
  const { state } = useSession();
  return state.status === "signed-in" ? (
    <NewTaskForm source={state.source} />
  ) : null;
};

const NewTaskForm = ({ source }: { source: AccessTokenSource }) => {
  const t = useTranslations("tasks");
  const tabs = useTranslations("tabs");
  const colors = useAppColors();
  const ui = useUiColors();
  const router = useRouter();
  const { end } = useSession();
  const changed = useChanged();
  const timeZone = useTimeZone() ?? "UTC";
  const params = useLocalSearchParams<{ matterId?: string }>();
  const [name, setName] = useState("");
  const [due, setDue] = useState<DueChoice>("none");
  const [matterId, setMatterId] = useState(params.matterId ?? null);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [adding, startAdding] = useTransition();
  const [matters] = useState(async () => {
    const result = await listMatters({ fetch, source });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    return result;
  });
  const ready = name.trim() !== "" && matterId !== null && !adding;

  const add = () => {
    if (matterId === null) {
      return;
    }
    const days = DUE_CHOICES.find((choice) => choice.key === due)?.days ?? null;
    startAdding(async () => {
      setFailure(null);
      const created = await createTask({
        dueDate:
          days === null
            ? null
            : dayAt(epochMilliseconds(), timeZone).add({ days }).toString(),
        fetch,
        matterId,
        name: name.trim(),
        source,
      });
      if (Result.isOk(created)) {
        changed("tasks");
        router.back();
        return;
      }
      if (created.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      setFailure(writeFailure(created.error));
    });
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: t("newTask"),
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
              disabled: !ready,
              label: t("add"),
              onPress: add,
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
          accessibilityLabel={t("name")}
          autoFocus
          onChangeText={setName}
          onSubmitEditing={add}
          placeholder={t("name")}
          returnKeyType="done"
          value={name}
        />
        <WriteFailureNotice failure={failure} message={t("addFailed")} />
        <View className="gap-2">
          <View className="px-1">
            <Text variant="section">{t("dueTitle")}</Text>
          </View>
          <View className="flex-row flex-wrap gap-2">
            {DUE_CHOICES.map((choice) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: due === choice.key }}
                className={`rounded-full border px-3 py-1.5 active:opacity-60 ${
                  due === choice.key
                    ? "border-foreground bg-foreground"
                    : "border-border bg-card"
                }`}
                key={choice.key}
                onPress={() => {
                  setDue(choice.key);
                }}
              >
                <Text
                  style={
                    due === choice.key ? { color: ui.background } : undefined
                  }
                  variant="label"
                >
                  {t(`dueChoice.${choice.key}`)}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View className="gap-2">
          <View className="px-1">
            <Text variant="section">{t("matterTitle")}</Text>
          </View>
          <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
            <MatterPicker
              matters={matters}
              onSelect={setMatterId}
              selected={matterId}
            />
          </Suspense>
        </View>
      </ScrollView>
    </>
  );
};

export default NewTaskScreen;
