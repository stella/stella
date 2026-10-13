import { Result, TaggedError } from "better-result";
import { dlopen, FFIType } from "bun:ffi";

// Windows x64/arm64 ABI: BASIC_LIMIT_INFORMATION (64), IO_COUNTERS (48),
// then four SIZE_Ts. HANDLEs are integers, never FFI virtual-address pointers.
const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
const PEAK_JOB_MEMORY_OFFSET = 136;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x20_00;
const PROCESS_SET_QUOTA_AND_TERMINATE = 0x01_01;

class WindowsProcessOwnershipError extends TaggedError(
  "WindowsProcessOwnershipError",
)<{
  message: string;
  cause?: unknown;
}> {}

const openWindowsJobLibrary = () =>
  dlopen("kernel32.dll", {
    CreateJobObjectW: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u64,
    },
    OpenProcess: {
      args: [FFIType.u32, FFIType.i32, FFIType.u32],
      returns: FFIType.u64,
    },
    AssignProcessToJobObject: {
      args: [FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
    SetInformationJobObject: {
      args: [FFIType.u64, FFIType.i32, FFIType.buffer, FFIType.u32],
      returns: FFIType.i32,
    },
    QueryInformationJobObject: {
      args: [
        FFIType.u64,
        FFIType.i32,
        FFIType.buffer,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    TerminateJobObject: {
      args: [FFIType.u64, FFIType.u32],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  } as const);
let jobLibrary: ReturnType<typeof openWindowsJobLibrary> | undefined;
const windowsJobApi = () => (jobLibrary ??= openWindowsJobLibrary()).symbols;
type NativeJobApi = ReturnType<typeof windowsJobApi>;
export type WindowsJobApi = {
  [Name in keyof NativeJobApi]: (
    ...args: Parameters<NativeJobApi[Name]>
  ) => ReturnType<NativeJobApi[Name]>;
};
export type WindowsProcessOwnership = ReturnType<
  ReturnType<typeof createWindowsProcessOwnership>["unwrap"]
>;

/** Call only while the spawn gate prevents the leader from executing code. */
export const createWindowsProcessOwnership = (
  rootPid: number,
  api: WindowsJobApi = windowsJobApi(),
) => {
  const error = (operation: string) =>
    new WindowsProcessOwnershipError({
      message: `${operation} failed for test PID ${rootPid} (Windows error ${api.GetLastError()})`,
    });
  const job = api.CreateJobObjectW(null, null);
  if (job === 0n) {
    return Result.err(error("CreateJobObject"));
  }
  const limits = new Uint8Array(EXTENDED_LIMIT_INFORMATION_SIZE);
  new DataView(limits.buffer).setUint32(
    LIMIT_FLAGS_OFFSET,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    true,
  );
  if (
    api.SetInformationJobObject(
      job,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
      limits,
      limits.byteLength,
    ) === 0
  ) {
    const failure = error("SetInformationJobObject");
    api.CloseHandle(job);
    return Result.err(failure);
  }
  const processHandle = api.OpenProcess(
    PROCESS_SET_QUOTA_AND_TERMINATE,
    0,
    rootPid,
  );
  if (processHandle === 0n) {
    const failure = error("OpenProcess");
    api.CloseHandle(job);
    return Result.err(failure);
  }
  const assigned = api.AssignProcessToJobObject(job, processHandle);
  const assignmentError =
    assigned === 0 ? error("AssignProcessToJobObject") : undefined;
  const processClosed = api.CloseHandle(processHandle);
  const processCloseError =
    processClosed === 0 ? error("CloseHandle(process)") : undefined;
  const registrationError = assignmentError ?? processCloseError;
  if (registrationError !== undefined) {
    api.CloseHandle(job);
    return Result.err(registrationError);
  }
  // No breakaway flags and no inheritable job handle: descendants stay in the
  // kernel-owned job even when any number of intermediate parents disappear.
  let state: "open" | "closed" = "open";
  let peakBytes = 0;
  const readPeakMemory = () => {
    if (state === "closed") {
      return Result.ok(peakBytes);
    }
    const information = new Uint8Array(EXTENDED_LIMIT_INFORMATION_SIZE);
    if (
      api.QueryInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        information,
        information.byteLength,
        null,
      ) === 0
    ) {
      return Result.err(error("QueryInformationJobObject"));
    }
    peakBytes = Math.max(
      peakBytes,
      Number(
        new DataView(information.buffer).getBigUint64(
          PEAK_JOB_MEMORY_OFFSET,
          true,
        ),
      ),
    );
    return Result.ok(peakBytes);
  };
  return Result.ok({
    readPeakMemory,
    signal: (_signal: NodeJS.Signals) => {
      if (state === "closed") {
        return Result.ok(undefined);
      }
      const sampled = readPeakMemory();
      const terminated = api.TerminateJobObject(job, 1);
      const terminationError =
        terminated === 0 ? error("TerminateJobObject") : undefined;
      // KILL_ON_JOB_CLOSE also covers abrupt owner exit and termination failure.
      const closed = api.CloseHandle(job);
      if (closed !== 0) {
        state = "closed";
      }
      if (terminationError !== undefined) {
        return Result.err(terminationError);
      }
      if (closed === 0) {
        return Result.err(error("CloseHandle"));
      }
      return sampled.isErr() ? Result.err(sampled.error) : Result.ok(undefined);
    },
  });
};
