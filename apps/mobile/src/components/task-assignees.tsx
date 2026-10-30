import { Suspense, use, useState, useTransition } from "react";

import { Result } from "better-result";
import { ActivityIndicator, Pressable, View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { useChanged } from "@/components/changes";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { CheckIcon } from "@/icons.gen";
import type { ApiError } from "@/state/api-request";
import { listMatterMembers, setTaskAssignee } from "@/state/tasks";
import type { MatterMember, TaskDetail } from "@/state/tasks";
import { useUiColors } from "@/theme";

type Assignee = { readonly userId: string; readonly name: string | null };

/**
 * Who works on a task, and the matter's members to give it to: a tap on a
 * member assigns or unassigns them at once, as the web's assignee picker
 * does. The members load the first time the list opens.
 */
export const TaskAssignees = ({
  initial,
  matterId,
  source,
  taskId,
}: {
  initial: TaskDetail["assignees"];
  matterId: string;
  source: AccessTokenSource;
  taskId: string;
}) => {
  const t = useTranslations("tasks");
  const [assignees, setAssignees] = useState<readonly Assignee[]>(() =>
    initial.map(({ userId, user }) => ({
      userId,
      name: user?.name ?? null,
    })),
  );
  const [members, setMembers] = useState<Promise<
    Result<MatterMember[], ApiError>
  > | null>(null);
  const names = assignees.map((assignee) => assignee.name ?? t("someone"));

  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text variant="caption">{t("assignedTo")}</Text>
          <Text numberOfLines={2} variant="rowTitle">
            {names.length === 0 ? t("nobody") : names.join(", ")}
          </Text>
        </View>
        <Button
          onPress={() => {
            setMembers((open) =>
              open === null
                ? listMatterMembers({ fetch, matterId, source })
                : null,
            );
          }}
          size="sm"
          variant="outline"
        >
          {members === null ? t("assign") : t("doneAssigning")}
        </Button>
      </View>
      {members === null ? null : (
        <Suspense fallback={<ActivityIndicator />}>
          <MemberList
            assignees={assignees}
            load={members}
            matterId={matterId}
            onChange={setAssignees}
            source={source}
            taskId={taskId}
          />
        </Suspense>
      )}
    </View>
  );
};

const MemberList = ({
  assignees,
  load,
  matterId,
  onChange,
  source,
  taskId,
}: {
  assignees: readonly Assignee[];
  load: Promise<Result<MatterMember[], ApiError>>;
  matterId: string;
  onChange: (assignees: readonly Assignee[]) => void;
  source: AccessTokenSource;
  taskId: string;
}) => {
  const t = useTranslations("tasks");
  const ui = useUiColors();
  const { end } = useSession();
  const changed = useChanged();
  const loaded = use(load);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [saving, startSaving] = useTransition();

  if (Result.isError(loaded)) {
    if (loaded.error._tag === "SignedOutError") {
      end(source);
      return null;
    }
    return <Text variant="error">{t("membersFailed")}</Text>;
  }

  const assigned = new Set(assignees.map((assignee) => assignee.userId));
  const toggle = (member: MatterMember) => {
    const assign = !assigned.has(member.userId);
    startSaving(async () => {
      setFailure(null);
      const saved = await setTaskAssignee({
        assigned: assign,
        fetch,
        matterId,
        source,
        taskId,
        userId: member.userId,
      });
      if (Result.isOk(saved)) {
        onChange(
          assign
            ? [
                ...assignees,
                { userId: member.userId, name: member.user?.name ?? null },
              ]
            : assignees.filter((assignee) => assignee.userId !== member.userId),
        );
        changed("tasks");
        return;
      }
      if (saved.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      setFailure(writeFailure(saved.error));
    });
  };

  return (
    <View>
      {loaded.value.map((member) => {
        const isAssigned = assigned.has(member.userId);
        return (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: isAssigned, disabled: saving }}
            className="border-border active:bg-accent min-h-11 flex-row items-center gap-3 border-b py-2"
            disabled={saving}
            key={member.userId}
            onPress={() => {
              toggle(member);
            }}
          >
            <Text className="flex-1" numberOfLines={1} variant="rowTitle">
              {member.user?.name ?? t("someone")}
            </Text>
            {isAssigned ? <CheckIcon color={ui.foreground} size={18} /> : null}
          </Pressable>
        );
      })}
      <WriteFailureNotice failure={failure} message={t("assignFailed")} />
    </View>
  );
};
