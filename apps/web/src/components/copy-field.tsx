import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/input-group";

import { CopyActionButton } from "@/components/copy-action-button";

type CopyFieldProps = {
  label: string;
  value: string;
};

/** A read-only value with a copy-to-clipboard button, used for the MCP
 * server URL and CLI commands on the connections settings page and in
 * the onboarding setup preview. */
export const CopyField = ({ label, value }: CopyFieldProps) => (
  <div className="flex flex-col gap-1">
    <span className="text-muted-foreground text-xs">{label}</span>
    <InputGroup>
      <InputGroupInput className="font-mono text-sm" readOnly value={value} />
      <InputGroupAddon align="inline-end">
        <CopyActionButton
          iconClassName="size-4"
          iconOnly
          size="icon-sm"
          text={value}
          variant="ghost"
        />
      </InputGroupAddon>
    </InputGroup>
  </div>
);
