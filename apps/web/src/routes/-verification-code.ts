/**
 * The alphabet the API mints verification codes from: lowercase alphanumerics
 * without the characters that read alike in print (0/O, 1/l/I), ten of them.
 * A printed code is retyped by hand, so the shape is checked before it is
 * looked up: a segment that cannot be a code gets the same answer as a code
 * that resolves to nothing, without turning the app into a lookup probe.
 */
const VERIFICATION_CODE = /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/u;

export const isVerificationCode = (code: string): boolean =>
  VERIFICATION_CODE.test(code);
