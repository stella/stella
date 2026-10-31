export type MatterListStatus = "active" | "archived";

export const isMatterInStatusView = (status: string, view: MatterListStatus) =>
  status === view;

export const matterRouteView = (status: string) => {
  switch (status) {
    case "active":
      return "active";
    case "archived":
      return "archived-read-only";
    default:
      return "unavailable";
  }
};

export const matterCardDragMode = (
  status: string,
  canReassignClient: boolean,
): "client-group" | "none" =>
  status === "active" && canReassignClient ? "client-group" : "none";
