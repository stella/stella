import { BROWSER_CONTROL_OWNER_STORAGE_KEY } from "./storage-keys";

/**
 * Who holds the browser, as stored: a desktop chat by its id, or the paired
 * web connection when there is no record. Read by every module whose rules
 * differ between the two; only `control-owner` changes it.
 */

export const CONTROL_TRANSPORT = {
  desktop: "desktop",
  web: "web",
} as const;

export type ControlTransport =
  (typeof CONTROL_TRANSPORT)[keyof typeof CONTROL_TRANSPORT];

/** Who takes the browser: a desktop chat by its id, or the web connection. */
export type ControlHolder =
  | { transport: typeof CONTROL_TRANSPORT.desktop; controllerId: string }
  | { transport: typeof CONTROL_TRANSPORT.web };

/** The desktop chat holding the browser; `null` while the web connection does. */
export const readControlOwner = async (): Promise<string | null> => {
  const stored = await chrome.storage.session.get(
    BROWSER_CONTROL_OWNER_STORAGE_KEY,
  );
  const owner: unknown = stored[BROWSER_CONTROL_OWNER_STORAGE_KEY];
  return typeof owner === "string" ? owner : null;
};

export const readControlHolder = async (): Promise<ControlHolder> => {
  const owner = await readControlOwner();
  return owner === null
    ? { transport: CONTROL_TRANSPORT.web }
    : { controllerId: owner, transport: CONTROL_TRANSPORT.desktop };
};
