import { useMutation, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import { timeTimersKeys } from "@/features/time-timers/queries";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { myTimeEntriesKeys } from "@/lib/workspaces/queries/my-time-entries";
import { timeEntriesKeys } from "@/lib/workspaces/queries/time-entries";

type TimerCommand =
  | { type: "start"; matterId: string | null; description: string }
  | { type: "pause" | "resume" | "discard"; id: string }
  | {
      type: "confirm";
      id: string;
      preparation:
        | {
            type: "update";
            matterId: string;
            description: string;
            onPrepared: () => void;
          }
        | { type: "prepared" };
    };

export const useTimerMutation = () => {
  const user = useAuthenticatedUser();
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  return useMutation({
    mutationFn: async (command: TimerCommand) => {
      switch (command.type) {
        case "start":
          unwrapEden(
            await api["time-timers"].start.post({
              matterId:
                command.matterId === null
                  ? null
                  : toSafeId<"workspace">(command.matterId),
              description: command.description,
            }),
          );
          return;
        case "pause":
          unwrapEden(await api["time-timers"]({ id: command.id }).pause.post());
          return;
        case "resume":
          unwrapEden(
            await api["time-timers"]({ id: command.id }).resume.post(),
          );
          return;
        case "discard":
          unwrapEden(await api["time-timers"]({ id: command.id }).delete());
          return;
        case "confirm":
          if (command.preparation.type === "update") {
            unwrapEden(
              await api["time-timers"]({ id: command.id }).patch({
                matterId: toSafeId<"workspace">(command.preparation.matterId),
                description: command.preparation.description,
              }),
            );
            command.preparation.onPrepared();
          }
          unwrapEden(
            await api["time-timers"]({ id: command.id }).confirm.post({
              timezoneId: user.timezoneId,
            }),
          );
          return;
        default:
          command satisfies never;
          panic("Unknown timer command");
      }
    },
    onSuccess: async (_, command) => {
      if (command.type !== "confirm") {
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: myTimeEntriesKeys.all(user.activeOrganizationId),
        }),
        queryClient.invalidateQueries({ queryKey: timeEntriesKeys.root() }),
      ]);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: timeTimersKeys.all(user.activeOrganizationId, user.id),
      });
    },
    onError: (error) => analytics.captureError(error),
  });
};
