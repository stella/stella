import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { UserIdentity } from "@/components/user-avatar";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { organizationOptions } from "@/lib/organization/queries";
import { workspaceMembersOptions } from "@/lib/workspaces/queries/workspace-members";

/** Organization members who are not yet members of the workspace. */
export const useAddableMembers = (workspaceId: string) => {
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data: org, isPending: isOrganizationPending } = useQuery(
    organizationOptions(activeOrganizationId),
  );
  const { data: existingMembers = [] } = useQuery(
    workspaceMembersOptions(workspaceId),
  );

  const existingUserIds = new Set(existingMembers.map((m) => m.userId));
  const organizationMembers = org ? org.members : [];
  const items = organizationMembers
    .filter((m) => !existingUserIds.has(m.userId))
    .map((m) => ({
      email: m.user.email,
      image: m.user.image,
      name: m.user.name,
      value: m.userId,
    }));

  return { isOrganizationPending, items };
};

type AddableMemberSelectProps = {
  items: ReturnType<typeof useAddableMembers>["items"];
  onValueChange: (userId: string | null) => void;
  value: string | null;
};

export const AddableMemberSelect = ({
  items,
  onValueChange,
  value,
}: AddableMemberSelectProps) => {
  const t = useTranslations();

  return (
    <Select onValueChange={onValueChange} value={value}>
      <SelectTrigger>
        <SelectValue>
          {(current) => {
            const found = items.find((m) => m.value === current);
            if (!found) {
              return t("workspaces.members.selectMember");
            }

            return (
              <UserIdentity
                avatarClassName="size-7 shrink-0 text-3xs"
                className="min-w-0"
                image={found.image}
                name={found.name}
                secondaryText={found.email}
              />
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            <UserIdentity
              avatarClassName="size-7 shrink-0 text-3xs"
              className="min-w-0"
              image={item.image}
              name={item.name}
              secondaryText={item.email}
            />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};
