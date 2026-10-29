// The switch's contract, shared by its two renderers: the web's
// (./switch.tsx, through Base UI) and React Native's (./switch.native.tsx,
// the platform's switch).

/** The props every switch renderer accepts, with one meaning. */
export type SwitchContract = {
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};
