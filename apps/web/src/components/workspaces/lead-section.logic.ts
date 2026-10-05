import { panic } from "better-result";

import type { QueryView } from "@/lib/query-view.logic";

type LeadSectionContent<Workspace, Member, Error> =
  | Exclude<QueryView<Workspace | Member[], Error>, { type: "items" }>
  | { type: "items"; workspace: Workspace; members: Member[] };

type LeadSectionContentOptions<Workspace, Member, Error> = {
  workspace: QueryView<Workspace, Error>;
  members: QueryView<Member[], Error>;
};

export const leadSectionContent = <Workspace, Member, Error>({
  workspace,
  members,
}: LeadSectionContentOptions<Workspace, Member, Error>): LeadSectionContent<
  Workspace,
  Member,
  Error
> => {
  switch (workspace.type) {
    case "pending":
    case "error":
    case "empty":
      return workspace;
    case "items":
      switch (members.type) {
        case "pending":
        case "error":
          return members;
        case "empty":
          return { type: "items", workspace: workspace.items, members: [] };
        case "items":
          return {
            type: "items",
            workspace: workspace.items,
            members: members.items,
          };
        default:
          members satisfies never;
          return panic("Unhandled matter lead members state");
      }
    default:
      workspace satisfies never;
      return panic("Unhandled matter lead workspace state");
  }
};
