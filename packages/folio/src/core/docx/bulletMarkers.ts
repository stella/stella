const SYMBOL_BULLET_MAP: Record<number, string> = {
  0x00_b7: "\u2022",
  0x00_6f: "\u25cb",
  0x00_a7: "\u25a0",
  0x00_fc: "\u2713",
  0x00_6e: "\u25a0",
  0x00_71: "\u25cb",
  0x00_75: "\u25c6",
  0x00_76: "\u2756",
  0x00_a8: "\u2713",
  0x00_fb: "\u2713",
  0x00_fe: "\u2713",
  0xf0_b7: "\u2022",
  0xf0_6e: "\u25a0",
  0xf0_6f: "\u25cb",
  0xf0_a7: "\u25a0",
  0xf0_fc: "\u2713",
  0x20_22: "\u2022",
  0x25_cf: "\u25cf",
  0x25_cb: "\u25cb",
  0x25_a0: "\u25a0",
  0x25_a1: "\u25a1",
  0x25_c6: "\u25c6",
  0x25_c7: "\u25c7",
  0x20_13: "\u2013",
  0x20_14: "\u2014",
  0x00_3e: ">",
  0x00_2d: "-",
};

export const convertBulletToUnicode = (bulletChar: string): string => {
  if (!bulletChar || bulletChar.trim() === "") {
    return "\u2022";
  }

  const charCode = bulletChar.codePointAt(0);
  if (charCode === undefined) {
    return "\u2022";
  }

  const mapped = SYMBOL_BULLET_MAP[charCode];
  if (mapped !== undefined) {
    return mapped;
  }

  if (charCode >= 0xe0_00 && charCode <= 0xf8_ff) {
    return "\u2022";
  }

  if (charCode < 32 || (charCode >= 127 && charCode < 160)) {
    return "\u2022";
  }

  return bulletChar;
};
