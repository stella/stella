import { panic } from "better-result";
import { expect, test } from "bun:test";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

import { dockerCommand, resolveDockerTarget } from "./dev-docker";

test.skipIf(!Bun.which("docker") || !Bun.which("openssl"))(
  "a captured Docker transport retains its endpoint and TLS credentials",
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "docker-context-tls-"));
    const cert = path.join(root, "cert.pem");
    const key = path.join(root, "key.pem");
    const config = path.join(root, "certificate.conf");
    writeFileSync(
      config,
      "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth,clientAuth\n",
    );
    const run = async (cmd: string[], env: NodeJS.ProcessEnv) => {
      const child = Bun.spawn(cmd, {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout: stdout.trim(), stderr, code };
    };
    const env = {
      PATH: process.env["PATH"],
      HOME: root,
      DOCKER_CONFIG: path.join(root, "docker"),
    };
    try {
      const generated = await run(
        [
          "openssl",
          "ecparam",
          "-name",
          "prime256v1",
          "-genkey",
          "-noout",
          "-out",
          key,
        ],
        env,
      );
      expect(generated.code, generated.stderr).toBe(0);
      const signed = await run(
        [
          "openssl",
          "req",
          "-new",
          "-x509",
          "-key",
          key,
          "-days",
          "1",
          "-out",
          cert,
          "-config",
          config,
        ],
        env,
      );
      expect(signed.code, signed.stderr).toBe(0);
      const certificate = readFileSync(cert);
      const server = createServer(
        {
          key: readFileSync(key),
          cert: certificate,
          ca: certificate,
          requestCert: true,
          rejectUnauthorized: true,
        },
        (request, response) => {
          response.setHeader("API-Version", "1.54");
          response.end(
            request.url?.endsWith("/_ping")
              ? "OK"
              : JSON.stringify({
                  Version: "tls-fixture",
                  ApiVersion: "1.54",
                  MinAPIVersion: "1.24",
                  Os: "linux",
                  Arch: "arm64",
                }),
          );
        },
      );
      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (address === null || typeof address === "string") {
          panic("TLS fixture did not acquire a TCP address.");
        }
        const host = `tcp://127.0.0.1:${address.port}`;
        const created = await run(
          [
            "docker",
            "context",
            "create",
            "tls-fixture",
            "--docker",
            `host=${host},ca=${cert},cert=${cert},key=${key}`,
          ],
          env,
        );
        expect(created.code, created.stderr).toBe(0);
        using target = resolveDockerTarget({
          env: { ...env, DOCKER_CONTEXT: "tls-fixture" },
        }).unwrap();
        expect(String(target.host)).toBe(host);
        const command = dockerCommand(target, [
          "version",
          "--format",
          "{{.Server.Version}}",
        ]);
        const result = await run(command.cmd, command.env);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe("tls-fixture");
        const snapshot = target.env["DOCKER_CERT_PATH"];
        if (!snapshot) {
          panic("TLS fixture did not acquire a credential snapshot.");
        }
        if (process.platform !== "win32") {
          expect(statSync(snapshot).mode % 0o1000).toBe(0o700);
          for (const name of ["ca.pem", "cert.pem", "key.pem"]) {
            expect(statSync(path.join(snapshot, name)).mode % 0o1000).toBe(
              0o600,
            );
          }
        }
        const replacementKey = path.join(root, "replacement-key.pem");
        const replacementCert = path.join(root, "replacement-cert.pem");
        const replacementGenerated = await run(
          [
            "openssl",
            "ecparam",
            "-name",
            "prime256v1",
            "-genkey",
            "-noout",
            "-out",
            replacementKey,
          ],
          env,
        );
        expect(replacementGenerated.code, replacementGenerated.stderr).toBe(0);
        const replacementSigned = await run(
          [
            "openssl",
            "req",
            "-new",
            "-x509",
            "-key",
            replacementKey,
            "-days",
            "1",
            "-out",
            replacementCert,
            "-config",
            config,
          ],
          env,
        );
        expect(replacementSigned.code, replacementSigned.stderr).toBe(0);
        const replacementCertificate = readFileSync(replacementCert);
        const replacementServer = createServer(
          {
            key: readFileSync(replacementKey),
            cert: replacementCertificate,
            ca: replacementCertificate,
            requestCert: true,
            rejectUnauthorized: true,
          },
          (request, response) => {
            response.setHeader("API-Version", "1.54");
            response.end(
              request.url?.endsWith("/_ping")
                ? "OK"
                : JSON.stringify({
                    Version: "replacement-fixture",
                    ApiVersion: "1.54",
                    MinAPIVersion: "1.24",
                    Os: "linux",
                    Arch: "arm64",
                  }),
            );
          },
        );
        try {
          replacementServer.listen(0, "127.0.0.1");
          await once(replacementServer, "listening");
          const replacementAddress = replacementServer.address();
          if (
            replacementAddress === null ||
            typeof replacementAddress === "string"
          ) {
            panic("Replacement TLS fixture did not acquire a TCP address.");
          }
          const updated = await run(
            [
              "docker",
              "context",
              "update",
              "tls-fixture",
              "--docker",
              `host=tcp://127.0.0.1:${replacementAddress.port},ca=${replacementCert},cert=${replacementCert},key=${replacementKey}`,
            ],
            env,
          );
          expect(updated.code, updated.stderr).toBe(0);
          const selected = await run(
            [
              "docker",
              "--context",
              "tls-fixture",
              "version",
              "--format",
              "{{.Server.Version}}",
            ],
            env,
          );
          expect(selected.code, selected.stderr).toBe(0);
          expect(selected.stdout).toBe("replacement-fixture");
          const retained = await run(command.cmd, command.env);
          expect(retained.code, retained.stderr).toBe(0);
          expect(retained.stdout).toBe("tls-fixture");
        } finally {
          replacementServer.closeAllConnections();
          replacementServer.close();
        }
        mkdirSync(path.join(root, "credentials"));
        copyFileSync(cert, path.join(root, "credentials", "ca.pem"));
        copyFileSync(cert, path.join(root, "credentials", "cert.pem"));
        copyFileSync(key, path.join(root, "credentials", "key.pem"));
        using defaultTarget = resolveDockerTarget({
          cwd: root,
          env: {
            ...env,
            DOCKER_CONFIG: "docker",
            DOCKER_HOST: host,
            DOCKER_TLS_VERIFY: "1",
            DOCKER_CERT_PATH: "credentials",
          },
        }).unwrap();
        const defaultCommand = dockerCommand(defaultTarget, [
          "version",
          "--format",
          "{{.Server.Version}}",
        ]);
        const defaultResult = await run(defaultCommand.cmd, defaultCommand.env);
        expect(defaultResult.code, defaultResult.stderr).toBe(0);
        expect(defaultResult.stdout).toBe("tls-fixture");
        target[Symbol.dispose]();
        expect(existsSync(snapshot)).toBe(false);
        target[Symbol.dispose]();
      } finally {
        server.closeAllConnections();
        server.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
