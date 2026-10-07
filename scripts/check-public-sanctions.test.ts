import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { parseCzList } from "../packages/sanctions/src/cz";
import { parseEuList } from "../packages/sanctions/src/eu";
import {
  DEFAULT_CUTOFF,
  buildScreeningIndex,
  screen,
} from "../packages/sanctions/src/screening";
import {
  CanaryFailureError,
  SOURCES,
  POSITIVE_CONTROL,
  probe,
  runCanary,
  validateScreening,
  type RequestHttps,
} from "./check-public-sanctions";

type ListFixture = {
  source: string;
  status: string;
  reason: string | null;
  editionId: string | null;
  publishedAt: string | null;
};

const screening = () => ({
  status: "possible-match",
  lists: SOURCES.map((source): ListFixture => ({
    source,
    status: POSITIVE_CONTROL.expectedSources.some(
      (expected) => expected === source,
    )
      ? "possible-match"
      : "clear",
    reason: null,
    editionId: "published",
    publishedAt: "2026-10-01",
  })),
});

const transport =
  (statusCode: number, responseBody: string): RequestHttps =>
  (url, options, onResponse) => {
    assert.equal(url.pathname, "/api/v1/sanctions/search");
    assert.equal(options.method, "POST");
    assert.deepEqual(options.headers, {
      "Content-Type": "application/json",
      "User-Agent": "StellaSanctionsCanary/1.0",
      "Content-Length": Buffer.byteLength(
        JSON.stringify({
          subject: { type: "organization", name: "Voice of Europe" },
        }),
      ),
    });
    const request = new PassThrough();
    return Object.assign(request, {
      destroy(error: Error) {
        request.emit("error", error);
        request.emit("close");
      },
      end(payload: string) {
        assert.deepEqual(JSON.parse(payload), {
          subject: { type: "organization", name: "Voice of Europe" },
        });
        queueMicrotask(() => {
          const response = Object.assign(new PassThrough(), { statusCode });
          onResponse(response);
          response.emit("data", Buffer.from(responseBody));
          response.emit("end");
          request.emit("close");
        });
      },
    });
  };

test("published editions screen and missing editions may remain unavailable", () => {
  const body = screening();
  body.lists[1] = {
    source: "un",
    status: "unavailable",
    reason: "not-loaded",
    editionId: null,
    publishedAt: null,
  };
  body.status = "possible-match";
  assert.doesNotThrow(() => validateScreening(body));
});

test("access-denied without edition metadata is allowed alongside published editions", () => {
  for (const source of SOURCES) {
    const body = screening();
    body.lists = body.lists.map((list) =>
      list.source === source
        ? {
            source,
            status: "unavailable",
            reason: "access-denied",
            editionId: null,
            publishedAt: null,
          }
        : list,
    );
    body.status = "possible-match";
    if (
      POSITIVE_CONTROL.expectedSources.some((expected) => expected === source)
    ) {
      assert.throws(() => validateScreening(body), {
        code: "positive-control-missed",
      });
    } else {
      assert.doesNotThrow(() => validateScreening(body));
    }
  }
  const body = screening();
  body.status = "unavailable";
  body.lists = body.lists.map((list) => ({
    ...list,
    status: "unavailable",
    reason: "access-denied",
    editionId: null,
    publishedAt: null,
  }));
  assert.throws(() => validateScreening(body), { code: "incomplete-coverage" });
});

test("unavailable lists without edition metadata refuse unhandled reasons", () => {
  for (const source of SOURCES) {
    for (const reason of ["stale", null]) {
      const body = screening();
      body.status = "unavailable";
      body.lists = body.lists.map((list) =>
        list.source === source
          ? {
              source,
              status: "unavailable",
              reason,
              editionId: null,
              publishedAt: null,
            }
          : list,
      );
      assert.throws(() => validateScreening(body), {
        code: "unexpected-unavailable",
      });
    }
  }
});

test("non-HTTPS targets are rejected before creating a transport", async () => {
  let requests = 0;
  const requestHttps: RequestHttps = (...args) => {
    requests += 1;
    return transport(200, JSON.stringify(screening()))(...args);
  };
  for (const protocol of ["http", "ftp", "file"]) {
    await assert.rejects(
      probe(`${protocol}://example.test/`, { requestHttps }),
      {
        code: "invalid-target",
        message: "invalid-target",
      },
    );
  }
  assert.equal(requests, 0);
});

test("slow headers and response bodies fail at the wall-clock deadline", async () => {
  for (const phase of ["headers", "body"]) {
    const destroyed: Error[] = [];
    const requestHttps: RequestHttps = (_url, _options, onResponse) => {
      const request = new PassThrough();
      return Object.assign(request, {
        destroy(error: Error) {
          destroyed.push(error);
          request.emit("error", error);
          request.emit("close");
        },
        end() {
          if (phase === "headers") {
            return;
          }
          const response = Object.assign(new PassThrough(), {
            statusCode: 200,
          });
          onResponse(response);
          response.emit("data", Buffer.from('{"status":'));
        },
      });
    };
    await assert.rejects(
      probe("https://example.test/", { requestHttps, deadlineMs: 1 }),
      {
        code: "deadline-exceeded",
        message: "deadline-exceeded",
      },
    );
    assert.equal(destroyed.length, 1);
    assert.equal(destroyed.at(0) instanceof CanaryFailureError, true);
    assert.equal(destroyed.at(0)?.message, "deadline-exceeded");
  }
});

