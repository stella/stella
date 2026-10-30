import { panic } from "better-result";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_TARGET_METADATA,
  type BrowserControlCommand,
  type BrowserControlElementCommand,
  type BrowserControlTargetMetadata,
} from "@stll/api-contract/browser-control";

export type BrowserApprovalDetail = {
  type: "context" | "key" | "link" | "target" | "value" | "website";
  value: string;
};

const targetMetadataDetail = (
  type: "context" | "link",
  metadata: BrowserControlTargetMetadata,
): BrowserApprovalDetail[] => {
  switch (metadata.type) {
    case BROWSER_CONTROL_TARGET_METADATA.absent:
      return [];
    case BROWSER_CONTROL_TARGET_METADATA.present:
      return [{ type, value: metadata.value }];
    default:
      metadata satisfies never;
      return panic("Unhandled browser target metadata");
  }
};

const targetDetails = ({
  page,
  target,
}: BrowserControlElementCommand): BrowserApprovalDetail[] => [
  { type: "website", value: page.url },
  { type: "target", value: `${target.name} (${target.role})` },
  ...targetMetadataDetail("context", target.context),
  ...targetMetadataDetail("link", target.href),
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
      return panic("Unhandled browser command action");
  }
};
