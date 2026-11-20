import {
  BROWSER_CONTROL_ACTION,
  BROWSER_DESKTOP_KEYS,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";

/**
 * Whether a coding agent on this computer may ask for each action. It runs
 * under the same containment, tab ownership, sign-in handoff and budget as
 * every other command; an action the contract adds is refused from stella
 * desktop until it is decided here.
 */
const DESKTOP_ACTIONS: Readonly<
  Record<BrowserControlCommand["action"], boolean>
> = {
  [BROWSER_CONTROL_ACTION.click]: true,
  [BROWSER_CONTROL_ACTION.fill]: true,
  [BROWSER_CONTROL_ACTION.find]: true,
  [BROWSER_CONTROL_ACTION.goBack]: true,
  [BROWSER_CONTROL_ACTION.open]: true,
  [BROWSER_CONTROL_ACTION.pressKey]: true,
  [BROWSER_CONTROL_ACTION.select]: true,
  [BROWSER_CONTROL_ACTION.snapshot]: true,
  [BROWSER_CONTROL_ACTION.switchTab]: true,
};

const DESKTOP_KEYS: ReadonlySet<string> = new Set(BROWSER_DESKTOP_KEYS);

/**
 * Why the extension refuses `command` from stella desktop, or `null` when it
 * runs it: an action not decided for desktop, or a key outside the few an
 * agent there may press.
 */
export const desktopCommandRefusal = (
  command: BrowserControlCommand,
): string | null => {
  if (!DESKTOP_ACTIONS[command.action]) {
    return `stella desktop cannot ask for ${command.action}.`;
  }
  if (
    command.action === BROWSER_CONTROL_ACTION.pressKey &&
    !DESKTOP_KEYS.has(command.key)
  ) {
    return `stella desktop presses only ${BROWSER_DESKTOP_KEYS.join(", ")}.`;
  }
  return null;
};
