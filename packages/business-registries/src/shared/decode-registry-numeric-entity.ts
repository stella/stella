/** Preserve the printed entity unless it names a nonzero Unicode scalar. */
export const decodeRegistryNumericEntity = (entity: string): string => {
  const hexadecimal = entity.slice(2, 3).toLowerCase() === "x";
  const radix = hexadecimal ? 16 : 10;
  const value = Number.parseInt(entity.slice(hexadecimal ? 3 : 2, -1), radix);
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 0x10_ff_ff ||
    (value >= 0xd8_00 && value <= 0xdf_ff)
  ) {
    return entity;
  }
  return String.fromCodePoint(value);
};
