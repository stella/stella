// Best-effort system-browser launch. Never throws: the printed URL is always
// the fallback (see `login.ts`), so a failure here is not fatal.

const OPEN_TIMEOUT_MS = 5000;

const openCommandFor = (
  platform: NodeJS.Platform,
): readonly string[] | undefined => {
  if (platform === "darwin") {
    return ["open"];
  }
  if (platform === "win32") {
    return ["cmd", "/c", "start", ""];
  }
  return ["xdg-open"];
};

export const openInBrowser = async (url: string): Promise<boolean> => {
  const command = openCommandFor(process.platform);
  if (!command) {
    return false;
  }

  try {
    const proc = Bun.spawn([...command, url], {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exited = await Promise.race([
        proc.exited,
        new Promise<number>((resolve) => {
          timer = setTimeout(() => resolve(-1), OPEN_TIMEOUT_MS);
        }),
      ]);
      return exited === 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
};
