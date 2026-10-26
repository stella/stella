import { TaggedError } from "better-result";

import { declareFingerprintFields } from "@stll/errors";

export class MissingFingerprint extends TaggedError("MissingFingerprint")<{
  message: string;
  // oxlint-disable-next-line require-fingerprint-fields/require-fingerprint-fields -- fixture proves a typed reason requires registration
  reason: "read" | "write";
}> {}

// expect-clean: require-fingerprint-fields/require-fingerprint-fields
export class RegisteredFingerprint extends TaggedError(
  "RegisteredFingerprint",
)<{
  message: string;
  reason: "read" | "write";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

// expect-clean: require-fingerprint-fields/require-fingerprint-fields
export class RegisteredStructuredFingerprint extends TaggedError(
  "RegisteredStructuredFingerprint",
)<{
  message: string;
  reason: { kind: "read" | "write"; detail: string };
}> {
  static {
    declareFingerprintFields(this, ["reason.kind"]);
  }
}
