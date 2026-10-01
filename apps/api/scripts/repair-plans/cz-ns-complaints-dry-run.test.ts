import { expect, test } from "bun:test";

const scriptPath = `${import.meta.dir}/cz-ns-complaints-dry-run.ts`;

test("continues after a null source hash and preserves the official source value", async () => {
  const rows = [
    {
      id: "missing-hash",
      adapterKey: "cz-ns",
      sourceHash: null,
      printHtml: "<html></html>",
      metadata: {},
    },
    {
      id: "valid-hash",
      adapterKey: "cz-ns",
      sourceHash: "sha256:valid",
      printHtml: `<table id="box-table-a"><tr><td colspan="2">Podána ústavní stížnost
        <table><tr><td>datum podání</td></tr><tr><td>05/25/2022<br><br>05/25/2022</td></tr></table>
        </td></tr></table>`,
      metadata: {},
    },
  ];
  const child = Bun.spawn([process.execPath, scriptPath], {
    cwd: `${import.meta.dir}/../..`,
    stdin: new Blob([rows.map((row) => JSON.stringify(row)).join("\n")]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  const outputs = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(outputs).toHaveLength(2);
  expect(outputs.at(0)).toEqual({
    status: "unresolved",
    id: "missing-hash",
    sourceHash: null,
    reason: "Source hash is missing; no write can be fenced to this row.",
  });
  expect(outputs.at(1)).toMatchObject({
    status: "proposal",
    id: "valid-hash",
    sourceHash: "sha256:valid",
    after: [
      {
        "datum podání": {
          type: "date",
          value: "2022-05-25",
          sourceValue: "05/25/2022\n\n05/25/2022",
        },
      },
    ],
  });
});
