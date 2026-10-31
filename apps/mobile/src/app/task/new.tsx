import { Suspense, useState, useTransition } from "react";

import { Result } from "better-result";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useFormatter, useTimeZone, useTranslations } from "use-intl";

import { Input } from "@stll/ui/input";
import { Text } from "@stll/ui/text";

import { useChanged } from "@/components/changes";
import { DueDatePicker } from "@/components/due-date-picker";
import { screenStyles } from "@/components/empty-state-screen";
import { MatterPicker } from "@/components/matter-picker";
import { MemberList } from "@/components/task-assignees";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { listMatters } from "@/state/matters";
import { pickerDate } from "@/state/picked-day";
import {
  chosenDueDate,
  createTask,
  dayAt,
  listMatterMembers,
  newTaskAssignees,
} from "@/state/tasks";
import { useAppColors, useUiColors } from "@/theme";

/** The due dates the sheet offers, as days from today; null leaves it undated. */
const DUE_CHOICES = [
  { key: "none", days: null },
  { key: "today", days: 0 },
  { key: "tomorrow", days: 1 },
  { key: "nextWeek", days: 7 },
] as const;

/** A preset, or "pick": the day chosen in the calendar. */
type DueChoice = (typeof DUE_CHOICES)[number]["key"] | "pick";

/**
 * A new task, presented as a sheet over the tasks: its name, when it is due
 * (a preset or any day from the calendar), the matter it belongs to and who
 * works on it, the creator to begin with. The bar's Add creates it, and the
 * tasks underneath load afresh.
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
  const router = useRouter();
  const { end } = useSession();
  const changed = useChanged();
  const format = useFormatter();
  const timeZone = useTimeZone() ?? "UTC";
  const params = useLocalSearchParams<{ matterId?: string }>();
  const today = dayAt(epochMilliseconds(), timeZone);
  const [name, setName] = useState("");
  const [due, setDue] = useState<DueChoice>("none");
  const [pickedOn, setPickedOn] = useState(() =>
    today.add({ days: 1 }).toString(),
  );
  const [matterId, setMatterId] = useState(params.matterId ?? null);
  const membersOf = (id: string | null) =>
    id === null ? null : listMatterMembers({ fetch, matterId: id, source });
  const [members, setMembers] = useState(() => membersOf(matterId));
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set([source.session().userId]),
  );
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
    const dueDate = chosenDueDate(
      { days, picked: due === "pick" ? pickedOn : null },
      today,
    );
    startAdding(async () => {
      setFailure(null);
      const created = await createTask({
        assigneeIds: newTaskAssignees(
          chosen,
          members === null ? null : await members,
        ),
        dueDate,
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
              <DueChip
                key={choice.key}
                label={t(`dueChoice.${choice.key}`)}
                onPress={() => {
                  setDue(choice.key);
                }}
                selected={due === choice.key}
              />
            ))}
            <DueChip
              label={
                due === "pick"
                  ? format.dateTime(
                      pickerDate(pickedOn, { timeZone, plainTime: "12:00" }),
                      {
                        day: "numeric",
                        month: "short",
                        timeZone,
                        weekday: "short",
                      },
                    )
                  : t("dueChoice.pick")
              }
              onPress={() => {
                setDue("pick");
              }}
              selected={due === "pick"}
            />
          </View>
          {due === "pick" ? (
            <DueDatePicker
              day={pickedOn}
              earliest={today.toString()}
              onChange={setPickedOn}
            />
          ) : null}
        </View>
        <View className="gap-2">
          <View className="px-1">
            <Text variant="section">{t("matterTitle")}</Text>
          </View>
          <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
            <MatterPicker
              matters={matters}
              onSelect={(id) => {
                setMatterId(id);
                setMembers(membersOf(id));
              }}
              selected={matterId}
            />
          </Suspense>
        </View>
        {members === null ? null : (
          <View className="gap-2">
            <View className="px-1">
              <Text variant="section">{t("assignedTo")}</Text>
            </View>
            <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
              <MemberList
                assigned={chosen}
                load={members}
                onToggle={(member, assign) => {
                  setChosen((current) => {
                    const next = new Set(current);
                    if (assign) {
                      next.add(member.userId);
                    } else {
                      next.delete(member.userId);
                    }
                    return next;
                  });
                }}
                saving={adding}
                source={source}
              />
            </Suspense>
          </View>
        )}
      </ScrollView>
    </>
  );
};

/** One of the due choices, filled while it is the chosen one. */
const DueChip = ({
  label,
  onPress,
  selected,
}: {
  label: string;
  onPress: () => void;
  selected: boolean;
}) => {
  const ui = useUiColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      className={`rounded-full border px-3 py-1.5 active:opacity-60 ${
        selected ? "border-foreground bg-foreground" : "border-border bg-card"
      }`}
      onPress={onPress}
    >
      <Text
        style={selected ? { color: ui.background } : undefined}
        variant="label"
      >
        {label}
      </Text>
    </Pressable>
  );
};

export default NewTaskScreen;
