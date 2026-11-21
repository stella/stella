/** Reviewed doctrinal acts, independent of citation stance. Null in storage means unread. */
export const DOCTRINAL_TREATMENTS = [
  "distinguishes",
  "limits",
  "not_stated",
] as const;

export type DoctrineTreatment = (typeof DOCTRINAL_TREATMENTS)[number];

/** Each reading requires the court speaking in its own words, not a party submission. */
export const DOCTRINE_GUIDANCE = {
  distinguishes:
    "The court explains why the cited precedent does not apply to this case because the material facts or legal issue differ. Require a verbatim quote stating the distinction in the court’s own words.",
  limits:
    "The court narrows the scope of the cited precedent or restricts the reach of its rule. Require a verbatim quote stating that restriction in the court’s own words.",
  not_stated:
    "The reviewed passage does not state either doctrinal act. This is not a finding that the court followed the precedent; agreement, criticism, or a party’s argument alone does not establish either act.",
} as const satisfies Record<DoctrineTreatment, string>;
