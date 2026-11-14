import { buildCompoundFile } from "@/api/lib/files/compound-file.test-fixture";

type DocPiece = { text: string; wide?: boolean };

export const legacyWordFile = (
  ranges: readonly string[],
  piecesInput?: readonly DocPiece[],
  extraStreams: { path: string[]; bytes: Uint8Array }[] = [],
): Uint8Array => {
  const pieces = piecesInput ?? [{ text: ranges.join("") }];
  const word = new Uint8Array(2048);
  const fib = new DataView(word.buffer);
  fib.setUint16(0, 0xa5_ec, true);
  for (const [index, range] of ranges.entries()) {
    fib.setUint32(76 + index * 4, range.length, true);
  }

  const pieceCount = pieces.length;
  const plcBytes = 4 + pieceCount * 12;
  const table = new Uint8Array(5 + plcBytes);
  const tableView = new DataView(table.buffer);
  table[0] = 2;
  tableView.setUint32(1, plcBytes, true);
  fib.setUint32(418, 0, true);
  fib.setUint32(422, table.byteLength, true);

  let cp = 0;
  let wordOffset = 512;
  for (const [index, piece] of pieces.entries()) {
    tableView.setUint32(5 + index * 4, cp, true);
    const bytes = piece.wide
      ? new Uint8Array(Buffer.from(piece.text, "utf16le"))
      : new Uint8Array(Buffer.from(piece.text, "latin1"));
    const pcdOffset = 5 + (pieceCount + 1) * 4 + index * 8;
    tableView.setUint32(
      pcdOffset + 2,
      piece.wide ? wordOffset : 0x40_00_00_00 + wordOffset * 2,
      true,
    );
    word.set(bytes, wordOffset);
    wordOffset += bytes.byteLength;
    cp += piece.text.length;
  }
  tableView.setUint32(5 + pieceCount * 4, cp, true);
  return buildCompoundFile([
    { path: ["WordDocument"], bytes: word },
    { path: ["0Table"], bytes: table },
    ...extraStreams,
  ]);
};
