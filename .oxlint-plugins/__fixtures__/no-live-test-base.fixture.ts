declare const baselinePath: string;
declare const fixture: string;

// oxlint-disable-next-line no-live-test-base/no-live-test-base -- fixture: checkout baseline reads require a pinned revision
Bun.spawnSync(["git", "show", `origin/main:${baselinePath}`], { cwd: process.cwd() });

// expect-clean: no-live-test-base/no-live-test-base
Bun.spawnSync(["git", "show", `origin/main:${baselinePath}`], { cwd: fixture });
