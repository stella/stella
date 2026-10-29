import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { publishToStore, type StoreClient } from "./publish-store";

const VERSION = "0.9.70";
const ZIP = new Blob(["zip"], { type: "application/zip" });

type Revision = { state: string; versions: string[] };

type FakeStore = {
  published?: Revision;
  /** Cleared when a submission is cancelled. */
  submitted?: Revision | undefined;
  takenDown?: boolean;
  /** What the upload call answers; `processing` reports in-progress first. */
  upload:
    | { kind: "accepts"; crxVersion: string }
    | { kind: "processing"; polls: string[] }
    | { kind: "rejects"; status: number };
  publishState?: string;
  /** Replaces the fetchStatus body, for malformed answers. */
  rawStatus?: string;
};

const revision = ({ state, versions }: Revision) => ({
  distributionChannels: versions.map((crxVersion) => ({
    crxVersion,
    deployPercentage: 100,
  })),
  state,
});

const runStore = async (store: FakeStore) => {
  const calls: string[] = [];
  const lines: string[] = [];
  let polls = store.upload.kind === "processing" ? [...store.upload.polls] : [];
  let uploaded = false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const client: StoreClient = {
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer token-value");
      const action = path.slice(path.lastIndexOf(":") + 1);
      calls.push(`${method} ${action}`);
      if (action === "fetchStatus") {
        if (store.rawStatus !== undefined) {
          return new Response(store.rawStatus);
        }
        const lastAsyncUploadState = uploaded ? polls.shift() : undefined;
        return json({
          itemId: "item",
          lastAsyncUploadState,
          name: "item",
          publishedItemRevisionStatus:
            store.published && revision(store.published),
          submittedItemRevisionStatus:
            store.submitted && revision(store.submitted),
          takenDown: store.takenDown ?? false,
        });
      }
      if (action === "cancelSubmission") {
        store.submitted = undefined;
        return new Response("");
      }
      if (action === "upload") {
        expect(path.startsWith("/upload/v2/")).toBe(true);
        expect(init.body).toBe(ZIP);
        uploaded = true;
        if (store.upload.kind === "rejects") {
          return json(
            { error: { message: "version not increased" } },
            store.upload.status,
          );
        }
        if (store.upload.kind === "processing") {
          polls = [...store.upload.polls];
          return json({ uploadState: "UPLOAD_IN_PROGRESS" });
        }
        return json({
          crxVersion: store.upload.crxVersion,
          uploadState: "SUCCEEDED",
        });
      }
      if (action === "publish") {
        if (
          typeof init.body !== "string" &&
          !(init.body instanceof URLSearchParams)
        ) {
          throw new Error("Expected a JSON publish request body");
        }
        expect(JSON.parse(String(init.body))).toEqual({
          publishType: "DEFAULT_PUBLISH",
        });
        const state = store.publishState ?? "PENDING_REVIEW";
        store.submitted = { state, versions: [VERSION] };
        return json({
          state,
          warningInfo: {
            warnings: [{ description: "Broad host access", reason: "HOST" }],
          },
        });
      }
      throw new Error(`Unexpected call ${method} ${path}`);
    },
    log: (line) => {
      lines.push(line);
    },
    sleep: async () => undefined,
    token: "token-value",
  };
  const outcome = publishToStore(client, VERSION, ZIP);
  return { calls, lines, outcome };
};

