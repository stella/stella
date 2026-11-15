type VerificationDecisionModelSwitchInput = {
  setting: { enabled: boolean; available: boolean };
  canEdit: boolean;
  pending: boolean;
};

/**
 * How the Anchor Verification decision model switch shows. It shows the
 * stored value. Turning it on needs a reachable decision model; turning it
 * off never does, so a switch left on after the model went away can still
 * be turned off. `unavailable` says why it cannot be turned on.
 */
export const verificationDecisionModelSwitch = ({
  setting,
  canEdit,
  pending,
}: VerificationDecisionModelSwitchInput) => ({
  checked: setting.enabled,
  disabled: !canEdit || pending || (!setting.available && !setting.enabled),
  unavailable: !setting.available,
});
