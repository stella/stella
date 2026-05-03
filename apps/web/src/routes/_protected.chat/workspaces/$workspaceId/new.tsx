import { createFileRoute, redirect } from "@tanstack/react-router";
import { v7 as uuidv7 } from "uuid";

export const Route = createFileRoute(
  "/_protected/chat/workspaces/$workspaceId/new",
)({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/chat/workspaces/$workspaceId/$threadId",
      params: { workspaceId: params.workspaceId, threadId: uuidv7() },
      replace: true,
    });
  },
});
