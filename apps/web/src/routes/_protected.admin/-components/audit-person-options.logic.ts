import type { MemberOption } from "@/components/member-combobox";

type AuditPersonEntry = {
  userId: string;
  actor: string;
  performerType: string;
};

/**
 * The people the activity log can be narrowed to: current members, then the
 * people acting in the loaded entries who are no longer members (named as the
 * log names them), then the chosen person when neither list holds them, so a
 * filter on someone who has left stays visible and reversible. Entries are
 * undefined until the first page of the log has loaded.
 */
export const auditPersonOptions = ({
  members,
  entries,
  selected,
}: {
  members: readonly MemberOption[];
  entries: readonly AuditPersonEntry[] | undefined;
  selected: MemberOption | null;
}): MemberOption[] => {
  const options = [...members];
  const listed = new Set(members.map((member) => member.userId));
  if (entries !== undefined) {
    for (const entry of entries) {
      if (entry.performerType === "service" || listed.has(entry.userId)) {
        continue;
      }
      listed.add(entry.userId);
      options.push({
        userId: entry.userId,
        name: entry.actor,
        email: null,
        image: null,
      });
    }
  }
  if (selected !== null && !listed.has(selected.userId)) {
    options.push(selected);
  }
  return options;
};
