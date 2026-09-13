/**
 * Which inspector a public law route docks, if any.
 *
 * The rail is part of the shell, not something a tab summons: a reader on any
 * /law route can see that a panel is there and open it, the same way a matter
 * always shows its rail. Only the case reader, which docks an inspector of its
 * own, yields — two docks would sit on top of each other.
 */

export type PublicLawInspectorPresence =
  /** The case reader owns the dock on this route. */
  | "none"
  /** The workspace inspector, for a reader with a session. */
  | "session"
  /** The registry-view dock, for a reader without one. */
  | "anonymous";

export const publicLawInspectorPresence = ({
  caseReaderOwnsDock,
  hasSession,
}: {
  caseReaderOwnsDock: boolean;
  hasSession: boolean;
}): PublicLawInspectorPresence => {
  if (caseReaderOwnsDock) {
    return "none";
  }
  return hasSession ? "session" : "anonymous";
};
