import { describe, expect, test } from "bun:test";

import { lifecycleFindings } from "./online-migration-lifecycle";

const entry = (lifecycle: string | undefined, body = "values: []") =>
  [
    "export default {",
    '  id: "fixture",',
    "  revision: 1,",
    ...(lifecycle === undefined ? [] : [`  lifecycle: "${lifecycle}",`]),
    '  type: "indexes",',
    `  ${body},`,
    "} satisfies OnlineMigrationEntry;",
    "",
  ].join("\n");

const PATH = "apps/api/src/db/online-migration-entries/fixture.ts";
const findingsFor = ({
  text,
  released,
  exemptions = {},
}: {
  text: string;
  released: string | undefined;
  exemptions?: Record<string, string>;
}) =>
  lifecycleFindings({
    entries: [{ path: PATH, text }],
    readAtRelease: () => released,
    release: "v1.0.0",
    exemptions,
  });

describe("online migration lifecycle", () => {
  test("a finalized entry needs the promoted release to carry it unchanged", () => {
    // Released before the lifecycle field existed: same entry, no line.
    expect(
      findingsFor({ text: entry("finalized"), released: entry(undefined) }),
    ).toEqual([]);
    expect(
      findingsFor({ text: entry("finalized"), released: undefined }),
    ).toHaveLength(1);
    expect(
      findingsFor({
        text: entry("finalized", "values: [changed]"),
        released: entry(undefined),
      }),
    ).toHaveLength(1);
  });

  test("a pending entry is always allowed, and an entry must declare one", () => {
    expect(
      findingsFor({ text: entry("pending"), released: undefined }),
    ).toEqual([]);
    expect(
      findingsFor({ text: entry("pending"), released: entry("finalized") }),
    ).toEqual([]);
    expect(
      findingsFor({ text: entry(undefined), released: undefined }),
    ).toEqual([`${PATH}: declares no lifecycle`]);
  });

  test("an exemption finalizes early with a reason, and lapses once released", () => {
    const reason = "An ON CONFLICT arbiter the same release writes through.";
    expect(
      findingsFor({
        text: entry("finalized"),
        released: undefined,
        exemptions: { [PATH]: reason },
      }),
    ).toEqual([]);
    expect(
      findingsFor({
        text: entry("finalized"),
        released: undefined,
        exemptions: { [PATH]: "short" },
      }),
    ).toHaveLength(1);
    expect(
      findingsFor({
        text: entry("finalized"),
        released: entry(undefined),
        exemptions: { [PATH]: reason },
      }),
    ).toHaveLength(1);
    expect(
      lifecycleFindings({
        entries: [],
        readAtRelease: () => undefined,
        release: "v1.0.0",
        exemptions: { [PATH]: reason },
      }),
    ).toHaveLength(1);
  });
});
