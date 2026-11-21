import { Result, TaggedError } from "better-result";
import { dlopen, FFIType } from "bun:ffi";

// Windows x64/arm64 ABI: BASIC_LIMIT_INFORMATION (64), IO_COUNTERS (48),
// then four SIZE_Ts. HANDLEs are integers, never FFI virtual-address pointers.
const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
const PEAK_JOB_MEMORY_OFFSET = 136;
const JOB_MEMORY_LIMIT_OFFSET = 120;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x20_00;
const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x02_00;
const JOB_OBJECT_ASSOCIATE_COMPLETION_PORT = 7;
const JOB_OBJECT_MSG_JOB_MEMORY_LIMIT = 10;
const WAIT_TIMEOUT = 258;
const INVALID_HANDLE_VALUE = 0xff_ff_ff_ff_ff_ff_ff_ffn;
const PROCESS_SET_QUOTA_AND_TERMINATE = 0x01_01;

class WindowsProcessOwnershipError extends TaggedError(
  "WindowsProcessOwnershipError",
)<{
  message: string;
  cause?: unknown;
}> {}

export const WINDOWS_JOB_SYMBOLS = {
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
    args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  QueryInformationJobObject: {
    args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  TerminateJobObject: {
    args: [FFIType.u64, FFIType.u32],
    returns: FFIType.i32,
  },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
  CreateIoCompletionPort: {
    args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u32],
    returns: FFIType.u64,
  },
  GetQueuedCompletionStatus: {
    args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
} as const;
const openWindowsJobLibrary = () => dlopen("kernel32.dll", WINDOWS_JOB_SYMBOLS);
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

const associateMemoryPort = (job: bigint, api: WindowsJobApi) => {
  const port = api.CreateIoCompletionPort(INVALID_HANDLE_VALUE, 0n, 0n, 1);
  if (port === 0n) {
    return Result.err(
      new WindowsProcessOwnershipError({
        message: `CreateIoCompletionPort failed (Windows error ${api.GetLastError()})`,
      }),
    );
  }
  const association = new Uint8Array(16);
  new DataView(association.buffer).setBigUint64(8, port, true);
  if (
    api.SetInformationJobObject(
      job,
      JOB_OBJECT_ASSOCIATE_COMPLETION_PORT,
      association,
      association.byteLength,
    ) === 0
  ) {
    const failure = new WindowsProcessOwnershipError({
      message: `Associate job completion port failed (Windows error ${api.GetLastError()})`,
    });
    api.CloseHandle(port);
    return Result.err(failure);
  }
  return Result.ok(port);
};

const createMemoryLimitReader = (port: bigint, api: WindowsJobApi) => {
  let status: "within-limit" | "limit-exceeded" = "within-limit";
  const message = new Uint32Array(1);
  const key = new BigUint64Array(1);
  const process = new BigUint64Array(1);
  return () => {
    // Hard allocation enforcement does not depend on notification delivery.
    // Bound work during spawn storms; remaining packets drain on the next tick.
    for (let count = 0; count < 1024; count += 1) {
      if (api.GetQueuedCompletionStatus(port, message, key, process, 0) === 0) {
        const code = api.GetLastError();
        if (code === WAIT_TIMEOUT) {
          return Result.ok(status);
        }
        return Result.err(
          new WindowsProcessOwnershipError({
            message: `GetQueuedCompletionStatus failed (Windows error ${code})`,
          }),
        );
      }
      if (message[0] === JOB_OBJECT_MSG_JOB_MEMORY_LIMIT) {
        status = "limit-exceeded";
      }
    }
    return Result.ok(status);
  };
};

type CreateWindowsProcessOwnershipOptions = {
  rootPid: number;
  limitBytes: number;
};

/** Call only while the spawn gate prevents the leader from executing code. */
export const createWindowsProcessOwnership = (
  { rootPid, limitBytes }: CreateWindowsProcessOwnershipOptions,
  api: WindowsJobApi = windowsJobApi(),
) => {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    return Result.err(
      new WindowsProcessOwnershipError({
        message: "Windows job memory cap must be a positive safe integer",
      }),
    );
  }
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
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE + JOB_OBJECT_LIMIT_JOB_MEMORY,
    true,
  );
  new DataView(limits.buffer).setBigUint64(
    JOB_MEMORY_LIMIT_OFFSET,
    BigInt(limitBytes),
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
  const associated = associateMemoryPort(job, api);
  if (associated.isErr()) {
    api.CloseHandle(job);
    return Result.err(associated.error);
  }
  const port = associated.value;
  const limitState = createMemoryLimitReader(port, api);
  const processHandle = api.OpenProcess(
    PROCESS_SET_QUOTA_AND_TERMINATE,
    0,
    rootPid,
  );
  if (processHandle === 0n) {
    const failure = error("OpenProcess");
    api.CloseHandle(job);
    api.CloseHandle(port);
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
    api.CloseHandle(port);
    return Result.err(registrationError);
  }
  // No breakaway flags and no inheritable job handle: descendants stay in the
  // kernel-owned job even when any number of intermediate parents disappear.
  let state: "open" | "closed" = "open";
  let peakBytes = 0;
  let memoryStatus: "within-limit" | "limit-exceeded" = "within-limit";
  const readMemory = () => {
    if (state === "closed") {
      return Result.ok({ peakBytes, status: memoryStatus });
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
    // Use the job's committed-memory counter, never process working sets.
    // Allocation rejection and limit notifications establish hard-cap behavior;
    // do not infer it from an upper bound on this historical peak.
    peakBytes = Math.max(
      peakBytes,
      Number(
        new DataView(information.buffer).getBigUint64(
          PEAK_JOB_MEMORY_OFFSET,
          true,
        ),
      ),
    );
    const notification = limitState();
    if (notification.isErr()) {
      return Result.err(notification.error);
    }
    memoryStatus = notification.value;
    return Result.ok({ peakBytes, status: memoryStatus });
  };
  return Result.ok({
    readMemory,
    signal: (_signal: NodeJS.Signals) => {
      if (state === "closed") {
        return Result.ok(undefined);
      }
      const sampled = readMemory();
      const terminated = api.TerminateJobObject(job, 1);
      const terminationError =
        terminated === 0 ? error("TerminateJobObject") : undefined;
      // KILL_ON_JOB_CLOSE also covers abrupt owner exit and termination failure.
      const closed = api.CloseHandle(job);
      const portClosed = api.CloseHandle(port);
      if (closed !== 0) {
        state = "closed";
      }
      if (terminationError !== undefined) {
        return Result.err(terminationError);
      }
      if (closed === 0) {
        return Result.err(error("CloseHandle"));
      }
      if (portClosed === 0) {
        return Result.err(error("CloseHandle(completion port)"));
      }
      return sampled.isErr() ? Result.err(sampled.error) : Result.ok(undefined);
    },
  });
};
