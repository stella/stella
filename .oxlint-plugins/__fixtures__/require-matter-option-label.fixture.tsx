// Passive regression fixture for
// `require-matter-option-label/require-matter-option-label`.
//
// `oxlint-disable-next-line` directives below intentionally suppress cases
// the rule MUST flag. If the rule regresses, the disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI.

import { ComboboxItem } from "@stll/ui/combobox";
import { MenuItem } from "@stll/ui/menu";
import { SelectItem } from "@stll/ui/select";

import { MatterIcon } from "@/components/matter-icon";
import { MatterOptionLabel } from "@/components/matter-option-label";

const matter = { id: "matter_1", name: "Novák v. Horák", color: null };
const workspace = matter;
const group = { name: "Contracts" };
const workspaceName = matter.name;

// --- Cases the rule MUST flag ---

export const FlagBareComboboxMatter = () => (
  // oxlint-disable-next-line require-matter-option-label/require-matter-option-label
  <ComboboxItem value={matter}>{matter.name}</ComboboxItem>
);

export const FlagBareSelectWorkspace = () => (
  // oxlint-disable-next-line require-matter-option-label/require-matter-option-label
  <SelectItem value={workspace.id}>{workspace.name}</SelectItem>
);

export const FlagBareMenuWorkspaceName = () => (
  // oxlint-disable-next-line require-matter-option-label/require-matter-option-label
  <MenuItem>
    <span>{workspaceName}</span>
  </MenuItem>
);

// --- Cases the rule MUST NOT flag ---

// expect-clean: require-matter-option-label/require-matter-option-label
export const SharedLabel = () => (
  <ComboboxItem value={matter}>
    <MatterOptionLabel matter={matter} />
  </ComboboxItem>
);

// expect-clean: require-matter-option-label/require-matter-option-label
export const BespokeLayoutWithIcon = () => (
  <MenuItem>
    <MatterIcon matter={{ id: matter.id, color: matter.color }} />
    {matter.name}
  </MenuItem>
);

// expect-clean: require-matter-option-label/require-matter-option-label
export const NotAMatter = () => <MenuItem>{group.name}</MenuItem>;
