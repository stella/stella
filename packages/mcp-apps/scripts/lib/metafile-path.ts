import path from "node:path";

// No relative path joins two Windows drives, so Bun spells a file on another
// drive as its absolute path after the climb to the root (`../../C:/x.js`).
const OTHER_DRIVE = /^(?:\.\.?[\\/])+([A-Za-z]:[\\/].*)$/u;

/** The absolute file a Bun metafile path names, resolved from `base`. */
export const resolveMetafilePath = (
  file: string,
  base: string = process.cwd(),
): string => {
  const absolute = OTHER_DRIVE.exec(file)?.[1];
  if (absolute === undefined) {
    return path.resolve(base, file);
  }
  return path.isAbsolute(absolute) ? path.normalize(absolute) : absolute;
};
