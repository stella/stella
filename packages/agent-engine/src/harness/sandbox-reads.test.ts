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
      needed: [CACHE, `${DATA}/harness/bun/1.4.4/package/bin`],
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

  test("a folder whose name only starts like the run's own is another folder", () => {
    const reads = sandboxReads({
      unreadable: [RUNS],
      workspace: OWN,
      needed: [],
    });
    expect(commandReads(reads, `${OWN}-copy/brief.docx`)).toBe(false);
    expect(commandReads(reads, `${OWN}/brief.docx`)).toBe(true);
  });

  test("a needed path outside every denied one needs no re-opening", () => {
    const reads = sandboxReads({
      unreadable: [RUNS, DATA],
      workspace: OWN,
      needed: ["/usr/local/bin", "/home/member/skills/lease"],
    });
    expect(reads.allow).toEqual([OWN]);
  });

  test("a needed path that holds a denied one is left out", () => {
    const reads = sandboxReads({
      unreadable: [DATA, SSH],
      workspace: OWN,
      needed: [`${DATA}/harness`, "/home/member"],
    });
    // The home folder is not denied, and re-opening it would re-open `.ssh`.
    expect(reads.allow).toEqual([OWN, `${DATA}/harness`]);
    expect(commandReads(reads, `${SSH}/id_ed25519`)).toBe(false);
  });

  test("a workspace the desktop names unreadable stays unreadable", () => {
    const reads = sandboxReads({
      unreadable: [OWN],
      workspace: OWN,
      needed: [],
    });
    expect(reads).toEqual({ deny: [OWN], allow: [] });
  });

  test("paths are compared resolved, and repeats are dropped", () => {
    const reads = sandboxReads({
      unreadable: [`${RUNS}/`, RUNS, `${DATA}/./`],
      workspace: `${OWN}/`,
      needed: [`${CACHE}/`, CACHE],
    });
    expect(reads).toEqual({ deny: [RUNS, DATA], allow: [OWN, CACHE] });
  });

  test("with nothing denied nothing is re-opened", () => {
    expect(
      sandboxReads({ unreadable: [], workspace: OWN, needed: [CACHE] }),
    ).toEqual({ deny: [], allow: [] });
  });
});
