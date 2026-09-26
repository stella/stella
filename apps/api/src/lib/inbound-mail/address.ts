import { Result, TaggedError } from "better-result";
import { randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export class InboundAddressError extends TaggedError("InboundAddressError")<{
  message: string;
}> {}

export const generateInboundAddressToken = () =>
  randomBytes(TOKEN_BYTES).toString("hex");

// Only an exact envelope recipient routes mail; display names, suffix matches,
// plus addressing, and sender-controlled To/Cc headers cannot select a matter.
export const parseInboundAddressToken = (
  recipient: string,
  inboundDomain: string,
) => {
  const parts = recipient.split("@");
  const token = parts.at(0);
  const domain = parts.at(1);
  if (
    parts.length !== 2 ||
    !token ||
    !TOKEN_PATTERN.test(token) ||
    domain?.toLowerCase() !== inboundDomain.toLowerCase()
  ) {
    return Result.err(
      new InboundAddressError({ message: "Invalid inbound recipient" }),
    );
  }
  return Result.ok(token);
};
