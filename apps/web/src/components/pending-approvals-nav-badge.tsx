import { SidebarMenuBadge } from "@/components/sidebar";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useFormatter } from "@/i18n/formatting-context";
import { queryView } from "@/lib/query-view.logic";
import { timeApprovalPendingOptions } from "@/lib/workspaces/queries/time-approvals";

/**
 * Beside the Time link: how many submitted entries wait for the signed-in
 * person, as the approval queue counts them (bounded by the API). Members who
 * approve what is assigned to them get it too, since the queue decides, not
 * the role. It is the request My week reads, so the two share one fetch.
 * Nothing shows while none waits or the count cannot be read.
 */
export const PendingApprovalsNavBadge = ({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) => {
  const format = useFormatter();
  const pending = queryView(
    useChromeQuery(timeApprovalPendingOptions(organizationId, userId)),
    { isEmpty: (count) => count === 0 },
  );
  if (pending.type !== "items") {
    return null;
  }
  return (
    <SidebarMenuBadge>
      <span className="text-muted-foreground text-3xs tabular-nums">
        {format.number(pending.items)}
      </span>
    </SidebarMenuBadge>
  );
};
