import { expect, test } from "bun:test";

// Apps request a web handoff before every opened link (openPresentationLink).
// An e2e fixture host that rejects unknown tools would then fail on the
// handoff instead of the link, so every host that serves link requests must
// answer the handoff tool explicitly.
test("every e2e app host that opens links answers the handoff tool", async () => {
  const repository = new URL("../../../../", import.meta.url).pathname;
  const hosts: string[] = [];
  for await (const file of new Bun.Glob("apps/*/e2e/**/*.{ts,mts}").scan({
    cwd: repository,
  })) {
    const source = await Bun.file(`${repository}${file}`).text();
    if (source.includes('"ui/open-link"')) {
      hosts.push(file);
    }
  }
  expect(hosts.length).toBeGreaterThan(0);
  for (const file of hosts) {
    const source = await Bun.file(`${repository}${file}`).text();
    expect(source.includes("MCP_WEB_HANDOFF_TOOL_NAME"), file).toBe(true);
  }
});
