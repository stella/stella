import { readTestJson } from "@/api/tests/helpers/test-tool-set";

/**
 * Load test for the file upload endpoint.
 *
 * Generates N minimal PDFs and uploads them with configurable
 * concurrency. Reports throughput, latency percentiles, and
 * error breakdown.
 *
 * Usage:
 *   bun run apps/api/src/tests/load/upload-load.ts \
 *     --files 300 \
 *     --concurrency 10 \
 *     --workspace <workspaceId> \
 *     --base-url http://localhost:3001
 *
 * Authentication:
 *   --email <email> --password <password>
 *   OR
 *   --cookie <session-cookie-value>
 */

const HTTP_TOO_MANY_REQUESTS = 429;

// -- Minimal valid PDF --

const MINIMAL_PDF = [
  "%PDF-1.0",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj",
  "xref",
  "0 4",
  "0000000000 65535 f ",
  "0000000009 00000 n ",
  "0000000058 00000 n ",
  "0000000115 00000 n ",
  "trailer<</Size 4/Root 1 0 R>>",
  "startxref",
  "164",
  "%%EOF",
].join("\n");

const makePdf = (index: number): File => {
  const blob = new Blob([MINIMAL_PDF], {
    type: "application/pdf",
  });
  return new File([blob], `load-test-${index}.pdf`, {
    type: "application/pdf",
  });
};

// -- CLI args --

type Args = {
  files: number;
  concurrency: number;
  workspaceId: string;
  baseUrl: string;
  email: string | null;
  password: string | null;
  cookie: string | null;
  propertyId: string | null;
};

const parseArgs = (): Args => {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length) {
      return null;
    }
    return args[idx + 1] ?? null;
  };

  const workspaceId = get("--workspace");
  if (!workspaceId) {
    console.error("--workspace is required");
    process.exit(1);
  }

  return {
    files: Number(get("--files") ?? "100"),
    concurrency: Number(get("--concurrency") ?? "5"),
    workspaceId,
    baseUrl: get("--base-url") ?? "http://localhost:3001",
    email: get("--email"),
    password: get("--password"),
    cookie: get("--cookie"),
    propertyId: get("--property"),
  };
};

// -- Auth --

const authenticate = async (
  baseUrl: string,
  email: string,
  password: string,
): Promise<string> => {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });

  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(`Auth failed (${response.status}): no set-cookie header`);
  }

  // Extract the session cookie name and value. Dev runs may use a
  // per-port cookie prefix so multiple localhost servers can coexist.
  const match = /^([^=]*\.session_token)=([^;]+)/.exec(setCookie);
  if (!match) {
    throw new Error("Could not parse session cookie");
  }

  return `${match[1]}=${match[2]}`;
};

// -- Upload --

type UploadResult = {
  fileIndex: number;
  durationMs: number;
  status: number;
  ok: boolean;
};

const uploadFile = async (
  file: File,
  fileIndex: number,
  baseUrl: string,
  workspaceId: string,
  propertyId: string,
  cookie: string,
): Promise<UploadResult> => {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("name", file.name);
  formData.append("propertyId", propertyId);
  formData.append("queryKey", JSON.stringify(["entities", workspaceId]));

  const start = performance.now();
  try {
    const response = await fetch(
      `${baseUrl}/v1/entities/${workspaceId}/upload`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: formData,
      },
    );
    return {
      fileIndex,
      durationMs: performance.now() - start,
      status: response.status,
      ok: response.ok,
    };
  } catch {
    return {
      fileIndex,
      durationMs: performance.now() - start,
      status: 0,
      ok: false,
    };
  }
};

// -- Concurrency pool --