test("every source fails for unavailable published editions and erased load failures", () => {
  for (const source of SOURCES) {
    for (const reason of [
      "load-failed",
      "stale",
      "access-denied",
      "not-loaded",
    ]) {
      const body = screening();
      body.lists = body.lists.map((list) =>
        list.source === source
          ? { ...list, status: "unavailable", reason }
          : list,
      );
      assert.throws(() => validateScreening(body), {
        code: "list-unavailable",
      });
    }
    const body = screening();
    body.lists = body.lists.map((list) =>
      list.source === source
        ? {
            source,
            status: "unavailable",
            reason: "load-failed",
            editionId: null,
            publishedAt: null,
          }
        : list,
    );
    assert.throws(() => validateScreening(body), { code: "list-unavailable" });
  }
});

test("empty, incomplete, duplicate, unknown and malformed responses cannot pass", () => {
  for (const body of [
    null,
    {},
    { status: "clear", lists: [] },
    { ...screening(), lists: screening().lists.slice(1) },
    {
      ...screening(),
      lists: screening().lists.map(() => screening().lists.at(0)),
    },
    {
      ...screening(),
      lists: screening().lists.map((list) => ({
        ...list,
        source: "new-source",
      })),
    },
    {
      ...screening(),
      lists: screening().lists.map((list) => ({
        ...list,
        editionId: undefined,
      })),
    },
    {
      ...screening(),
      lists: screening().lists.map((list) => ({ ...list, reason: {} })),
    },
    {
      ...screening(),
      lists: screening().lists.map((list) => ({ ...list, publishedAt: 123 })),
    },
    {
      ...screening(),
      lists: screening().lists.map((list) => ({
        ...list,
        status: "unavailable",
        reason: "not-loaded",
        editionId: null,
        publishedAt: null,
      })),
    },
  ]) {
    assert.throws(() => validateScreening(body), CanaryFailureError);
  }
});

test("public request uses the real POST contract; non-200 and invalid JSON fail", async () => {
  const cases = [
    { status: 200, body: JSON.stringify(screening()), code: null },
    { status: 301, body: JSON.stringify(screening()), code: "http-status" },
    { status: 403, body: "denied", code: "http-status" },
    { status: 200, body: "{}", code: "invalid-response" },
    { status: 200, body: "invalid", code: "invalid-json" },
  ];
  for (const entry of cases) {
    const result = probe("https://my.example.test/api/v1/sanctions/search", {
      requestHttps: transport(entry.status, entry.body),
    });
    if (entry.code === null) {
      await result;
    } else {
      await assert.rejects(result, { code: entry.code });
    }
  }
});

test("scheduled entrypoint reports one safe result and the matching exit status", async () => {
  for (const healthy of [true, false]) {
    const logs: string[] = [];
    const body = screening();
    if (!healthy) {
      body.lists = body.lists.map((list) => ({
        ...list,
        status: "unavailable",
        reason: "load-failed",
        editionId: null,
        publishedAt: null,
      }));
    }
    const exitCode = await runCanary({
      targetUrl: "https://my.example.test/api/v1/sanctions/search",
      probe: (url) =>
        probe(url, { requestHttps: transport(200, JSON.stringify(body)) }),
      log: (line) => {
        logs.push(line);
      },
    });
    assert.equal(exitCode, healthy ? 0 : 1);
    assert.equal(logs.length, 1);
    assert.match(logs.at(0) ?? "", healthy ? /passed$/u : /list-unavailable$/u);
  }
});

