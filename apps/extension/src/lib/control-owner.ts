import {
  BROWSER_CONTROL_ACTION,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";

import {
  BROWSER_CONTROL_OWNER_STORAGE_KEY,
  BROWSER_CONTROLLED_TAB_STORAGE_KEY,
} from "./storage-keys";
import { releaseContainedTabs } from "./tab-containment";

/**
 * Which controller holds the browser: its controlled tab and every tab kept
 * contained are that controller's alone. One controller at a time, so a
 * controller can only ever list, switch to or act on its own tabs: every
 * other one is refused before its command runs.
 *
 * No record means the paired web connection holds it, as it did before any
 * desktop chat took over; pairing again (or ending the pairing) clears the
 * record. A desktop chat takes the browser over only with a page it is about
 * to open, and the member takes it back for the web connection by pairing
 * or handing a tab over from the popup.
 */

export const CONTROL_TRANSPORT = {
  desktop: "desktop",
  web: "web",
} as const;

type ControlTransport =
  (typeof CONTROL_TRANSPORT)[keyof typeof CONTROL_TRANSPORT];

const readControlOwner = async (): Promise<string | null> => {
  const stored = await chrome.storage.session.get(
    BROWSER_CONTROL_OWNER_STORAGE_KEY,
  );
  const owner: unknown = stored[BROWSER_CONTROL_OWNER_STORAGE_KEY];
  return typeof owner === "string" ? owner : null;
};

/** Whether `controllerId` holds the browser now. */
const holdsControl = async (
  controllerId: string,
  transport: ControlTransport,
): Promise<boolean> => {
  const owner = await readControlOwner();
  return owner === null
    ? transport === CONTROL_TRANSPORT.web
    : owner === controllerId;
};

export const CONTROL_ADMISSION = {
  /** The controller holds the browser: the command runs. */
  holds: "holds",
  /** A desktop chat's `open`: it runs and, unrefused, takes the browser. */
  takesOver: "takes-over",
  /** Another controller holds the browser: nothing runs or is listed. */
  refused: "refused",
} as const;

type ControlAdmission =
  (typeof CONTROL_ADMISSION)[keyof typeof CONTROL_ADMISSION];

/**
 * Whether a command may run for `controllerId`. A web connection that lost
 * the browser to a desktop chat is refused outright, whatever it asks (a
 * new tab, a tab switch, a read), until the member gives it back. A desktop
 * chat without the browser may only open a page, which takes it over.
 */
export const admitControl = async ({
  action,
  controllerId,
  transport,
}: {
  action: BrowserControlCommand["action"];
  controllerId: string;
  transport: ControlTransport;
}): Promise<ControlAdmission> => {
  if (await holdsControl(controllerId, transport)) {
    return CONTROL_ADMISSION.holds;
  }
  return transport === CONTROL_TRANSPORT.desktop &&
    action === BROWSER_CONTROL_ACTION.open
    ? CONTROL_ADMISSION.takesOver
    : CONTROL_ADMISSION.refused;
};

/**
 * Hands the browser to `controllerId`: the previous holder's controlled tab
 * stops being controlled and every contained tab goes back to the member,
 * then the new holder is recorded. Called only as the last step of a
 * takeover that nothing refused, so a refusal never changes the previous
 * holder's tabs or their rules.
 */
export const takeOverControl = async (controllerId: string): Promise<void> => {
  await chrome.storage.session.remove(BROWSER_CONTROLLED_TAB_STORAGE_KEY);
  await releaseContainedTabs();
  await chrome.storage.session.set({
    [BROWSER_CONTROL_OWNER_STORAGE_KEY]: controllerId,
  });
};
