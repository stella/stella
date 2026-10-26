import type { Dispatch, SetStateAction } from "react";

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { ScrollArea } from "@stll/ui/scroll-area";

import { MEMBER_CHOICE, MemberCombobox } from "@/components/member-combobox";
import type { MemberOption } from "@/components/member-combobox";
import type { pendingDeletionTasksOptions } from "@/lib/account/queries";

type PendingTasks = Awaited<
  ReturnType<
    NonNullable<ReturnType<typeof pendingDeletionTasksOptions>["queryFn"]>
  >
>;
type PendingTask = PendingTasks["tasks"][number];
type PendingMember = PendingTasks["members"][number];

/** One matter's open tasks and the members who can take them over. */
export type DeletionTaskGroup = {
  workspaceId: string;
  workspaceName: string;
  tasks: PendingTask[];
  members: PendingMember[];
};

/** Task entity id to the member taking it over; "" leaves it unassigned. */
type Reassignments = Record<string, string>;

// The deletion read names each candidate only; it carries no email or avatar.
const reassignmentOptions = (
  candidates: readonly PendingMember[],
): MemberOption[] =>
  candidates.map(({ userId, userName }) => ({
    userId,
    name: userName,
    email: null,
    image: null,
  }));

type DeletionTaskReassignmentsProps = {
  groups: readonly DeletionTaskGroup[];
  reassignments: Reassignments;
  onReassignmentsChange: Dispatch<SetStateAction<Reassignments>>;
};

/** Hands each open task of a deleted account to another matter member. */
export const DeletionTaskReassignments = ({
  groups,
  reassignments,
  onReassignmentsChange,
}: DeletionTaskReassignmentsProps) => {
  const t = useTranslations();
  // The bulk picker names a member once every task in the matter goes to them.
  const sharedReassignment = (tasks: readonly PendingTask[]): string | null => {
    const chosen = new Set(tasks.map((task) => reassignments[task.entityId]));
    const only = chosen.size === 1 ? [...chosen].at(0) : undefined;
    return only || null;
  };

  return (
    <ScrollArea className="max-h-72">
      <div className="flex flex-col gap-3 pe-1">
        {groups.map((group) => {
          const candidates = reassignmentOptions(group.members);
          return (
            <div
              className="border-border flex flex-col gap-3 rounded-lg border p-3"
              key={group.workspaceId}
            >
              <div className="flex flex-col gap-2">
                <div className="text-muted-foreground text-xs">
                  <BidiText as="span">{group.workspaceName}</BidiText>
                </div>
                {candidates.length > 0 ? (
                  <MemberCombobox
                    choice={{ type: MEMBER_CHOICE.member }}
                    label={t("settings.account.deleteAccountTaskBulkReassign")}
                    members={candidates}
                    onValueChange={(userId) => {
                      if (userId === null) {
                        return;
                      }
                      onReassignmentsChange((prev) => ({
                        ...prev,
                        ...Object.fromEntries(
                          group.tasks.map((task) => [task.entityId, userId]),
                        ),
                      }));
                    }}
                    placeholder={t(
                      "settings.account.deleteAccountTaskBulkReassign",
                    )}
                    value={sharedReassignment(group.tasks)}
                  />
                ) : (
                  <p className="text-muted-foreground text-xs italic">
                    {t("settings.account.deleteAccountTaskReassignNone")}
                  </p>
                )}
              </div>
              {group.tasks.map((task) => (
                <div
                  key={task.assigneeId}
                  className="bg-muted/20 flex flex-col gap-1 rounded-md p-3"
                >
                  <div className="text-muted-foreground flex text-xs">
                    <span className="bg-muted text-3xs rounded px-1.5 py-0.5 font-mono capitalize">
                      {task.role}
                    </span>
                  </div>
                  <span className="text-sm font-medium">{task.taskName}</span>
                  <div className="mt-2">
                    {candidates.length > 0 ? (
                      <MemberCombobox
                        choice={{ type: MEMBER_CHOICE.member }}
                        label={t(
                          "settings.account.deleteAccountTaskReassignPlaceholder",
                        )}
                        members={candidates}
                        onValueChange={(userId) => {
                          onReassignmentsChange((prev) => ({
                            ...prev,
                            [task.entityId]: userId ?? "",
                          }));
                        }}
                        placeholder={t(
                          "settings.account.deleteAccountTaskReassignPlaceholder",
                        )}
                        value={reassignments[task.entityId] || null}
                      />
                    ) : (
                      <p className="text-muted-foreground text-xs italic">
                        {t("settings.account.deleteAccountTaskReassignNone")}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
};
