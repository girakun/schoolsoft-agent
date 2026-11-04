import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { IDENTITY_FORMAT, startConnector } from "../../src/http/start.js";
import { EncryptedRepository } from "../../src/http/storage.js";
import { SESSION_FORMAT, type PersistedSession } from "../../src/core/index.js";
test("production composition writes encrypted login and clears credentials without losing owner identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "connector-start-"));
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, "close");
  const env = {
    SCHOOLSOFT_PUBLIC_URL: "https://connector.example",
    SCHOOLSOFT_ADMIN_PASSWORD: "synthetic-admin-password-0123456789",
    SCHOOLSOFT_STORAGE_KEY: "a".repeat(64),
    SCHOOLSOFT_SCHOOL: "synthetic",
    SCHOOLSOFT_STATE_DIR: dir,
    PORT: String(port),
  };
  const { server, runtime } = startConnector(env, {
    fetchImpl: async (url: string) => {
      if (url.includes("/login/token"))
        return {
          status: 200,
          data: { access_token: "PRIVATE_TOKEN", refresh_token: "PRIVATE_REFRESH", expires: 3600 },
          headers: {},
          setCookies: [],
        };
      if (url.endsWith("/eva/api/v1/parent"))
        return {
          status: 200,
          data: {
            userId: 1,
            firstName: "Synthetic",
            lastName: "Parent",
            children: [
              {
                studentId: 2,
                firstName: "Synthetic Child",
                schools: [{ orgId: 3, name: "Synthetic School" }],
              },
            ],
          },
          headers: {},
          setCookies: [],
        };
      return {
        status: 303,
        data: "",
        headers: {},
        setCookies: ["JSESSIONID=synthetic; Path=/", "hash=synthetic; Path=/"],
      };
    },
  });
  await once(server, "listening");
  try {
    assert.equal((await runtime.status()).authenticated, false);
    const { url } = await runtime.beginLogin();
    assert.equal(
      new URLSearchParams(url.split("?")[1]).get("redirect_uri"),
      env.SCHOOLSOFT_PUBLIC_URL + "/schoolsoft/callback",
      "BankID returns to the connector, not the browser computer's localhost",
    );
    assert.equal(
      runtime.callback(new URLSearchParams(url.split("?")[1]).get("state")!, "synthetic-code"),
      true,
    );
    assert.equal(
      ((await runtime.execute("list_children", {}, [2])) as { children: unknown[] }).children
        .length,
      1,
    );
    const data = readFileSync(join(dir, "session.enc"));
    assert.ok(!data.includes("PRIVATE_TOKEN"));
    assert.ok(!data.includes("Synthetic Child"));
    await runtime.logout();
    assert.equal((await runtime.status()).authenticated, false);
    assert.equal(
      new EncryptedRepository<{ identity: string }>(
        dir,
        "identity",
        Buffer.from(env.SCHOOLSOFT_STORAGE_KEY, "hex"),
        IDENTITY_FORMAT,
      ).read()?.identity,
      "schoolsoft:synthetic:1",
    );
    // Persist a stale/foreign-school envelope to exercise restoration through the disk adapter.
    new EncryptedRepository<PersistedSession>(
      dir,
      "session",
      Buffer.from(env.SCHOOLSOFT_STORAGE_KEY, "hex"),
      SESSION_FORMAT,
    ).write({ school: "other", data: {}, savedAt: 0, authMethod: "bankid-browser" });
    assert.equal((await runtime.status()).authenticated, false);
  } finally {
    await runtime.close();
    server.close();
    server.closeAllConnections();
    await once(server, "close");
    rmSync(dir, { recursive: true, force: true });
  }
});
