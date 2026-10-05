import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { UserIdentity } from "@/components/user-avatar";
import { addableMembersView } from "@/components/workspaces/addable-member-select.logic";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { organizationOptions } from "@/lib/organization/queries";
import { useQueryView } from "@/lib/use-query-view";
import { workspaceMembersOptions } from "@/lib/workspaces/queries/workspace-members";

/** Organization members who are not yet members of the workspace. */
export const useAddableMembers = (workspaceId: string) => {
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const organizationView = useQueryView(
    useQuery(organizationOptions(activeOrganizationId)),
  );
  const membersView = useQueryView(
    useQuery(workspaceMembersOptions(workspaceId)),
  );
  const view = addableMembersView(organizationView, membersView);
  return { view, organizationView, membersView };
};

type AddableMemberSelectProps = {
  query: ReturnType<typeof useAddableMembers>;
  onValueChange: (userId: string | null) => void;
  value: string | null;
};

export const AddableMemberSelect = ({
  query,
  onValueChange,
  value,
}: AddableMemberSelectProps) => {
  const t = useTranslations();

  const { view, organizationView, membersView } = query;
  const feedback = (
    <>
      <QueryViewFeedback view={organizationView} />
      <QueryViewFeedback view={membersView} />
    </>
  );
  switch (view.type) {
    case "pending":
    case "error":
      return feedback;
    case "empty":
      return (
        <>
          {feedback}
          <p className="text-muted-foreground text-sm">
            {t("workspaces.leadPicker.noMatchingMembers")}
          </p>
        </>
      );
    case "items":
      break;
    default:
      view satisfies never;
      return panic("Unhandled addable members state");
  }
  const items = view.items;
  return (
    <>
      {feedback}
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
    </>
  );
};
