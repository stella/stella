/**
 * The DOS (OEM) code pages a Windows program writes when it uses the console
 * code page rather than the ANSI one: code page 437 in the United States and
 * Western Europe, 852 in Central Europe. ZIP archives name their files in the
 * OEM code page unless they set the UTF-8 flag.
 *
 * The WHATWG Encoding Standard, and so the platform's TextDecoder, has
 * neither, so each upper half is written out here, as the Unicode
 * Consortium's mapping files give it (VENDORS/MICSFT/PC/CP437.TXT and
 * CP852.TXT). The lower half is ASCII in both.
 */

export const DOS_CODE_PAGES = ["ibm437", "ibm852"] as const;

export type DosCodePage = (typeof DOS_CODE_PAGES)[number];

/** The characters of bytes 0x80 to 0xFF, in byte order. */
const UPPER_HALF: Readonly<Record<DosCodePage, string>> = {
  ibm437:
    "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
    "áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
    "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
    "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ",
  ibm852:
    "ÇüéâäůćçłëŐőîŹÄĆÉĹĺôöĽľŚśÖÜŤťŁ×č" +
    "áíóúĄąŽžĘę¬źČş«»░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐" +
    "└┴┬├─┼Ăă╚╔╩╦╠═╬¤đĐĎËďŇÍÎě┘┌█▄ŢŮ▀" +
    "ÓßÔŃńňŠšŔÚŕŰýÝţ´­˝˛ˇ˘§÷¸°¨˙űŘř■ ",
};

const tables = new Map<DosCodePage, readonly string[]>();

const upperHalf = (codePage: DosCodePage): readonly string[] => {
  const cached = tables.get(codePage);
  if (cached !== undefined) {
    return cached;
  }
  const table = Array.from(UPPER_HALF[codePage]);
  tables.set(codePage, table);
  return table;
};

/**
 * The bytes `text` is written as in a DOS code page, as a program on that
 * code page writes it, or null when the code page cannot hold it.
 */
export const encodeDosCodePage = (
  text: string,
  codePage: DosCodePage,
): Uint8Array | null => {
  const high = upperHalf(codePage);
  const bytes: number[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    const index = codePoint < 0x80 ? -1 : high.indexOf(char);
    if (codePoint >= 0x80 && index === -1) {
      return null;
    }
    bytes.push(codePoint < 0x80 ? codePoint : 0x80 + index);
  }
  return Uint8Array.from(bytes);
};

/** Bytes read in a DOS code page; every byte value has a character. */
export const decodeDosCodePage = (
  bytes: Uint8Array,
  codePage: DosCodePage,
): string => {
  const high = upperHalf(codePage);
  let text = "";
  for (const byte of bytes) {
    text +=
      byte < 0x80 ? String.fromCodePoint(byte) : (high[byte - 0x80] ?? "");
  }
  return text;
};
