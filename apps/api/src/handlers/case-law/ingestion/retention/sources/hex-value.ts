const HEX_DIGITS = "0123456789abcdef";

/**
 * The value of a hexadecimal token as publisher files spell one (an RTF
 * `\'hh` byte, a Word symbol's code point), or `undefined` for anything that
 * is not one: empty, longer than `maxDigits`, or holding a non-hex digit.
 */
export const hexValue = (
  token: string,
  maxDigits: number,
): number | undefined => {
  if (token.length === 0 || token.length > maxDigits) {
    return undefined;
  }
  let value = 0;
  for (const digit of token.toLowerCase()) {
    const digitValue = HEX_DIGITS.indexOf(digit);
    if (digitValue === -1) {
      return undefined;
    }
    value = value * 16 + digitValue;
  }
  return value;
};
