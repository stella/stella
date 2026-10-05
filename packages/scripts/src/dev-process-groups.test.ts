import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { json } from "node:stream/consumers";
import * as v from "valibot";

import { down } from "./agent-session";
import {
  DevProcessSurvivedError,
  devProcessStartedAt,
  readDevProcessGroups,
  spawnDevProcess,
  stopDevProcessGroups,
} from "./dev-process-groups";
import { devStatePath } from "./dev-runtime";

const fixture = new URL("fixtures/dev-process-tree.ts", import.meta.url)
  .pathname;
const readySchema = v.object({ pid: v.number(), port: v.number() });
const readTreeReady = async (stream: Readable) =>
  v.parse(readySchema, await json(stream));

const startTree = async (rootDir: string, termMode: "ignore" | "exit") => {
  const readyPath = path.join(rootDir, "ready.sock");
  const {
    promise: ready,
    resolve: resolveReady,
    reject: rejectReady,
  } = Promise.withResolvers<v.InferOutput<typeof readySchema>>();
  const server = createServer((socket) => {
    void readTreeReady(socket).then(resolveReady, rejectReady);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(readyPath, resolve);
  });
  server.on("error", rejectReady);
  try {
    const child = spawnDevProcess({
      rootDir,
      cmd: [process.execPath, fixture, "leader", readyPath, termMode],
      cwd: rootDir,
      env: process.env,
      label: "test service",
      stdin: "ignore",
    }).unwrap("The real process-tree fixture must start successfully");
    return { child, ...(await ready) };
  } finally {
    server.close();
  }
};

test("process-tree readiness waits for the complete message", async () => {
  const stream = new PassThrough();
  const ready = readTreeReady(stream);
  stream.write('{"pid":123,');
  const pending = Symbol("pending readiness");
  expect(await Promise.race([ready, Promise.resolve(pending)])).toBe(pending);
  stream.write('"port":456}');
  expect(await Promise.race([ready, Promise.resolve(pending)])).toBe(pending);
  stream.end();
  expect(await ready).toEqual({ pid: 123, port: 456 });
});

const liveMembers = (pgid: number) => {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,pgid=,stat="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.success).toBe(true);
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((row) => {
      const fields = row.trim().split(/\s+/u);
      return Number(fields.at(1)) === pgid && !fields.at(2)?.startsWith("Z");
    });
};
const assertPortFree = async (port: number) => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
};

const disposeTree = async (
  tree: Awaited<ReturnType<typeof startTree>> | undefined,
) => {
  if (!tree) {
    return;
  }
  // Inspect membership independently so a broken group-signaling helper
  // cannot leave these fixtures alive after a failed assertion.
  for (const row of liveMembers(tree.child.pid)) {
    const pid = Number(row.trim().split(/\s+/u).at(0));
    const killed = Result.try(() => process.kill(pid, "SIGKILL"));
    if (
      killed.isErr() &&
      !("code" in killed.error && killed.error.code === "ESRCH")
    ) {
      throw killed.error;
    }
  }
  await tree.child.exited;
  const deadline = performance.now() + 2000;
  while (
    liveMembers(tree.child.pid).length > 0 &&
    performance.now() < deadline
  ) {
    await Bun.sleep(20);
  }
  expect(liveMembers(tree.child.pid)).toEqual([]);
};

