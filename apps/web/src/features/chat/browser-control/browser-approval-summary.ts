import {
  BROWSER_CONTROL_ACTION,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";

export type BrowserApprovalDetail = {
  type: "key" | "target" | "value" | "website";
  value: string;
};

export const getBrowserApprovalDetails = (
  command: BrowserControlCommand,
): BrowserApprovalDetail[] => {
  switch (command.action) {
    case BROWSER_CONTROL_ACTION.open:
      return [{ type: "website", value: command.url }];
    case BROWSER_CONTROL_ACTION.click:
      return [
        { type: "website", value: command.page.url },
        {
          type: "target",
          value: `${command.target.name} (${command.target.role})`,
        },
      ];
    case BROWSER_CONTROL_ACTION.fill:
    case BROWSER_CONTROL_ACTION.select:
      return [
        { type: "website", value: command.page.url },
        {
          type: "target",
          value: `${command.target.name} (${command.target.role})`,
        },
        { type: "value", value: command.value },
      ];
    case BROWSER_CONTROL_ACTION.pressKey:
      return [
        { type: "website", value: command.page.url },
        {
          type: "target",
          value: `${command.target.name} (${command.target.role})`,
        },
        { type: "key", value: command.key },
      ];
    case BROWSER_CONTROL_ACTION.goBack:
    case BROWSER_CONTROL_ACTION.snapshot:
      return [];
    default:
      command satisfies never;
      return [];
  }
};
