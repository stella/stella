// Passive regression fixture for `no-raw-context-menu/no-raw-context-menu`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

declare const open: () => void;
declare const host: HTMLElement;
declare const Picker: (props: { trigger: "click" | "contextmenu" }) => null;

// --- Flagged: a hand-written right-click handler ---
export const _a = () => (
  // oxlint-disable-next-line no-raw-context-menu/no-raw-context-menu
  <div onContextMenu={open}>Smlouva o dílo</div>
);
export const _b = () => (
  // oxlint-disable-next-line no-raw-context-menu/no-raw-context-menu
  <div onContextMenuCapture={open}>Smlouva o dílo</div>
);
// oxlint-disable-next-line no-raw-context-menu/no-raw-context-menu
export const _c = { onContextMenu: open };
// oxlint-disable-next-line no-raw-context-menu/no-raw-context-menu
host.addEventListener("contextmenu", open);

// --- Accepted: types, destructuring, other events, a custom trigger prop ---
type RowProps = { onContextMenu?: () => void };
export const _d = ({ onContextMenu }: RowProps) => onContextMenu;
host.addEventListener("click", open);
export const _e = () => <Picker trigger="contextmenu" />;
