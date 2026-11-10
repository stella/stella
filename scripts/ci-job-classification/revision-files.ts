import { AdmissionError } from "./yaml";

const NEWLINE = 0x0a;

// One `git cat-file --batch` reads every requested file at a revision. A
// `git show` per file costs a process and a repository open each, which made
// reading the ~1,000 decision files at a base revision take minutes.
// Returns only the files that exist; a missing file is absent from the map.
export const readFilesAtRevision = (
  root: string,
  revision: string,
  files: readonly string[],
): Map<string, string> => {
  const contents = new Map<string, string>();
  // --batch reads one object name per line, so a name with a newline cannot
  // be asked for. Callers read such a file on their own.
  const requested = [...new Set(files)].filter((file) => !file.includes("\n"));
  if (requested.length === 0) {
    return contents;
  }
  const result = Bun.spawnSync(["git", "-C", root, "cat-file", "--batch"], {
    stdin: new TextEncoder().encode(
      requested.map((file) => `${revision}:${file}\n`).join(""),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new AdmissionError({
      message:
        new TextDecoder().decode(result.stderr).trim() ||
        `git cat-file --batch failed at ${revision}`,
    });
  }
  const output = result.stdout;
  const decoder = new TextDecoder();
  let position = 0;
  for (const file of requested) {
    const headerEnd = output.indexOf(NEWLINE, position);
    if (headerEnd === -1) {
      throw new AdmissionError({
        message: `git cat-file --batch ended early at ${revision}:${file}`,
      });
    }
    const header = decoder.decode(output.subarray(position, headerEnd));
    position = headerEnd + 1;
    // "<name> missing" or "<name> ambiguous": no content follows.
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
      continue;
    }
    const match = /^[0-9a-f]+ ([a-z]+) ([0-9]+)$/u.exec(header);
    if (!match) {
      throw new AdmissionError({
        message: `Unexpected git cat-file header: ${header}`,
      });
    }
    const type = match[1];
    const size = Number(match[2]);
    if (type === "blob") {
      contents.set(
        file,
        decoder.decode(output.subarray(position, position + size)),
      );
    }
    position += size + 1;
  }
  return contents;
};
