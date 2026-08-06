// Ban Bun's native S3 object-body reads.
//
// Up to and including Bun 1.3.14, `S3Client.file(key).bytes()` /
// `.arrayBuffer()` / `.text()` / `.json()` never free the native buffer the
// HTTP thread accumulates the response body into: the handler is invoked with
// `.clone` lifetime, JS receives its own copy, and the original allocation is
// stranded (oven-sh/bun#29083, fixed upstream by #29086 and #29923). The
// leaked allocation lives outside the JS heap, so it is invisible to heap
// snapshots and survives a forced GC — only RSS moves. Any process that reads
// a steady stream of objects grows by roughly the object size per read until
// the runtime kills it.
//
// One missed call site silently reintroduces that, and the symptom (RSS climb
// with a flat heap) is expensive to trace back, so this is a rule rather than
// a convention. Read through `readS3ArrayBuffer` / `readCorpusS3Bytes` in
// apps/api/src/lib/s3.ts, which fetch over a presigned URL instead.
//
// Remove this rule together with those helpers once every runtime image is on
// a stable Bun containing the fixes (the first stable AFTER 1.3.14 — they are
// not in 1.3.14 itself). See TODO(bun-s3-native-read).

import { isIdentifier } from "./utils.ts";

// Body-materialising reads only. `.exists()`, `.stat()`, `.write()`,
// `.delete()`, and `.presign()` carry no response body and do not leak.
const BODY_READS = new Set(["arrayBuffer", "bytes", "text", "json"]);

// Accessors that hand back a Bun S3 client. A local `new Bun.S3Client(...)`
// is caught through the `.file(...)` receiver check below instead.
const S3_ACCESSORS = new Set(["getS3", "getCorpusS3"]);

const isS3AccessorCall = (node) =>
  node?.type === "CallExpression" &&
  isIdentifier(node.callee) &&
  S3_ACCESSORS.has(node.callee.name);

/** True for `<something>.file(...)` — the call that yields the S3 file handle. */
const isFileCall = (node) =>
  node?.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  !node.callee.computed &&
  isIdentifier(node.callee.property, "file");

/** True when `.file(...)`'s receiver is recognisably an S3 client. */
const hasS3Receiver = (fileCall, s3Locals) => {
  const receiver = fileCall.callee.object;
  if (isS3AccessorCall(receiver)) {
    return true;
  }
  return isIdentifier(receiver) && s3Locals.has(receiver.name);
};

const bodyReadMethod = (member) => {
  if (!member.computed && isIdentifier(member.property)) {
    return member.property.name;
  }
  if (
    member.computed &&
    member.property.type === "Literal" &&
    typeof member.property.value === "string"
  ) {
    return member.property.value;
  }
  return null;
};

export default {
  meta: { name: "no-native-s3-object-read" },
  rules: {
    "no-native-s3-object-read": {
      meta: {
        type: "problem",
        messages: {
          noNativeS3ObjectRead:
            "Do not read an S3 object body with .{{method}}(); Bun 1.3.14 " +
            "leaks the native download buffer (oven-sh/bun#29083). Use " +
            "readS3ArrayBuffer() or readCorpusS3Bytes() from " +
            "@/api/lib/s3 instead.",
        },
      },
      create(context) {
        // Locals bound to a Bun S3 client, so a script that builds its own
        // `const s3 = new Bun.S3Client(...)` is covered too.
        const s3Locals = new Set();
        // Locals bound to an S3 *file handle*, for the two-step form
        // `const f = getS3().file(k); await f.arrayBuffer();`.
        const s3FileLocals = new Set();

        const isS3ClientConstruction = (init) =>
          init?.type === "NewExpression" &&
          ((isIdentifier(init.callee) && init.callee.name === "S3Client") ||
            (init.callee.type === "MemberExpression" &&
              !init.callee.computed &&
              isIdentifier(init.callee.property, "S3Client")));

        return {
          VariableDeclarator(node) {
            if (!isIdentifier(node.id)) {
              return;
            }
            if (
              isS3AccessorCall(node.init) ||
              isS3ClientConstruction(node.init)
            ) {
              s3Locals.add(node.id.name);
              return;
            }
            if (isFileCall(node.init) && hasS3Receiver(node.init, s3Locals)) {
              s3FileLocals.add(node.id.name);
            }
          },

          CallExpression(node) {
            const callee = node.callee;
            if (callee.type !== "MemberExpression") {
              return;
            }
            const method = bodyReadMethod(callee);
            if (!method || !BODY_READS.has(method)) {
              return;
            }

            const receiver = callee.object;
            const direct =
              isFileCall(receiver) && hasS3Receiver(receiver, s3Locals);
            const viaLocal =
              isIdentifier(receiver) && s3FileLocals.has(receiver.name);
            if (!direct && !viaLocal) {
              return;
            }

            context.report({
              node,
              messageId: "noNativeS3ObjectRead",
              data: { method },
            });
          },
        };
      },
    },
  },
};
