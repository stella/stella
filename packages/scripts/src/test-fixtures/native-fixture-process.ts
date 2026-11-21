import { panic } from "better-result";

export const quoteWindowsFixtureArgument = (arg: string) => {
  const parts = ['"'];
  let backslashes = 0;
  for (const character of arg) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    // Quotes consume doubled backslashes plus their own escape; ordinary
    // characters preserve the run. Each input character is visited once.
    parts.push(
      "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes),
      character,
    );
    backslashes = 0;
  }
  // Double the trailing run so it cannot escape the closing quote.
  parts.push("\\".repeat(backslashes * 2), '"');
  return parts.join("");
};

// Bun gives its spawned children a nested kill-on-close job. Native fixture
// descendants inherit only the surrounding jobs, so leader exit really leaves
// an orphan for the invocation owner to measure and terminate.
export const spawnWindowsFixtureProcess = async (args: string[]) => {
  const { dlopen, FFIType } = await import("bun:ffi");
  const library = dlopen("kernel32.dll", {
    CreateProcessW: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.i32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  } as const);
  const wide = (value: string) => Buffer.from(`${value}\0`, "utf16le");
  const command = [process.execPath, ...args]
    .map(quoteWindowsFixtureArgument)
    .join(" ");
  const startup = new Uint8Array(104);
  new DataView(startup.buffer).setUint32(0, startup.byteLength, true);
  const information = new Uint8Array(24);
  const created = library.symbols.CreateProcessW(
    wide(process.execPath),
    wide(command),
    null,
    null,
    0,
    0,
    null,
    null,
    startup,
    information,
  );
  if (created === 0) {
    panic(
      `Native fixture spawn failed: Windows error ${library.symbols.GetLastError()}`,
    );
  }
  const view = new DataView(information.buffer);
  const pid = view.getUint32(16, true);
  library.symbols.CloseHandle(view.getBigUint64(0, true));
  library.symbols.CloseHandle(view.getBigUint64(8, true));
  library.close();
  return pid;
};

export const exitFixtureLeader = async () => {
  if (process.platform !== "win32") {
    process.exit(0);
  }
  // Exercise kernel ownership after native leader exit, without Bun's own
  // shutdown cleanup terminating the descendants before the assertion.
  const { dlopen, FFIType } = await import("bun:ffi");
  const library = dlopen("kernel32.dll", {
    ExitProcess: { args: [FFIType.u32], returns: FFIType.void },
  } as const);
  library.symbols.ExitProcess(0);
};
