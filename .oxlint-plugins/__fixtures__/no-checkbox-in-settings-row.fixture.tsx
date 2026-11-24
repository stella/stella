// Passive regression fixture for `no-checkbox-in-settings-row`.

import { Checkbox } from "@stll/ui/checkbox";
import { SettingsRow } from "@stll/ui/settings";
import { Switch } from "@stll/ui/switch";

export const _flagged = ({ on }: { on: boolean }) => (
  <SettingsRow title="Prompt caching">
    {/* oxlint-disable-next-line no-checkbox-in-settings-row/no-checkbox-in-settings-row */}
    <Checkbox checked={on} />
  </SettingsRow>
);

export const _allowed = ({ on }: { on: boolean }) => (
  <>
    <SettingsRow title="Prompt caching">
      {/* expect-clean: no-checkbox-in-settings-row/no-checkbox-in-settings-row */}
      <Switch checked={on} />
    </SettingsRow>
    <div>
      {/* expect-clean: no-checkbox-in-settings-row/no-checkbox-in-settings-row */}
      <Checkbox checked={on} />
    </div>
  </>
);
