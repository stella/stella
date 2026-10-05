/** File tiles a stack draws before folding the rest into one "+N" tile. */
export const CHAT_FILE_STACK_MAX_TILES = 3;

export type FileStackLayout<TFile> = {
  /** Drawn as file-type tiles, in the server's order (newest first). */
  tiles: TFile[];
  /** Files beyond the tiles: the "+N" tile. Zero hides it. */
  overflowCount: number;
  /** Named by the server but not drawn as a tile; listed in the tooltip. */
  unnamedCount: number;
  /** Every file the thread attached. Zero renders nothing. */
  total: number;
};

/**
 * Splits a thread's attached files into the tiles a stack draws and the
 * "+N" beyond them. A count lower than the named files is treated as their
 * number, so a stale count can never produce a negative "+N".
 */
export const layoutFileStack = <TFile>({
  fileCount,
  files,
}: {
  fileCount: number;
  files: readonly TFile[];
}): FileStackLayout<TFile> => {
  const total = Math.max(fileCount, files.length);
  const tiles = files.slice(0, CHAT_FILE_STACK_MAX_TILES);
  return {
    overflowCount: total - tiles.length,
    tiles,
    total,
    unnamedCount: total - files.length,
  };
};
