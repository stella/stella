// Passive regression fixture for `disabled-switch-needs-reason`.

import { Switch, SwitchField } from "@stll/ui/switch";

export const _flagged = ({ locked }: { locked: boolean }) => (
  <>
    <Switch
      // oxlint-disable-next-line disabled-switch-needs-reason/disabled-switch-needs-reason
      disabled
    />
    <SwitchField
      // oxlint-disable-next-line disabled-switch-needs-reason/disabled-switch-needs-reason
      disabled={locked}
      label="Require SSO"
    />
  </>
);

export const _allowed = ({ locked }: { locked: boolean }) => (
  <>
    <Switch
      // expect-clean: disabled-switch-needs-reason/disabled-switch-needs-reason
      disabled={false}
    />
    <Switch
      // expect-clean: disabled-switch-needs-reason/disabled-switch-needs-reason
      disabled={locked}
      disabledReason="Add a provider first"
    />
    <SwitchField
      // expect-clean: disabled-switch-needs-reason/disabled-switch-needs-reason
      disabled={locked}
      disabledReason="Only owners can change this"
      label="Require SSO"
    />
  </>
);