test("hourly workflow failures reach both scheduled alert allowlists", () => {
  const workflow = readFileSync(
    new URL(
      "../.github/workflows/public-sanctions-canary.yml",
      import.meta.url,
    ),
    "utf-8",
  );
  const alerts = readFileSync(
    new URL("../.github/workflows/scheduled-run-alerts.yml", import.meta.url),
    "utf-8",
  );
  const name = workflow.match(/^name:\s*(.+)$/mu)?.at(1);
  assert.ok(name);
  assert.match(workflow, /cron:\s*["']41 \* \* \* \*["']/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /permissions: \{\}/u);
  assert.match(workflow, /contents: read/u);
  assert.match(workflow, /timeout-minutes: 5/u);
  assert.match(
    workflow,
    /sparse-checkout: scripts\/check-public-sanctions\.ts/u,
  );
  assert.match(workflow, /persist-credentials: false/u);
  assert.ok(alerts.split("types: [completed]").at(0)?.includes(`- ${name}`));
  assert.ok(
    alerts
      .split("if: >-")
      .at(1)
      ?.includes('".github/workflows/public-sanctions-canary.yml"'),
  );
});

test("aggregate status follows match, unavailable, then clear precedence", () => {
  for (const status of ["clear", "unavailable"]) {
    const body = screening();
    body.status = status;
    assert.throws(() => validateScreening(body), {
      code: "aggregate-mismatch",
    });
  }
  const body = screening();
  body.lists[0] = {
    source: "eu",
    status: "possible-match",
    reason: null,
    editionId: "published",
    publishedAt: "2026-10-01",
  };
  body.status = "possible-match";
  assert.doesNotThrow(() => validateScreening(body));
  body.lists[1] = {
    source: "un",
    status: "unavailable",
    reason: "not-loaded",
    editionId: null,
    publishedAt: null,
  };
  assert.doesNotThrow(() => validateScreening(body));
  body.status = "unavailable";
  assert.throws(() => validateScreening(body), { code: "aggregate-mismatch" });
});

test("malformed response names and arbitrary transport errors never enter logs", async () => {
  const sentinel = "SECRET_MATCH_NAME_SENTINEL";
  for (const transportFailure of [false, true]) {
    const logs: string[] = [];
    const requestHttps: RequestHttps = transportFailure
      ? () => {
          const request = new PassThrough();
          return Object.assign(request, {
            end() {
              queueMicrotask(() => request.emit("error", new Error(sentinel)));
            },
            destroy(error: Error) {
              request.emit("error", error);
            },
          });
        }
      : transport(200, `{"name":"${sentinel}", BROKEN`);
    const exitCode = await runCanary({
      targetUrl: "https://my.example.test/api/v1/sanctions/search",
      probe: (url) => probe(url, { requestHttps }),
      log: (line) => {
        logs.push(line);
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(logs.length, 1);
    assert.equal(
      logs.some((line) => line.includes(sentinel)),
      false,
    );
    assert.match(
      logs.at(0) ?? "",
      transportFailure ? /transport-failed$/u : /invalid-json$/u,
    );
  }
});

test("real HTTPS transport screens a response and rejects invalid bodies and redirects", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sanctions-https-test-"));
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certPath);
  let status = 200;
  let body = JSON.stringify(screening());
  const server = https.createServer(
    { key: readFileSync(keyPath), cert },
    (request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/v1/sanctions/search");
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
          subject: { type: "organization", name: "Voice of Europe" },
        });
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(body);
      });
    },
  );
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `https://localhost:${address.port}/api/v1/sanctions/search`;
    const requestHttps: RequestHttps = (target, options, onResponse) =>
      https.request(
        target,
        {
          ...options,
          ca: cert,
          family: 4,
        },
        onResponse,
      );
    await probe(url, { requestHttps });
    body = '{"name":"SECRET_MATCH_NAME_SENTINEL", BROKEN';
    await assert.rejects(probe(url, { requestHttps }), {
      code: "invalid-json",
    });
    status = 302;
    await assert.rejects(probe(url, { requestHttps }), { code: "http-status" });
    status = 200;
    body = "x".repeat(1024 * 1024 + 1);
    await assert.rejects(probe(url, { requestHttps }), {
      code: "response-too-large",
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the positive control refuses all clear and any declared source without a hit", () => {
  const allClear = screening();
  allClear.status = "clear";
  allClear.lists = allClear.lists.map((list) => ({ ...list, status: "clear" }));
  assert.throws(() => validateScreening(allClear), {
    code: "positive-control-missed",
  });
  for (const source of POSITIVE_CONTROL.expectedSources) {
    const body = screening();
    body.lists = body.lists.map((list) =>
      list.source === source ? { ...list, status: "clear" } : list,
    );
    assert.throws(() => validateScreening(body), {
      code: "positive-control-missed",
    });
  }
  assert.doesNotThrow(() => validateScreening(screening()));
});

test("edition fixtures produce every declared positive-control hit with the real matcher", async () => {
  const eu = (
    await parseEuList(
      Bun.file(
        new URL("../packages/sanctions/src/fixtures/eu.xml", import.meta.url),
      ).stream(),
    )
  ).unwrap();
  const czFile = "Vnitrostatni_sankcni_seznam_2026_07_23.csv";
  const cz = parseCzList({
    csv: await Bun.file(
      new URL(`../packages/sanctions/src/fixtures/${czFile}`, import.meta.url),
    ).text(),
    fileNameOrUrl: czFile,
  }).unwrap();
  const result = screen(
    buildScreeningIndex([eu, cz]),
    {
      name: POSITIVE_CONTROL.subject.name,
      entityType: "organisation",
    },
    { cutoff: DEFAULT_CUTOFF },
  ).unwrap();
  const matched = new Set(
    result.possibleMatches.map(({ entry }) => entry.source),
  );
  assert.deepEqual(
    [...matched].toSorted(),
    POSITIVE_CONTROL.expectedSources.toSorted(),
  );
});
