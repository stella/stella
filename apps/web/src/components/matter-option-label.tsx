import { BidiText } from "@stll/ui/bidi-text";

import { MatterIcon } from "@/components/matter-icon";

export type MatterOptionLabelMatter = {
  clientName?: string | null | undefined;
  color: string | null;
  id: string;
  name: string;
};

/**
 * How a matter reads wherever people pick one: its coloured icon, its name,
 * then its client, quietly. Every option that lists a matter (combobox,
 * select, menu, command palette) renders this, so the colour that tells
 * matters apart is never missing from a picker. Enforced by
 * `.oxlint-plugins/require-matter-option-label.ts`.
 */
export const MatterOptionLabel = ({
  matter,
}: {
  matter: MatterOptionLabelMatter;
}) => (
  <span className="flex min-w-0 items-center gap-2">
    <MatterIcon
      className="size-4 shrink-0"
      matter={{ id: matter.id, color: matter.color }}
    />
    <BidiText className="truncate">{matter.name}</BidiText>
    {matter.clientName === null || matter.clientName === undefined ? null : (
      <span className="text-muted-foreground min-w-0 truncate text-xs">
        <BidiText>{matter.clientName}</BidiText>
      </span>
    )}
  </span>
);
