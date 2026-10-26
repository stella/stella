export class TrackedPathEnumerationError extends Error {
  override name = "TrackedPathEnumerationError";
  readonly _tag = "TrackedPathEnumerationError";
}

type ReadTrackedPathsResult = {
  paths: string[];
  decodingError?: unknown;
  unterminatedPath?: string;
};

export const collectTrackedPaths = async (
  stdout: ReadableStream<Uint8Array>,
): Promise<ReadTrackedPathsResult> => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths: string[] = [];
  let pending = "";
  let decodingError: unknown;

  for await (const chunk of stdout) {
    if (decodingError !== undefined) {
      continue;
    }
    try {
      pending += decoder.decode(chunk, { stream: true });
      let separator = pending.indexOf("\0");
      while (separator !== -1) {
        const file = pending.slice(0, separator);
        if (file !== "") {
          paths.push(file);
        }
        pending = pending.slice(separator + 1);
        separator = pending.indexOf("\0");
      }
    } catch (error) {
      decodingError = error;
      pending = "";
    }
  }

  if (decodingError === undefined) {
    try {
      pending += decoder.decode();
    } catch (error) {
      decodingError = error;
      pending = "";
    }
  }

  return {
    paths,
    ...(decodingError === undefined ? {} : { decodingError }),
    ...(pending === "" ? {} : { unterminatedPath: pending }),
  };
};

export const readTrackedPaths = async (root: string): Promise<string[]> => {
  const child = Bun.spawn(["git", "ls-files", "-z"], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [inventory, stderr, exitCode] = await Promise.all([
    collectTrackedPaths(child.stdout),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (exitCode !== 0) {
    throw new TrackedPathEnumerationError(
      JSON.stringify({
        message: "Cannot read tracked paths",
        exitCode,
        stderr,
      }),
    );
  }
  if (inventory.decodingError !== undefined) {
    throw new TrackedPathEnumerationError(
      `Tracked path list is not valid UTF-8: ${String(inventory.decodingError)}`,
    );
  }
  if (inventory.unterminatedPath !== undefined) {
    throw new TrackedPathEnumerationError(
      `Tracked path list is not NUL-terminated: ${inventory.unterminatedPath}`,
    );
  }

  return inventory.paths;
};
