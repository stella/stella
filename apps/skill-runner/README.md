# @stll/skill-runner

Lambda that runs one command of a skill against a chat's workspace. The API
and the runner share the bounded schemas in `@stll/api-contract/skill-runner`.

Each invocation:

1. downloads the skill's archive from a presigned URL and checks its SHA-256,
   then lays it out under its own folder, outside the workspace;
2. downloads the chat's workspace archive, when there is one;
3. runs the command without a shell, in its own process group, with an
   allowlisted environment: `PATH`, `LANG`, `LD_LIBRARY_PATH`, a private
   `HOME`, `XDG_CACHE_HOME`, `TMPDIR`, `SKILL_DIR`, and the egress proxy
   variables only when the input names a proxy. The Lambda's own variables
   never reach the command;
4. ends everything the command started, in its process group or out of it,
   before listing the workspace;
5. stores the workspace back to a presigned URL, when its archive is within
   the size the next run accepts, and reports the outcome, captured output
   (capped) and the files added, changed or removed.

A command runs as the runner's user and sees the same process table, so an
environment allowlist alone would not keep AWS credentials from it. The
runner needs none, so the image's entrypoint starts the Lambda runtime
without them, and the handler refuses to run while any process it can read
still holds them.

The runner is meant to run in a Lambda execution environment that is never
reused across runs (tenant isolation, tenant id = run id), in a network whose
only routes are the run bucket and the egress proxy. The image carries Bun and
Python 3 for skills' scripts and downloads nothing at invocation time.

Build from the repository root with
`docker build --platform linux/arm64 -f apps/skill-runner/Dockerfile .`.
