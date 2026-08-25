import {
  BROWSER_CONTROL_ACTION,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";

type SnapshotIdentity = {
  revision: string | null;
  url: string | null;
};

export const browserCommandMatchesSnapshot = (
  snapshot: SnapshotIdentity,
  currentTabUrl: string | undefined,
  command: BrowserControlCommand,
): boolean => {
  switch (command.action) {
    case BROWSER_CONTROL_ACTION.click:
    case BROWSER_CONTROL_ACTION.fill:
    case BROWSER_CONTROL_ACTION.pressKey:
    case BROWSER_CONTROL_ACTION.select:
      return (
        snapshot.revision === command.page.revision &&
        snapshot.url === command.page.url &&
        currentTabUrl === command.page.url
      );
    case BROWSER_CONTROL_ACTION.goBack:
    case BROWSER_CONTROL_ACTION.open:
    case BROWSER_CONTROL_ACTION.snapshot:
      return true;
    default:
      command satisfies never;
      return false;
  }
};
