/** Read at the point of use: a retained editor may be destroyed after an await. */
export const getLiveEditor = <T extends { readonly isDestroyed: boolean }>(
  editor: T | null | undefined,
): T | null =>
  editor === null || editor === undefined || editor.isDestroyed ? null : editor;
