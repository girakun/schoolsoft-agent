import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { bootServed } from "../helpers/reference.js";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("connector deployment recipes retain private state and require independent secrets", () => {
  const render = read("render.yaml");
  const compose = read("compose.connector.yaml");
  for (const key of [
    "SCHOOLSOFT_PUBLIC_URL",
    "SCHOOLSOFT_SCHOOL",
    "SCHOOLSOFT_ADMIN_PASSWORD",
    "SCHOOLSOFT_STORAGE_KEY",
    "SCHOOLSOFT_STATE_DIR",
    "SCHOOLSOFT_PROXY_HOPS",
  ]) {
    assert.ok(render.includes(key), `Render misses ${key}`);
    assert.ok(compose.includes(key), `Compose misses ${key}`);
  }
  // The connector trusts no forwarding header by default; each proxied recipe opts in.
  assert.match(read("compose.cloudflare.yaml"), /SCHOOLSOFT_PROXY_HOPS: "1"/);
  assert.match(render, /numInstances: 1/);
  assert.match(render, /autoDeployTrigger: off/);
  assert.match(render, /mountPath: \/data/);
  assert.match(render, /key: SCHOOLSOFT_ADMIN_PASSWORD\n\s+generateValue: true/);
  assert.match(render, /key: SCHOOLSOFT_STORAGE_KEY\n\s+generateValue: true/);
  assert.match(compose, /schoolsoft-state:\/data/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop: \[ALL\]/);
  assert.doesNotMatch(compose, /["']?3000:3000/);
  assert.match(read("deploy/Caddyfile.connector"), /reverse_proxy connector:3000/);
});

test("connector image uses reproducible installation, minimal runtime and a nonroot user", () => {
  const docker = read("Dockerfile.connector");
  assert.match(docker, /npm ci --ignore-scripts/);
  assert.match(docker, /npm prune --omit=dev --omit=optional --ignore-scripts/);
  assert.match(docker, /node node_modules\/playwright\/cli.js install --with-deps chromium/);
  assert.match(docker, /COPY --from=build .*node_modules\/playwright-core/);
  assert.match(docker, /COPY --from=production .*node_modules/);
  assert.doesNotMatch(docker, /npx playwright/);
  assert.match(docker, /PLAYWRIGHT_BROWSERS_PATH=\/opt\/playwright/);
  assert.match(read("deploy/connector-entrypoint.mjs"), /process\.setuid\(1000\)/);
  assert.match(docker, /chmod 700 \/data/);
  assert.match(docker, /CMD \["node", "deploy\/connector-entrypoint.mjs"\]/);
  assert.doesNotMatch(docker, /COPY \. /);
  const ignored = read(".dockerignore")
    .split("\n")
    .filter((line) => !line.startsWith("#") && line);
  assert.deepEqual(ignored, [
    "*",
    "!package.json",
    "!package-lock.json",
    "!tsconfig.json",
    "!src/",
    "!src/**",
    "!deploy/",
    "!deploy/connector-entrypoint.mjs",
  ]);
});

test("parent guide discloses live acceptance limits, data access and recovery", () => {
  const guide = read("docs/deployment/connector.md");
  for (const required of [
    "Release candidate",
    "one guardian account",
    "hosting provider",
    "storage key",
    "backup",
    "BankID yourself",
    "Checkpoint",
    "does not mean that only you",
    "revok",
    "compose.connector.yaml",
  ])
    assert.ok(guide.includes(required), `Guide must explain ${required}`);
});

const bin = join(process.cwd(), "dist/http/index.js");
const skip = existsSync(bin) ? false : "run npm run build first";

test("built connector rejects incomplete settings without printing secrets", { skip }, () => {
  const result = spawnSync(process.execPath, [bin], {
    env: { SCHOOLSOFT_ADMIN_PASSWORD: "synthetic-secret-that-must-not-be-logged" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Check the required settings/);
  assert.doesNotMatch(result.stderr + result.stdout, /synthetic-secret/);
});

test(
  "built connector serves health, denies anonymous MCP and exits cleanly",
  { skip, timeout: 10000 },
  async () => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );
    const stateDir = mkdtempSync(join(tmpdir(), "connector-artifact-"));
    const child = spawn(process.execPath, [bin], {
      env: {
        PORT: String(address.port),
        SCHOOLSOFT_PUBLIC_URL: `https://127.0.0.1:${address.port}`,
        SCHOOLSOFT_SCHOOL: "synthetic-fixture",
        SCHOOLSOFT_STATE_DIR: stateDir,
        SCHOOLSOFT_ADMIN_PASSWORD: "synthetic-admin-secret-never-a-real-parent",
        SCHOOLSOFT_STORAGE_KEY: "ab".repeat(32),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    try {
      const url = `http://127.0.0.1:${address.port}`;
      let healthy = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const response = await fetch(url + "/healthz");
          healthy = response.ok;
          await response.body?.cancel();
          if (healthy) break;
        } catch {
          /* The child may still be starting. */
        }
        if (child.exitCode !== null) break;
        await delay(50);
      }
      assert.ok(healthy, `Connector did not start: ${output}`);
      const protectedResponse = await fetch(url + "/mcp");
      assert.equal(protectedResponse.status, 401);
      await protectedResponse.body?.cancel();
      // The reference page from the built output (tsc's app.js), hashed as served and runnable.
      const page = await fetch(url + "/reference/");
      assert.equal(page.status, 200);
      const html = await page.text();
      const script = /<script type="module">([\s\S]*)<\/script>/.exec(html)![1];
      const hash = createHash("sha256").update(script).digest("base64");
      assert.ok(
        page.headers.get("content-security-policy")!.includes(`script-src 'sha256-${hash}'`),
      );
      assert.doesNotMatch(script, /sourceMappingURL|^\s*import\s/m);
      assert.match(
        await bootServed(script.replace(/boot\(globalThis\);\n$/, "")),
        /data-action="connect"/,
      );
      child.kill("SIGTERM");
      const [code, signal] = await exited;
      assert.equal(code, 0, output);
      assert.equal(signal, null);
      assert.equal(output, "");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
);
