import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readSkillFolderNetworkHosts } from "./skill-network-hosts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const skillFolder = async (name: string, skillFile: string | null) => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-hosts-"));
  roots.push(root);
  const folder = path.join(root, name);
  await mkdir(folder);
  if (skillFile !== null) {
    await writeFile(path.join(folder, "SKILL.md"), skillFile);
  }
  return { name, path: folder };
};

const declaring = (name: string, hosts: string) =>
  `---\nname: ${name}\ndescription: Test skill.\nmetadata:\n  stella-network-hosts: "${hosts}"\n---\n\nBody.\n`;

describe("the hosts a turn's skill folders declare", () => {
  test("joins every skill's hosts, once each", async () => {
    const weather = await skillFolder(
      "weather",
      declaring("weather", "www.ogimet.com aviationweather.gov"),
    );
    const rates = await skillFolder(
      "rates",
      declaring("rates", "www.cnb.cz aviationweather.gov"),
    );
    expect(await readSkillFolderNetworkHosts([weather, rates])).toEqual({
      hosts: ["www.ogimet.com", "aviationweather.gov", "www.cnb.cz"],
      unreadable: [],
    });
  });

  test("a skill that declares nothing adds no host", async () => {
    const quiet = await skillFolder(
      "quiet",
      "---\nname: quiet\ndescription: No network.\n---\n\nBody.\n",
    );
    expect(await readSkillFolderNetworkHosts([quiet])).toEqual({
      hosts: [],
      unreadable: [],
    });
  });

  test("a malformed, missing or oversized declaration adds nothing and is named", async () => {
    const good = await skillFolder("good", declaring("good", "www.cnb.cz"));
    const malformed = await skillFolder(
      "malformed",
      declaring("malformed", "https://evil.example.org"),
    );
    const missing = await skillFolder("missing", null);
    const oversized = await skillFolder(
      "oversized",
      declaring("oversized", "evil.example.org") + "x".repeat(1024 * 1024),
    );
    expect(
      await readSkillFolderNetworkHosts([good, malformed, missing, oversized]),
    ).toEqual({
      hosts: ["www.cnb.cz"],
      unreadable: ["malformed", "missing", "oversized"],
    });
  });
});
