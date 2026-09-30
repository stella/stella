/** A comparison key only; the publisher's spelling remains on the decision. */
export const decisionTypeKey = (stated: string | null | undefined) =>
  stated?.normalize("NFC").trim().toLowerCase() || undefined;
