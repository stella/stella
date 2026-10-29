import { Suspense, useState, useTransition } from "react";

import { Result } from "better-result";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { useTimeZone, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Loader } from "@stll/ui/loader";
import { Text } from "@stll/ui/text";

import { useChanged } from "@/components/changes";
import { screenStyles } from "@/components/empty-state-screen";
import { MatterPicker } from "@/components/matter-picker";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { listMatters } from "@/state/matters";
import { createTask, dayAt } from "@/state/tasks";

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
        <Input
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
              <Button
                accessibilityRole="radio"
                accessibilityState={{ selected: due === choice.key }}
                key={choice.key}
                onPress={() => {
                  setDue(choice.key);
                }}
                size="chip"
                variant={due === choice.key ? "default" : "outline"}
              >
                {t(`dueChoice.${choice.key}`)}
              </Button>
            ))}
          </View>
        </View>
        <View className="gap-2">
          <View className="px-1">
            <Text variant="section">{t("matterTitle")}</Text>
          </View>
          <Suspense fallback={<Loader />}>
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
