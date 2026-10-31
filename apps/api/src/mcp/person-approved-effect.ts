/**
 * An effect only a person may authorize, whatever the caller's permissions.
 * A handler config declares it (`personApprovedEffect`), the capability
 * catalog carries it, and the agent-access census fails while a capability
 * that declares one is not `person-approves` (`agent-access.ts`).
 */
export const PERSON_APPROVED_EFFECT = {
  /** Changes a compliance or security control, such as sanctions screening. */
  changesControl: "changes-control",
  /** Records that a person reviewed, approved or verified something. */
  recordsAttestation: "records-attestation",
  /** Hands out many records in one file or download. */
  exportsRecords: "exports-records",
} as const;

export type PersonApprovedEffect =
  (typeof PERSON_APPROVED_EFFECT)[keyof typeof PERSON_APPROVED_EFFECT];

const PERSON_APPROVED_EFFECTS: ReadonlySet<unknown> =
  new Set<PersonApprovedEffect>(Object.values(PERSON_APPROVED_EFFECT));

export const isPersonApprovedEffect = (
  value: unknown,
): value is PersonApprovedEffect => PERSON_APPROVED_EFFECTS.has(value);
