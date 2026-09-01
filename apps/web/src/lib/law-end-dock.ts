/**
 * Width of the case reader's docked inspector, published on the root element
 * while the dock is mounted. The law shell's full-window top bar pads its
 * inline-end by it so bar actions stay visible beside the dock.
 *
 * The consuming Tailwind class in public-law-shell.tsx repeats the literal
 * name (statically scanned classes cannot interpolate this constant); a
 * rename must update both.
 */
export const LAW_END_DOCK_WIDTH_VAR = "--law-end-dock-width";
