import { createFileRoute, redirect } from "@tanstack/react-router";
import { v7 as uuidv7 } from "uuid";

export const Route = createFileRoute("/_protected/chat/new")({
  beforeLoad: () => {
    throw redirect({
      to: "/chat/$threadId",
      params: { threadId: uuidv7() },
      replace: true,
    });
  },
});
