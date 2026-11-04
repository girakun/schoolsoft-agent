/** Explicit Docker artifact smoke: node test/packaging/connector-container.mjs [image].
 * Uses only synthetic state and --network none. No SchoolSoft or AI calls.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const image = process.argv[2] ?? "schoolsoft-connector:review";
const name = "schoolsoft-smoke-" + randomUUID();
const volume = name + "-state";
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const common = [
  "--network",
  "none",
  "--read-only",
  "--tmpfs",
  "/tmp:mode=1777,noexec,nosuid,size=256m",
  "--cap-drop",
  "ALL",
  "--cap-add",
  "CHOWN",
  "--cap-add",
  "SETUID",
  "--cap-add",
  "SETGID",
  "--cap-add",
  "KILL",
  "--security-opt",
  "no-new-privileges:true",
  "--mount",
  `type=volume,src=${volume},dst=/data,volume-nocopy`,
  "-e",
  "SCHOOLSOFT_PUBLIC_URL=https://connector.example.com",
  "-e",
  "SCHOOLSOFT_SCHOOL=synthetic-fixture",
  "-e",
  "SCHOOLSOFT_ADMIN_PASSWORD=synthetic-admin-password-for-container-test",
  "-e",
  "SCHOOLSOFT_STORAGE_KEY=" + "ab".repeat(32),
];
const node = (code) =>
  docker("exec", "--user", "1000:1000", name, "node", "--input-type=module", "-e", code);
async function health() {
  for (let i = 0; i < 50; i++) {
    try {
      assert.equal(
        node("const r=await fetch('http://127.0.0.1:3000/healthz');console.log(r.status)"),
        "200",
      );
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("Container did not become healthy");
}
try {
  docker("volume", "create", volume);
  // nocopy starts with a root-owned mount, matching a fresh external disk.
  docker("run", "-d", "--name", name, ...common, image);
  await health();
  assert.equal(
    node(`
    import {readFileSync,readdirSync} from 'node:fs';
    const pid=readdirSync('/proc').find(p=>{
      if(!/^\\d+$/.test(p)||Number(p)===process.pid)return false;
      try{const cmd=readFileSync('/proc/'+p+'/cmdline','utf8');return cmd.startsWith('node')&&cmd.includes('deploy/connector-entrypoint.mjs')}catch{return false}
    });
    if(!pid)throw Error('Runtime process missing');
    const status=readFileSync('/proc/'+pid+'/status','utf8');
    if(!/^Uid:\\s+1000\\s+1000\\s+1000\\s+1000$/m.test(status))throw Error('Runtime retained root');
    if(!/^CapEff:\\s+0+$/m.test(status))throw Error('Runtime retained capabilities');
    console.log('unprivileged');
  `),
    "unprivileged",
  );
  assert.equal(
    node(`
      import { chromium } from 'playwright';
      const browser = await chromium.launch({headless:true});
      try {
        const page = await browser.newPage();
        await page.setContent('<p id="fixture">synthetic browser read</p>');
        console.log(await page.locator('#fixture').textContent());
      } finally { await browser.close(); }
    `),
    "synthetic browser read",
  );
  const repo =
    "import {EncryptedRepository} from './dist/http/storage.js'; const r=new EncryptedRepository('/data','smoke',Buffer.from('ab'.repeat(32),'hex'),{migrations:[(d)=>d]});";
  assert.equal(node(repo + "r.write({fixture:true});console.log(r.read().fixture)"), "true");
  docker("restart", name);
  await health();
  assert.equal(node(repo + "console.log(r.read().fixture)"), "true");
  docker("stop", "--timeout", "5", name);
  assert.equal(
    docker("inspect", "--format", "{{.State.ExitCode}}", name),
    "0",
    docker("logs", name),
  );
  assert.equal(docker("logs", name), "");
  // Invalid mount configuration fails before importing HTTP or touching another path.
  assert.throws(() => docker("run", "--rm", ...common, "-e", "SCHOOLSOFT_STATE_DIR=/tmp", image));
  console.log(
    "Container smoke passed: fresh root-owned disk, uid 1000, no runtime capabilities, headless Chromium, encrypted persistence, restart and clean stop; no network.",
  );
} finally {
  try {
    docker("rm", "-f", name);
  } catch {
    /* Already removed or startup failed. */
  }
  try {
    docker("volume", "rm", volume);
  } catch {
    /* Preserve original failure. */
  }
}
