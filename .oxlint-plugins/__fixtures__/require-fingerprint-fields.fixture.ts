import { TaggedError } from "better-result";

import { declareFingerprintFields } from "@stll/errors";

export class MissingFingerprint extends TaggedError("MissingFingerprint")<{
  message: string;
  // oxlint-disable-next-line require-fingerprint-fields/require-fingerprint-fields -- fixture proves a typed reason requires registration
  reason: "read" | "write";
}> {}

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