for (const termMode of ["exit", "ignore"] as const) {
  test(`down stops a group after its parent exited and releases the grandchild port: ${termMode}`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dev-group-test-"));
    let tree: Awaited<ReturnType<typeof startTree>> | undefined;
    try {
      tree = await startTree(root, termMode);
      const session = readDevProcessGroups(root).unwrap(
        "The fixture process-group journal must be readable",
      );
      expect(session?.groups.at(0)?.pgid).toBe(tree.child.pid);
      tree.child.kill("SIGTERM");
      await tree.child.exited;
      expect(liveMembers(tree.child.pid).length).toBeGreaterThan(0);
      expect((await fetch(`http://127.0.0.1:${tree.port}`)).ok).toBe(true);
      await down(root);
      expect(liveMembers(tree.child.pid)).toEqual([]);
      await assertPortFree(tree.port);
      expect(
        readDevProcessGroups(root).unwrap(
          "The fixture process-group journal must be readable",
        ),
      ).toBeNull();
      await down(root);
    } finally {
      await disposeTree(tree);
      (await stopDevProcessGroups({ rootDir: root, graceMs: 0 })).unwrap(
        "Fixture group cleanup must succeed",
      );
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
}

test("stopping one session preserves an unrelated sibling group", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dev-group-owned-"));
  const otherRoot = mkdtempSync(path.join(tmpdir(), "dev-group-other-"));
  let tree: Awaited<ReturnType<typeof startTree>> | undefined;
  let sibling: Awaited<ReturnType<typeof startTree>> | undefined;
  try {
    tree = await startTree(root, "ignore");
    sibling = await startTree(otherRoot, "exit");
    expect(
      (await stopDevProcessGroups({ rootDir: root, graceMs: 0 })).unwrap(
        "Stopping the owned fixture must succeed",
      ),
    ).toEqual(["test service"]);
    await tree.child.exited;
    expect(liveMembers(tree.child.pid)).toEqual([]);
    expect(liveMembers(sibling.child.pid).length).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${sibling.port}`)).ok).toBe(true);
    await assertPortFree(tree.port);
  } finally {
    await disposeTree(tree);
    await disposeTree(sibling);
    (await stopDevProcessGroups({ rootDir: root, graceMs: 0 })).unwrap(
      "Fixture group cleanup must succeed",
    );
    (await stopDevProcessGroups({ rootDir: otherRoot, graceMs: 0 })).unwrap(
      "Sibling fixture group cleanup must succeed",
    );
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("a reused group leader is refused and recovery state is retained", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dev-group-reuse-"));
  let tree: Awaited<ReturnType<typeof startTree>> | undefined;
  let original: string | undefined;
  const file = devStatePath(root, "process-groups.json");
  try {
    tree = await startTree(root, "exit");
    original = readFileSync(file, "utf-8");
    const session = readDevProcessGroups(root).unwrap(
      "The fixture process-group journal must be readable",
    );
    if (!session) {
      throw new Error("Missing process session");
    }
    writeFileSync(
      file,
      JSON.stringify({
        runnerPid: session.runnerPid,
        runnerStartedAt: session.runnerStartedAt,
        sessionId: session.sessionId,
        status: session.status,
        groups: session.groups.map((group) => ({
          pgid: group.pgid,
          label: group.label,
          leaderStartedAt: "different process birth",
        })),
      }),
    );
    const stopped = await stopDevProcessGroups({ rootDir: root, graceMs: 0 });
    expect(stopped.isErr()).toBe(true);
    if (stopped.isErr()) {
      expect(stopped.error.name).toBe("DevProcessOwnershipError");
      expect(stopped.error.message).toContain("Refusing reused process group");
    }
    expect(
      readDevProcessGroups(root).unwrap(
        "The fixture process-group journal must be readable",
      ),
    ).not.toBeNull();
    expect((await fetch(`http://127.0.0.1:${tree.port}`)).ok).toBe(true);
  } finally {
    if (original) {
      writeFileSync(file, original);
    }
    await disposeTree(tree);
    (await stopDevProcessGroups({ rootDir: root, graceMs: 0 })).unwrap(
      "Fixture group cleanup must succeed",
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("an older runner cannot stop or replace another session's journal", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dev-group-owner-"));
  let tree: Awaited<ReturnType<typeof startTree>> | undefined;
  let original: string | undefined;
  const file = devStatePath(root, "process-groups.json");
  try {
    tree = await startTree(root, "exit");
    original = readFileSync(file, "utf-8");
    const session = readDevProcessGroups(root).unwrap(
      "The fixture process-group journal must be readable",
    );
    if (!session) {
      throw new Error("Missing process session");
    }
    writeFileSync(
      file,
      JSON.stringify({
        runnerPid: process.pid + 1,
        runnerStartedAt: session.runnerStartedAt,
        sessionId: session.sessionId,
        status: session.status,
        groups: session.groups,
      }),
    );
    expect(
      (await stopDevProcessGroups({ rootDir: root, graceMs: 0 })).unwrap(
        "Stopping the owned fixture must succeed",
      ),
    ).toEqual([]);
    const spawned = spawnDevProcess({
      rootDir: root,
      cmd: [process.execPath, "--version"],
      cwd: root,
      env: process.env,
      label: "unowned",
      stdin: "ignore",
    });
    expect(spawned.isErr()).toBe(true);
    if (spawned.isErr()) {
      expect(spawned.error.name).toBe("DevProcessOwnershipError");
      expect(spawned.error.message).toContain(
        "Another dev session has recorded process groups",
      );
    }
    expect((await fetch(`http://127.0.0.1:${tree.port}`)).ok).toBe(true);
    expect(
      readDevProcessGroups(root).unwrap(
        "The fixture process-group journal must be readable",
      )?.runnerPid,
    ).toBe(process.pid + 1);
  } finally {
    if (original) {
      writeFileSync(file, original);
    }
    await disposeTree(tree);
    (await stopDevProcessGroups({ rootDir: root, graceMs: 0 })).unwrap(
      "Fixture group cleanup must succeed",
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("stopping closes the session to new services before waiting", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dev-group-stopping-"));
  let tree: Awaited<ReturnType<typeof startTree>> | undefined;
  try {
    tree = await startTree(root, "ignore");
    const stopping = stopDevProcessGroups({ rootDir: root, graceMs: 300 });
    expect(
      readDevProcessGroups(root).unwrap(
        "The fixture process-group journal must be readable",
      )?.status,
    ).toBe("stopping");
    const spawned = spawnDevProcess({
      rootDir: root,
      cmd: [process.execPath, "--version"],
      cwd: root,
      env: process.env,
      label: "late service",
      stdin: "ignore",
    });
    expect(spawned.isErr()).toBe(true);
    if (spawned.isErr()) {
      expect(spawned.error.name).toBe("DevProcessOwnershipError");
      expect(spawned.error.message).toContain("Dev session is stopping");
    }
    (await stopping).unwrap("Stopping must finish after blocking new services");
    expect(liveMembers(tree.child.pid)).toEqual([]);
    await assertPortFree(tree.port);
  } finally {
    await disposeTree(tree);
    (await stopDevProcessGroups({ rootDir: root, graceMs: 0 })).unwrap(
      "Fixture group cleanup must succeed",
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("a recycled runner PID cannot adopt a different session identity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dev-group-identity-"));
  const file = devStatePath(root, "process-groups.json");
  let tree: Awaited<ReturnType<typeof startTree>> | undefined;
  let original: string | undefined;
  try {
    tree = await startTree(root, "exit");
    original = readFileSync(file, "utf-8");
    const session = readDevProcessGroups(root).unwrap(
      "The fixture process-group journal must be readable",
    );
    if (!session) {
      throw new Error("Missing process session");
    }
    writeFileSync(
      file,
      JSON.stringify({
        runnerPid: session.runnerPid,
        runnerStartedAt: session.runnerStartedAt,
        sessionId: "different session",
        status: session.status,
        groups: session.groups,
      }),
    );
    expect(
      (await stopDevProcessGroups({ rootDir: root, graceMs: 0 })).unwrap(
        "Stopping the owned fixture must succeed",
      ),
    ).toEqual([]);
    const spawned = spawnDevProcess({
      rootDir: root,
      cmd: [process.execPath, "--version"],
      cwd: root,
      env: process.env,
      label: "unowned",
      stdin: "ignore",
    });
    expect(spawned.isErr()).toBe(true);
    if (spawned.isErr()) {
      expect(spawned.error.name).toBe("DevProcessOwnershipError");
      expect(spawned.error.message).toContain("Another dev session");
    }
    expect((await fetch(`http://127.0.0.1:${tree.port}`)).ok).toBe(true);
  } finally {
    if (original) {
      writeFileSync(file, original);
    }
    await disposeTree(tree);
    (await stopDevProcessGroups({ rootDir: root, graceMs: 0 })).unwrap(
      "Fixture group cleanup must succeed",
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("external recovery waits for the owner but ignores a recycled runner PID", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dev-group-recovery-"));
  const otherRoot = mkdtempSync(
    path.join(tmpdir(), "dev-group-recovery-other-"),
  );
  let tree: Awaited<ReturnType<typeof startTree>> | undefined;
  let sibling: Awaited<ReturnType<typeof startTree>> | undefined;
  let original: string | undefined;
  const file = devStatePath(root, "process-groups.json");
  try {
    tree = await startTree(root, "exit");
    sibling = await startTree(otherRoot, "exit");
    original = readFileSync(file, "utf-8");
    const session = readDevProcessGroups(root).unwrap(
      "The fixture process-group journal must be readable",
    );
    if (!session) {
      throw new Error("Missing process session");
    }
    const owner = {
      runnerPid: sibling.child.pid,
      runnerStartedAt: devProcessStartedAt(sibling.child.pid).unwrap(
        "The sibling process birth must be inspectable",
      ),
      sessionId: session.sessionId,
      status: session.status,
      groups: session.groups,
    };
    writeFileSync(file, JSON.stringify(owner));
    const stopped = await stopDevProcessGroups({
      rootDir: root,
      runnerPid: owner.runnerPid,
      sessionId: owner.sessionId,
      graceMs: 0,
    });
    expect(stopped.isErr()).toBe(true);
    if (stopped.isErr()) {
      expect(stopped.error.name).toBe("DevProcessOwnershipError");
      expect(stopped.error.message).toContain("Stop the owning runner");
    }
    writeFileSync(
      file,
      JSON.stringify({
        runnerPid: owner.runnerPid,
        runnerStartedAt: "different runner birth",
        sessionId: owner.sessionId,
        status: owner.status,
        groups: owner.groups,
      }),
    );
    (
      await stopDevProcessGroups({
        rootDir: root,
        runnerPid: owner.runnerPid,
        sessionId: owner.sessionId,
        graceMs: 500,
      })
    ).unwrap("Recovery of groups after runner PID reuse must succeed");
    expect(liveMembers(tree.child.pid)).toEqual([]);
    await assertPortFree(tree.port);
    expect((await fetch(`http://127.0.0.1:${sibling.port}`)).ok).toBe(true);
  } finally {
    if (original && existsSync(file)) {
      writeFileSync(file, original);
    }
    await disposeTree(tree);
    await disposeTree(sibling);
    (await stopDevProcessGroups({ rootDir: root, graceMs: 0 })).unwrap(
      "Fixture group cleanup must succeed",
    );
    (await stopDevProcessGroups({ rootDir: otherRoot, graceMs: 0 })).unwrap(
      "Sibling fixture group cleanup must succeed",
    );
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("surviving groups fail explicitly and retain recovery state", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dev-group-survivor-"));
  let tree: Awaited<ReturnType<typeof startTree>> | undefined;
  try {
    tree = await startTree(root, "ignore");
    const stopped = await stopDevProcessGroups({
      rootDir: root,
      graceMs: 0,
      forceMs: 0,
      signal: (_pgid, _signal) => Result.ok(undefined),
    });
    expect(stopped.isErr()).toBe(true);
    if (stopped.isErr()) {
      expect(stopped.error).toBeInstanceOf(DevProcessSurvivedError);
      if (stopped.error instanceof DevProcessSurvivedError) {
        expect(stopped.error.pgids).toContain(tree.child.pid);
      }
    }
    expect(
      readDevProcessGroups(root).unwrap(
        "Survivor recovery state must remain readable",
      )?.status,
    ).toBe("stopping");
    expect(liveMembers(tree.child.pid).length).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${tree.port}`)).ok).toBe(true);
    const port = tree.port;
    const bound = await Result.tryPromise({
      try: async () => await assertPortFree(port),
      catch: (cause) => {
        if (!(cause instanceof Error)) {
          panic("Port binding must reject with an OS error");
        }
        return cause;
      },
    });
    expect(bound.isErr()).toBe(true);
    if (bound.isErr()) {
      expect("code" in bound.error && bound.error.code).toBe("EADDRINUSE");
    }
    await disposeTree(tree);
    await assertPortFree(tree.port);
  } finally {
    await disposeTree(tree);
    (await stopDevProcessGroups({ rootDir: root, graceMs: 0 })).unwrap(
      "Survivor fixture cleanup must succeed",
    );
    rmSync(root, { recursive: true, force: true });
  }
});
