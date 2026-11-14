import { env } from "@/api/env";

/** What signs APNs provider tokens: Apple's key id, team id and `.p8` key. */
export type ApnsCredentials = {
  keyId: string;
  teamId: string;
  privateKeyPem: string;
};

type ApnsSettings = {
  APNS_KEY_ID?: string | undefined;
  APNS_TEAM_ID?: string | undefined;
  APNS_PRIVATE_KEY?: string | undefined;
};

/**
 * The configured credentials, or null when mobile push is off. The env
 * invariant refuses a partial set at startup, so null means none was given.
 * A PEM pasted into a single-line secret often carries escaped newlines;
 * they are restored so the key parses.
 */
export const readApnsCredentials = (
  settings: ApnsSettings = env,
): ApnsCredentials | null => {
  const {
    APNS_KEY_ID: keyId,
    APNS_TEAM_ID: teamId,
    APNS_PRIVATE_KEY: privateKey,
  } = settings;
  if (keyId === undefined || teamId === undefined || privateKey === undefined) {
    return null;
  }
  return {
    keyId,
    teamId,
    privateKeyPem: privateKey.replaceAll("\\n", "\n").trim(),
  };
};

/** Whether alerts are sent at all. */
export const isMobilePushConfigured = (settings: ApnsSettings = env): boolean =>
  readApnsCredentials(settings) !== null;
