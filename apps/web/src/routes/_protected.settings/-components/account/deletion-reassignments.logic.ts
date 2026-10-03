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
