import * as v from "valibot";

const emailSchema = v.pipe(
  v.string(),
  v.trim(),
  v.email("Enter a valid email address."),
);

const otpSchema = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^\d{6}$/u, "Enter the six-digit code."),
);

export const parseSignInEmail = (value: unknown) => v.parse(emailSchema, value);
export const parseEmailOtp = (value: unknown) => v.parse(otpSchema, value);