const runPool = async <T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> => {
  const results: T[] = [];
  let index = 0;

  const worker = async () => {
    while (index < tasks.length) {
      const taskIndex = index++;
      const task = tasks[taskIndex];
      if (!task) {
        continue;
      }
      results[taskIndex] = await task();
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    // eslint-disable-next-line require-await
    async () => worker(),
  );
  await Promise.all(workers);
  return results;
};

// -- Stats --

const percentile = (sorted: number[], p: number): number => {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
};

const printStats = (results: UploadResult[], elapsedMs: number) => {
  const durations = results.map((r) => r.durationMs).toSorted((a, b) => a - b);

  const successes = results.filter((r) => r.ok).length;
  const rateLimited = results.filter(
    (r) => r.status === HTTP_TOO_MANY_REQUESTS,
  ).length;
  const otherErrors = results.filter(
    (r) => !r.ok && r.status !== HTTP_TOO_MANY_REQUESTS,
  ).length;

  console.log("\n--- Upload Load Test Results ---\n");
  console.log(`Files:        ${results.length}`);
  console.log(`Successes:    ${successes}`);
  console.log(`429 (rate):   ${rateLimited}`);
  console.log(`Other errors: ${otherErrors}`);
  console.log(
    `Throughput:   ${(successes / (elapsedMs / 1000)).toFixed(1)} files/s`,
  );
  console.log(`p50 latency:  ${percentile(durations, 50).toFixed(0)}ms`);
  console.log(`p95 latency:  ${percentile(durations, 95).toFixed(0)}ms`);
  console.log(`p99 latency:  ${percentile(durations, 99).toFixed(0)}ms`);
  console.log(`Total time:   ${(elapsedMs / 1000).toFixed(1)}s`);

  // Status code breakdown
  const statusCounts = new Map<number, number>();
  for (const r of results) {
    statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
  }
  console.log("\nStatus breakdown:");
  for (const [status, count] of [...statusCounts.entries()].toSorted(
    (a, b) => a[0] - b[0],
  )) {
    console.log(`  ${status}: ${count}`);
  }
};

// -- Main --

const main = async () => {
  const args = parseArgs();

  console.log(
    `Uploading ${args.files} files with concurrency ${args.concurrency}`,
  );
  console.log(`Target: ${args.baseUrl}`);
  console.log(`Workspace: ${args.workspaceId}`);

  // Authenticate
  let cookie: string;
  if (args.cookie) {
    cookie = args.cookie;
  } else if (args.email && args.password) {
    console.log(`Authenticating as ${args.email}...`);
    cookie = await authenticate(args.baseUrl, args.email, args.password);
    console.log("Authenticated.");
  } else {
    console.error("Provide --cookie or --email + --password");
    process.exit(1);
  }

  // Resolve property ID (find first file property)
  let { propertyId } = args;
  if (!propertyId) {
    const response = await fetch(
      `${args.baseUrl}/v1/properties/${args.workspaceId}`,
      { headers: { Cookie: cookie } },
    );
    if (!response.ok) {
      console.error(`Failed to fetch properties: ${response.status}`);
      process.exit(1);
    }
    type Property = {
      id: string;
      content: { type: string };
    };
    const properties = await readTestJson<Property[]>(response);
    const fileProp = properties.find((p) => p.content.type === "file");
    if (fileProp === undefined) {
      console.error(
        "No file property found in workspace. Upload a file first.",
      );
      process.exit(1);
    }
    propertyId = fileProp.id;
    console.log(`Using property: ${propertyId}`);
  }

  if (!propertyId) {
    console.error("Could not resolve property ID");
    process.exit(1);
  }

  // Generate files
  console.log(`Generating ${args.files} PDFs...`);
  const files = Array.from({ length: args.files }, (_, i) => makePdf(i));

  // Build task list
  const tasks = files.map(
    (file, i) =>
      // eslint-disable-next-line require-await
      async () =>
        uploadFile(file, i, args.baseUrl, args.workspaceId, propertyId, cookie),
  );

  // Run
  console.log("Uploading...\n");
  const start = performance.now();
  const results = await runPool(tasks, args.concurrency);
  const elapsed = performance.now() - start;

  printStats(results, elapsed);
};

main().catch((error: unknown) => {
  console.error("Fatal:", error);
  process.exit(1);
});
