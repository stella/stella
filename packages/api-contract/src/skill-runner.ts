import * as v from "valibot";

/**
 * The skill runner: one command of a skill, run in a fresh sandbox (an AWS
 * Lambda execution environment never reused across runs) against the chat's
 * workspace. The API sends the workspace and the skill as zip archives behind
 * presigned URLs and receives the workspace back the same way; the runner
 * holds no credentials and reaches the network only through the egress proxy
 * named in the input, or not at all.
 */
export const SKILL_RUNNER_LIMITS = {
  argvItems: 64,
  argChars: 4096,
  /**
   * With the runner's transfer deadlines (two downloads of 45 s, one upload of
   * 90 s) the worst run takes 14 of a Lambda's 15 minutes.
   */
  commandTimeoutMs: 11 * 60 * 1000,
  /** Captured from each of stdout and stderr; the rest is dropped and counted. */
  streamBytes: 256 * 1024,
  workspaceArchiveBytes: 200 * 1024 * 1024,
  workspaceUncompressedBytes: 1024 * 1024 * 1024,
  workspaceFiles: 10_000,
  skillArchiveBytes: 50 * 1024 * 1024,
  skillUncompressedBytes: 50 * 1024 * 1024,
  skillFiles: 1000,
  urlChars: 4096,
  /** A workspace path, in the input and in every path a result reports. */
  pathChars: 1024,
} as const;

const httpsUrl = v.pipe(
  v.string(),
  v.maxLength(SKILL_RUNNER_LIMITS.urlChars),
  v.url(),
  v.startsWith("https://"),
);

/** A path inside the workspace, relative, without `..` or empty segments. */
export const SKILL_RUNNER_RELATIVE_PATH_PATTERN =
  /^(?:\.|[^/\0]+(?:\/[^/\0]+)*)$/u;

const relativePath = v.pipe(
  v.string(),
  v.maxLength(SKILL_RUNNER_LIMITS.pathChars),
  v.regex(SKILL_RUNNER_RELATIVE_PATH_PATTERN),
  v.check(
    (path) => !path.split("/").some((segment) => segment === ".."),
    "Path leaves the workspace",
  ),
);

export const skillRunnerInputSchema = v.strictObject({
  runId: v.pipe(v.string(), v.uuid()),
  command: v.strictObject({
    argv: v.pipe(
      v.array(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(SKILL_RUNNER_LIMITS.argChars),
          v.check((arg) => !arg.includes("\0"), "Argument holds a NUL"),
        ),
      ),
      v.minLength(1),
      v.maxLength(SKILL_RUNNER_LIMITS.argvItems),
    ),
    /** Working directory, relative to the workspace. */
    cwd: relativePath,
    timeoutMs: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1000),
      v.maxValue(SKILL_RUNNER_LIMITS.commandTimeoutMs),
    ),
  }),
  /** The chat's workspace before the command; `null` starts it empty. */
  workspaceGetUrl: v.nullable(httpsUrl),
  /** Where the workspace after the command is stored. */
  workspacePutUrl: httpsUrl,
  skill: v.strictObject({
    name: v.pipe(
      v.string(),
      v.regex(/^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    ),
    getUrl: httpsUrl,
    /** SHA-256 of the archive at `getUrl`, hex; a mismatch fails the run. */
    sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
  }),
  /**
   * The egress proxy URL the command's HTTP clients use, carrying the run's
   * token; `null` runs the command without any network.
   */
  egressProxyUrl: v.nullable(
    v.pipe(v.string(), v.maxLength(SKILL_RUNNER_LIMITS.urlChars), v.url()),
  ),
});

export type SkillRunnerInput = v.InferOutput<typeof skillRunnerInputSchema>;

export const SKILL_RUNNER_OUTCOME = {
  exited: "exited",
  timedOut: "timed_out",
  /** The command could not start (missing program, bad working directory). */
  notStarted: "not_started",
} as const;

const capturedStream = v.strictObject({
  text: v.pipe(v.string(), v.maxLength(SKILL_RUNNER_LIMITS.streamBytes)),
  droppedBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const workspaceFile = v.strictObject({
  path: v.pipe(v.string(), v.maxLength(SKILL_RUNNER_LIMITS.pathChars)),
  sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
});

export const skillRunnerResultSchema = v.strictObject({
  outcome: v.picklist(Object.values(SKILL_RUNNER_OUTCOME)),
  exitCode: v.nullable(v.pipe(v.number(), v.integer())),
  signal: v.nullable(v.pipe(v.string(), v.maxLength(32))),
  durationMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  stdout: capturedStream,
  stderr: capturedStream,
  /** Files the command added or changed, in path order. */
  changedFiles: v.pipe(
    v.array(workspaceFile),
    v.maxLength(SKILL_RUNNER_LIMITS.workspaceFiles),
  ),
  /** Paths the command removed, in path order. */
  removedFiles: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(SKILL_RUNNER_LIMITS.pathChars))),
    v.maxLength(SKILL_RUNNER_LIMITS.workspaceFiles),
  ),
});

export type SkillRunnerResult = v.InferOutput<typeof skillRunnerResultSchema>;
