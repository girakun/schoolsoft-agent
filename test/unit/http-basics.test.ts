import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorConfig } from "../../src/http/config.js";
import { EncryptedRepository } from "../../src/http/storage.js";
import { unchanged } from "../../src/core/index.js";
const FORMAT = { migrations: [unchanged] };
import { OwnerSessions, OWNER_PASSWORD_MAX_BYTES } from "../../src/http/owner-session.js";
import { clientKey } from "../../src/http/client-key.js";
import { escapeHtml, page, form, hidden } from "../../src/http/pages.js";
const env = {
  SCHOOLSOFT_PUBLIC_URL: "https://connector.example",
  SCHOOLSOFT_ADMIN_PASSWORD: "synthetic-admin-password-0123456789",
  SCHOOLSOFT_STORAGE_KEY: "a".repeat(64),
  SCHOOLSOFT_SCHOOL: "example",
};
test("connector settings reject unsafe/missing configuration without disclosing secrets", () => {
  const cfg = connectorConfig(env);
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.stateDir, "/data");
  assert.equal(cfg.storageKey.length, 32);
  assert.equal(
    connectorConfig({
      ...env,
      SCHOOLSOFT_STORAGE_KEY: Buffer.alloc(32).toString("base64"),
      PORT: "4000",
      SCHOOLSOFT_STATE_DIR: "/private",
    }).port,
    4000,
  );
  for (const url of [
    undefined,
    "bad",
    "http://example.com",
    "https://a:b@example.com",
    "https://example.com?q=x",
    "https://example.com#x",
    "https://example.com/a",
    "https://example.com:443/?x",
  ])
    assert.throws(() => connectorConfig({ ...env, SCHOOLSOFT_PUBLIC_URL: url }));
  assert.throws(() =>
    connectorConfig({ ...env, SCHOOLSOFT_PUBLIC_URL: "https://:pw@example.com" }),
  );
  // Length alone is not enough: a correct password is never throttled, so the secret's
  // unpredictability is the guess protection and typed-in patterns are refused.
  for (const password of [undefined, "short", "p".repeat(32), "abcdefg".repeat(5)])
    assert.throws(() => connectorConfig({ ...env, SCHOOLSOFT_ADMIN_PASSWORD: password }));
  for (const key of [
    undefined,
    "short",
    Buffer.alloc(32).toString("base64").replace(/=$/, ""),
    "A".repeat(43) + "=garbage",
  ])
    assert.throws(() => connectorConfig({ ...env, SCHOOLSOFT_STORAGE_KEY: key }));
  for (const school of [undefined, "../x"])
    assert.throws(() => connectorConfig({ ...env, SCHOOLSOFT_SCHOOL: school }));
  for (const port of ["0", "65536", "1.2", "bad"])
    assert.throws(() => connectorConfig({ ...env, PORT: port }));
});
test("desktop OAuth callbacks require an explicit boolean opt-in", () => {
  assert.equal(connectorConfig(env).allowLoopbackClients, false);
  assert.equal(
    connectorConfig({ ...env, SCHOOLSOFT_ALLOW_LOOPBACK_CLIENTS: "1" }).allowLoopbackClients,
    true,
  );
  for (const value of ["true", "yes", "2", ""])
    assert.throws(() => connectorConfig({ ...env, SCHOOLSOFT_ALLOW_LOOPBACK_CLIENTS: value }));
});
test("encrypted repository authenticates files, writes atomically and survives restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "connector-storage-"));
  const key = Buffer.alloc(32, 3);
  try {
    const repository = new EncryptedRepository<{ secret: string }>(dir, "state", key, FORMAT);
    assert.equal(repository.read(), undefined);
    repository.clear();
    repository.write({ secret: "SYNTHETIC_PRIVATE_VALUE" });
    const filename = join(dir, "state.enc");
    const data = readFileSync(filename);
    assert.ok(!data.includes("SYNTHETIC_PRIVATE_VALUE"));
    assert.equal(statSync(filename).mode & 0o777, 0o600);
    assert.deepEqual(new EncryptedRepository(dir, "state", key, FORMAT).read(), {
      secret: "SYNTHETIC_PRIVATE_VALUE",
    });
    assert.throws(() => new EncryptedRepository(dir, "state", Buffer.alloc(32), FORMAT).read());
    data[28] ^= 1;
    writeFileSync(filename, data);
    assert.throws(() => repository.read());
    writeFileSync(filename, Buffer.from("broken"));
    assert.throws(() => repository.read());
    repository.write({ secret: "replaced" });
    assert.deepEqual(repository.read(), { secret: "replaced" });
    repository.clear();
    assert.equal(repository.read(), undefined);
    mkdirSync(filename);
    assert.throws(() => repository.read());
    assert.throws(() => repository.clear());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("owner sessions never refuse the correct password, expire, discard malformed cookies and reset", () => {
  let now = 0;
  const sessions = new OwnerSessions("correct", () => now);
  assert.equal(sessions.get(undefined), undefined);
  assert.equal(sessions.get("other=x"), undefined);
  assert.equal(sessions.get("__Host-owner=unknown"), undefined);
  assert.equal(sessions.login(12), undefined);
  assert.equal(sessions.login("incorrc"), undefined);
  const result = sessions.login("correct")!;
  assert.ok(result);
  assert.equal(sessions.get("other=x; __Host-owner=" + result.token), result.session);
  // However many guesses came before, from whomever: the owner still gets in.
  for (let i = 0; i < 100; i++) assert.equal(sessions.login("wrong-" + i), undefined);
  assert.ok(sessions.login("correct"));
  assert.equal(sessions.matches("correct"), true);
  assert.equal(sessions.matches("wrong"), false);
  assert.equal(sessions.matches(["correct"]), false);
  now += 30 * 60_000;
  assert.equal(sessions.get("__Host-owner=" + result.token), undefined);
  for (let i = 0; i < 18; i++) {
    now += 60_001;
    assert.ok(sessions.login("correct"));
  }
  const last = sessions.login("correct")!;
  sessions.clear();
  assert.equal(sessions.get("__Host-owner=" + last.token), undefined);
  assert.ok(new OwnerSessions("a").login("a"));
});
test("owner password comparison rejects wrong-length, same-length and non-string candidates", () => {
  const secret = "synthetic-owner-secret-0123456789abcdef";
  const attempt = (sessions: OwnerSessions, candidate: unknown) => sessions.login(candidate);
  const sessions = new OwnerSessions(secret, () => 0);
  for (const wrongLength of ["", "s", secret.slice(0, -1), secret + "x", secret.repeat(2)])
    assert.equal(attempt(sessions, wrongLength), undefined, JSON.stringify(wrongLength));
  const sameLength = secret.slice(0, -1) + "X";
  assert.equal(sameLength.length, secret.length);
  assert.equal(attempt(sessions, sameLength), undefined);
  assert.equal(attempt(sessions, "X" + secret.slice(1)), undefined);
  for (const nonString of [undefined, null, 12, true, [secret], { password: secret }])
    assert.equal(attempt(sessions, nonString), undefined, JSON.stringify(nonString));
  assert.ok(attempt(sessions, secret));
  // Multi-byte secrets compare by bytes; a different string of equal UTF-16 length fails.
  const unicode = new OwnerSessions("lösenord-åäö", () => 0);
  assert.equal(unicode.login("losenord-aao"), undefined);
  assert.ok(unicode.login("lösenord-åäö"));
  // The fixed slot: zero padding is not part of the secret, and a candidate longer than
  // the slot never matches, also when it starts with the secret or fills the slot exactly.
  assert.equal(attempt(sessions, secret + "\0"), undefined);
  assert.equal(attempt(sessions, secret + "x".repeat(OWNER_PASSWORD_MAX_BYTES)), undefined);
  assert.equal(attempt(sessions, secret + "x".repeat(70_000)), undefined);
  const longest = "k".repeat(OWNER_PASSWORD_MAX_BYTES);
  const full = new OwnerSessions(longest, () => 0);
  assert.ok(full.login(longest));
  assert.equal(full.login(longest + "k"), undefined);
  assert.equal(full.login(longest.slice(1)), undefined);
  assert.throws(
    () =>
      connectorConfig({
        ...env,
        SCHOOLSOFT_ADMIN_PASSWORD: "synthetic-0123456789".repeat(60),
      }),
    /at most 1022 bytes/,
  );
});
test("HTML rendering escapes every interpolated field", () => {
  assert.equal(escapeHtml("&<>\"'"), "&amp;&lt;&gt;&quot;&#39;");
  assert.match(page("<script>", "<p>trusted</p>"), /&lt;script&gt;/);
  assert.match(form('"', '"', "trusted", "<"), /&quot;/);
  assert.match(hidden("<", '"'), /&lt;/);
});

test("dashboard sign-out preserves other sessions; proxy hops default to none and are bounded", () => {
  const sessions = new OwnerSessions("correct", () => 0);
  const owner = sessions.login("correct")!;
  const other = sessions.login("correct")!;
  sessions.logout("__Host-owner=" + owner.token);
  assert.equal(sessions.get("__Host-owner=" + owner.token), undefined);
  assert.ok(sessions.get("__Host-owner=" + other.token));
  sessions.logout(undefined);
  for (const hops of ["bad", "-1", "3", "1.5"])
    assert.throws(() => connectorConfig({ ...env, SCHOOLSOFT_PROXY_HOPS: hops }));
  assert.equal(connectorConfig(env).proxyHops, 0, "no forwarding header is trusted by default");
  assert.equal(connectorConfig({ ...env, SCHOOLSOFT_PROXY_HOPS: "2" }).proxyHops, 2);
});

test("callers are keyed by IPv4 address or IPv6 /64 so address rotation shares one budget", () => {
  assert.equal(clientKey("203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.notEqual(clientKey("203.0.113.7"), clientKey("203.0.113.8"));
  assert.equal(clientKey("2001:db8:1:2::1"), clientKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
  assert.notEqual(clientKey("2001:db8:1:2::1"), clientKey("2001:db8:1:3::1"));
  assert.equal(clientKey(undefined), "unknown");
});
