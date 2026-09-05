import {
  BROWSER_CONTROL_ACTION,
  type BrowserControlCommand,
  type BrowserControlElementCommand,
} from "@stll/api-contract/browser-control";

export type BrowserApprovalDetail = {
  type: "key" | "link" | "target" | "value" | "website";
  value: string;
};

const targetDetails = ({
  page,
  target,
}: BrowserControlElementCommand): BrowserApprovalDetail[] => [
  { type: "website", value: page.url },
  { type: "target", value: `${target.name} (${target.role})` },
  ...(target.href === undefined
    ? []
    : [{ type: "link", value: target.href } satisfies BrowserApprovalDetail]),
];

export const getBrowserApprovalDetails = (
  command: BrowserControlCommand,
): BrowserApprovalDetail[] => {
  switch (command.action) {
    case BROWSER_CONTROL_ACTION.open:
      return [{ type: "website", value: command.url }];
    case BROWSER_CONTROL_ACTION.click:
      return targetDetails(command);
    case BROWSER_CONTROL_ACTION.fill:
    case BROWSER_CONTROL_ACTION.select:
      return [
        ...targetDetails(command),
        { type: "value", value: command.value },
      ];
    case BROWSER_CONTROL_ACTION.pressKey:
      return [...targetDetails(command), { type: "key", value: command.key }];
    case BROWSER_CONTROL_ACTION.goBack:
    case BROWSER_CONTROL_ACTION.snapshot:
      return [];
    default:
      command satisfies never;
      return [];
  }
};