describe("publishToStore", () => {
  test("submits a new version for review", async () => {
    const store: FakeStore = {
      published: { state: "PUBLISHED", versions: ["0.9.53"] },
      upload: { crxVersion: VERSION, kind: "accepts" },
    };
    const run = await runStore(store);
    expect(await run.outcome).toBe("submitted");
    expect(run.calls).toEqual([
      "GET fetchStatus",
      "POST upload",
      "POST publish",
    ]);
    expect(run.lines).toContain("Warning HOST: Broad host access");
    expect(run.lines.join("\n")).not.toContain("token-value");
  });

  test("a rerun after the submission changes nothing", async () => {
    const store: FakeStore = {
      published: { state: "PUBLISHED", versions: ["0.9.53"] },
      upload: { crxVersion: VERSION, kind: "accepts" },
    };
    await (
      await runStore(store)
    ).outcome;
    const rerun = await runStore(store);
    expect(await rerun.outcome).toBe("already-submitted");
    expect(rerun.calls).toEqual(["GET fetchStatus"]);
  });

  test("a version already live is left alone", async () => {
    const run = await runStore({
      published: { state: "PUBLISHED", versions: [VERSION] },
      upload: { crxVersion: VERSION, kind: "accepts" },
    });
    expect(await run.outcome).toBe("already-published");
    expect(run.calls).toEqual(["GET fetchStatus"]);
  });

  test("an older submission still in review is replaced", async () => {
    const run = await runStore({
      submitted: { state: "PENDING_REVIEW", versions: ["0.9.69"] },
      upload: { crxVersion: VERSION, kind: "accepts" },
    });
    expect(await run.outcome).toBe("submitted");
    expect(run.calls).toEqual([
      "GET fetchStatus",
      "POST cancelSubmission",
      "POST upload",
      "POST publish",
    ]);
  });

  test.each(["0.9.71", "0.9.100", "0.10.0", "1", "0.9.70.1"])(
    "a newer version %s is never replaced by an older release",
    async (version) => {
      for (const state of ["PENDING_REVIEW", "STAGED", "PUBLISHED"]) {
        const current = { state, versions: [version] };
        const run = await runStore({
          ...(state === "PUBLISHED"
            ? { published: current }
            : { submitted: current }),
          upload: { crxVersion: VERSION, kind: "accepts" },
        });
        expect(await rejectionOf(run.outcome)).toMatchObject({
          message: expect.stringContaining("Refusing to replace newer"),
        });
        expect(run.calls).toEqual(["GET fetchStatus"]);
      }
    },
  );

  test.each(["0.9.9", "0.8.100", "0.9.69.65535"])(
    "an older numeric version %s can be replaced",
    async (version) => {
      const run = await runStore({
        submitted: { state: "PENDING_REVIEW", versions: [version] },
        upload: { crxVersion: VERSION, kind: "accepts" },
      });
      expect(await run.outcome).toBe("submitted");
      expect(run.calls).toContain("POST cancelSubmission");
    },
  );

  test("omitted trailing zero components identify the same submitted version", async () => {
    const run = await runStore({
      submitted: { state: "PENDING_REVIEW", versions: [`${VERSION}.0`] },
      upload: { crxVersion: VERSION, kind: "accepts" },
    });
    expect(await run.outcome).toBe("already-submitted");
    expect(run.calls).toEqual(["GET fetchStatus"]);
  });

  test.each(
    [[], [""], ["0.9.70-rc.1"], ["0.9.65536"], ["0.9.071"], ["0.0.0"]].map(
      (versions) => ({ versions }),
    ),
  )(
    "an active revision with unknown or invalid versions $versions is never replaced",
    async ({ versions }) => {
      const run = await runStore({
        submitted: { state: "PENDING_REVIEW", versions },
        upload: { crxVersion: VERSION, kind: "accepts" },
      });
      expect(await rejectionOf(run.outcome)).toMatchObject({
        message: expect.stringMatching(
          /no version|Invalid Chrome Web Store version/u,
        ),
      });
      expect(run.calls).toEqual(["GET fetchStatus"]);
    },
  );

  test("an active revision missing its version is never replaced", async () => {
    const run = await runStore({
      rawStatus: JSON.stringify({
        submittedItemRevisionStatus: {
          distributionChannels: [{}],
          state: "PENDING_REVIEW",
        },
      }),
      upload: { crxVersion: VERSION, kind: "accepts" },
    });
    expect(await rejectionOf(run.outcome)).toMatchObject({
      message: expect.stringContaining("no version"),
    });
    expect(run.calls).toEqual(["GET fetchStatus"]);
  });

  test("a rejected older submission is not cancelled", async () => {
    const run = await runStore({
      submitted: { state: "REJECTED", versions: ["0.9.69"] },
      upload: { crxVersion: VERSION, kind: "accepts" },
    });
    expect(await run.outcome).toBe("submitted");
    expect(run.calls).not.toContain("POST cancelSubmission");
  });

  test("waits for an upload the store is still processing", async () => {
    const run = await runStore({
      upload: { kind: "processing", polls: ["IN_PROGRESS", "SUCCEEDED"] },
    });
    expect(await run.outcome).toBe("submitted");
    expect(run.calls).toEqual([
      "GET fetchStatus",
      "POST upload",
      "GET fetchStatus",
      "GET fetchStatus",
      "POST publish",
    ]);
  });

  test("an upload that fails while processing stops before publishing", async () => {
    const run = await runStore({
      upload: { kind: "processing", polls: ["FAILED"] },
    });
    expect(await rejectionOf(run.outcome)).toMatchObject({
      message: expect.stringContaining("upload ended in state FAILED"),
    });
    expect(run.calls).not.toContain("POST publish");
  });

  test("an upload that never finishes times out", async () => {
    const run = await runStore({
      upload: {
        kind: "processing",
        polls: Array.from({ length: 40 }, () => "IN_PROGRESS"),
      },
    });
    expect(await rejectionOf(run.outcome)).toMatchObject({
      message: expect.stringContaining("did not finish in time"),
    });
    expect(run.calls).not.toContain("POST publish");
  });

  test("a refused upload fails the run with the store's reason", async () => {
    const run = await runStore({ upload: { kind: "rejects", status: 400 } });
    expect(await rejectionOf(run.outcome)).toMatchObject({
      message: expect.stringMatching(
        /failed with 400: .*version not increased/u,
      ),
    });
    expect(run.calls).not.toContain("POST publish");
  });

  test("an upload of another version is not published", async () => {
    const run = await runStore({
      upload: { crxVersion: "0.9.1", kind: "accepts" },
    });
    expect(await rejectionOf(run.outcome)).toMatchObject({
      message: expect.stringContaining("accepted version 0.9.1"),
    });
    expect(run.calls).not.toContain("POST publish");
  });

  test("a rejected publish fails the run", async () => {
    const run = await runStore({
      publishState: "REJECTED",
      upload: { crxVersion: VERSION, kind: "accepts" },
    });
    expect(await rejectionOf(run.outcome)).toMatchObject({
      message: expect.stringContaining("publish ended in state REJECTED"),
    });
  });

  test("a taken-down item is never touched", async () => {
    const run = await runStore({
      takenDown: true,
      upload: { crxVersion: VERSION, kind: "accepts" },
    });
    expect(await rejectionOf(run.outcome)).toMatchObject({
      message: expect.stringContaining("taken down"),
    });
    expect(run.calls).toEqual(["GET fetchStatus"]);
  });

  test("an unknown item state fails closed", async () => {
    const run = await runStore({
      rawStatus: JSON.stringify({
        submittedItemRevisionStatus: { state: "SOMETHING_NEW" },
      }),
      upload: { crxVersion: VERSION, kind: "accepts" },
    });
    expect(await rejectionOf(run.outcome)).toMatchObject({
      message: expect.stringContaining("unexpected response"),
    });
    expect(run.calls).toEqual(["GET fetchStatus"]);
  });
});
