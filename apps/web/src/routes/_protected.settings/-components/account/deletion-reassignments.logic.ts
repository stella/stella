type AccountDeletionReassignmentsOptions = {
  tasks: readonly { entityId: string; workspaceId: string }[];
  members: readonly { workspaceId: string; userId: string }[];
  reassignments: Readonly<Record<string, string>>;
};

export const validAccountDeletionReassignments = ({
  tasks,
  members,
  reassignments,
}: AccountDeletionReassignmentsOptions) =>
  tasks.every(({ entityId, workspaceId }) => {
    const target = reassignments[entityId];
    return (
      !target ||
      members.some(
        (member) =>
          member.workspaceId === workspaceId && member.userId === target,
      )
    );
  });

/** Active tasks with no selected member lose their assignee on deletion. */
export const accountDeletionLeavesTasksUnassigned = ({
  tasks,
  reassignments,
}: Omit<AccountDeletionReassignmentsOptions, "members">) =>
  tasks.some(({ entityId }) => !reassignments[entityId]);
