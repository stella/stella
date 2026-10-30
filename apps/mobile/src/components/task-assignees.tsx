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
 * does. The members load the first time the list opens. A change in flight
 * belongs to this component, not to the list, so closing and reopening the
 * list neither drops its result nor lets a second change overlap it.
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
  const { end } = useSession();
  const changed = useChanged();
  const [assignees, setAssignees] = useState<readonly Assignee[]>(() =>
    initial.map(({ userId, user }) => ({
      userId,
      name: user?.name ?? null,
    })),
  );
  const [members, setMembers] = useState<Promise<
    Result<MatterMember[], ApiError>
  > | null>(null);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [saving, startSaving] = useTransition();
  const names = assignees.map((assignee) => assignee.name ?? t("someone"));

  const toggle = (member: MatterMember, assign: boolean) => {
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
        // Applied to the list as it is now, which a later change may
        // already have moved on from.
        setAssignees((current) =>
          assign
            ? [
                ...current.filter(
                  (assignee) => assignee.userId !== member.userId,
                ),
                { userId: member.userId, name: member.user?.name ?? null },
              ]
            : current.filter((assignee) => assignee.userId !== member.userId),
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
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text variant="caption">{t("assignedTo")}</Text>
          <Text numberOfLines={2} variant="rowTitle">
            {names.length === 0 ? t("nobody") : names.join(", ")}
          </Text>
        </View>
        <Button
          loading={saving}
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
            assigned={new Set(assignees.map((assignee) => assignee.userId))}
            load={members}
            onToggle={toggle}
            saving={saving}
            source={source}
          />
        </Suspense>
      )}
      <WriteFailureNotice failure={failure} message={t("assignFailed")} />
    </View>
  );
};

const MemberList = ({
  assigned,
  load,
  onToggle,
  saving,
  source,
}: {
  assigned: ReadonlySet<string>;
  load: Promise<Result<MatterMember[], ApiError>>;
  onToggle: (member: MatterMember, assign: boolean) => void;
  saving: boolean;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("tasks");
  const ui = useUiColors();
  const { end } = useSession();
  const loaded = use(load);

  if (Result.isError(loaded)) {
    if (loaded.error._tag === "SignedOutError") {
      end(source);
      return null;
    }
    return <Text variant="error">{t("membersFailed")}</Text>;
  }

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
              onToggle(member, !isAssigned);
            }}
          >
            <Text className="flex-1" numberOfLines={1} variant="rowTitle">
              {member.user?.name ?? t("someone")}
            </Text>
            {isAssigned ? <CheckIcon color={ui.foreground} size={18} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
};
