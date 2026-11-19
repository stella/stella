import { describe, expect, test } from "bun:test";

import { sandboxReads } from "./sandbox-reads";

const DATA = "/data/legal.stella.desktop";
const RUNS = `${DATA}/agent-runs`;
const OWN = `${RUNS}/0b6f5c8e-2d3a-4f1b-9c7e-5a4d3b2c1e0f`;
const OTHER = `${RUNS}/7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d`;
const CACHE = `${DATA}/agent-package-cache`;
const SSH = "/home/member/.ssh";

/**
 * Whether a command may read `target` under `reads`: refused under a denied
 * path unless an allowed path holds it, which wins, as the sandbox applies it.
 */
const commandReads = (
  reads: ReturnType<typeof sandboxReads>,
  target: string,
) => {
  const under = (entries: readonly string[]) =>
    entries.some((entry) => target === entry || target.startsWith(`${entry}/`));
  return !under(reads.deny) || under(reads.allow);
};

describe("sandboxReads", () => {
  test("re-opens the run's folder and what it needs inside the denied paths, in that order", () => {
    const reads = sandboxReads({
      unreadable: [RUNS, DATA, SSH],
      workspace: OWN,
      cache: CACHE,
      needed: [`${DATA}/harness/bun/1.4.4/package/bin`],
    });
    expect(reads).toEqual({
      deny: [RUNS, DATA, SSH],
      allow: [OWN, CACHE, `${DATA}/harness/bun/1.4.4/package/bin`],
    });
  });

  test("a chat's folder beside the run's own stays unreadable, whatever the turn needs", () => {
    const reads = sandboxReads({
      unreadable: [RUNS, DATA],
      workspace: OWN,
      // Misplaced on purpose: a cache that holds every chat's folder.
      cache: RUNS,
      needed: [
        RUNS,
        DATA,
        `${RUNS}/`,
        OTHER,
        `${OTHER}/bin`,
        `${OWN}/../${OTHER.slice(RUNS.length + 1)}`,
        "/data",
      ],
    });
    expect(reads.allow).toEqual([OWN]);
    expect(commandReads(reads, `${OWN}/brief.docx`)).toBe(true);
    expect(commandReads(reads, `${OTHER}/brief.docx`)).toBe(false);
    expect(commandReads(reads, `${OTHER}.used`)).toBe(false);
  });

  test("a chat's own cache beside its folder is readable, another chat's is not", () => {
    const reads = sandboxReads({
      unreadable: [RUNS, DATA],
      workspace: OWN,
      cache: `${OWN}.cache`,
      needed: [`${OTHER}.cache`, `${DATA}/harness/bun/1.4.4/package/bin`],
    });
    expect(reads.allow).toEqual([
      OWN,
      `${OWN}.cache`,
      `${DATA}/harness/bun/1.4.4/package/bin`,
    ]);
    expect(commandReads(reads, `${OWN}.cache/bun/x.tgz`)).toBe(true);
    expect(commandReads(reads, `${OTHER}.cache/bun/x.tgz`)).toBe(false);
    expect(commandReads(reads, `${OTHER}/brief.docx`)).toBe(false);
  });

  test("a folder whose name only starts like the run's own is another folder", () => {
    const reads = sandboxReads({
      unreadable: [RUNS],
      workspace: OWN,
      cache: CACHE,
      needed: [],
    });
    expect(commandReads(reads, `${OWN}-copy/brief.docx`)).toBe(false);
    expect(commandReads(reads, `${OWN}/brief.docx`)).toBe(true);
  });

  test("a needed path outside every denied one needs no re-opening", () => {
    const reads = sandboxReads({
      unreadable: [RUNS, DATA],
      workspace: OWN,
      cache: CACHE,
      needed: ["/usr/local/bin", "/home/member/skills/lease"],
    });
    expect(reads.allow).toEqual([OWN, CACHE]);
  });

  test("a needed path that holds a denied one is left out", () => {
    const reads = sandboxReads({
      unreadable: [RUNS, DATA, SSH],
      workspace: OWN,
      cache: CACHE,
      needed: [`${DATA}/harness`, "/home/member"],
    });
    // The home folder is not denied, and re-opening it would re-open `.ssh`.
    expect(reads.allow).toEqual([OWN, CACHE, `${DATA}/harness`]);
    expect(commandReads(reads, `${SSH}/id_ed25519`)).toBe(false);
  });

  test("a workspace the desktop names unreadable stays unreadable", () => {
    const reads = sandboxReads({
      unreadable: [OWN],
      workspace: OWN,
      cache: CACHE,
      needed: [],
    });
    expect(reads).toEqual({ deny: [OWN], allow: [] });
  });

  test("paths are compared resolved, and repeats are dropped", () => {
    const reads = sandboxReads({
      unreadable: [`${RUNS}/`, RUNS, `${DATA}/./`],
      workspace: `${OWN}/`,
      cache: `${CACHE}/`,
      needed: [`${CACHE}/`, CACHE],
    });
    expect(reads).toEqual({ deny: [RUNS, DATA], allow: [OWN, CACHE] });
  });

  test("with nothing denied nothing is re-opened", () => {
    expect(
      sandboxReads({
        unreadable: [],
        workspace: OWN,
        cache: CACHE,
        needed: [],
      }),
    ).toEqual({ deny: [], allow: [] });
  });
});
