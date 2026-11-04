import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createConnectorApp } from "../../src/http/server.js";
import { connectorConfig } from "../../src/http/config.js";
import { ConnectorOAuthProvider } from "../../src/http/oauth.js";

async function fixture(t: TestContext, methods = true) {
  const config = connectorConfig({
    SCHOOLSOFT_PUBLIC_URL: "https://connector.example",
    SCHOOLSOFT_ADMIN_PASSWORD: "synthetic-qr-owner-password-0123456789",
    SCHOOLSOFT_STORAGE_KEY: "a".repeat(64),
    SCHOOLSOFT_SCHOOL: "synthetic",
    SCHOOLSOFT_LOGIN_MODE: "qr",
  });
  let svg: string | undefined = "<svg>synthetic</svg>";
  let state: "pending" | "complete" | "failed" = "pending";
  const app = createConnectorApp({
    config,
    oauth: new ConnectorOAuthProvider({
      resourceUrl: config.publicUrl + "/mcp",
      scopes: [],
      repository: { read: () => undefined, write: () => {} },
    }),
    runtime: {
      beginLogin: async () => ({ url: "/owner/schoolsoft/qr" }),
      callback: () => false,
      status: async () => ({
        authenticated: false,
        loginInProgress: false,
        children: [],
        portal: { state: "ok", retryAt: null },
      }),
      execute: async () => ({}),
      executeForChild: () => Promise.reject(new Error("overview is not under test")),
      logout: async () => {},
      ...(methods
        ? {
            qrImage: () => svg,
            qrStatus: async () => state,
            cancelQrLogin: () => {
              state = "failed";
            },
          }
        : {}),
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  let cookie = "";
  const request = (path: string, body?: Record<string, string>): Promise<Response> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        base + path,
        {
          method: body ? "POST" : "GET",
          headers: {
            Host: "connector.example",
            Cookie: cookie,
            ...(body
              ? { Origin: config.publicUrl, "Content-Type": "application/x-www-form-urlencoded" }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (b) => chunks.push(b));
          res.on("end", () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers))
              if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers }));
          });
        },
      );
      req.on("error", reject);
      req.end(body ? new URLSearchParams(body).toString() : undefined);
    });
  const login = async () => {
    const r = await request("/owner/login", { password: config.adminPassword });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
    const html = await (await request("/owner")).text();
    return /name="csrf" value="([^"]+)"/.exec(html)![1];
  };
  return {
    request,
    login,
    setImage: (value: string | undefined) => {
      svg = value;
    },
    setState: (value: typeof state) => {
      state = value;
    },
  };
}
test("QR routes require owner auth; starting needs CSRF and only image/status reach the browser", async (t) => {
  const f = await fixture(t);
  for (const path of [
    "/owner/schoolsoft/qr",
    "/owner/schoolsoft/qr/image",
    "/owner/schoolsoft/qr/status",
  ])
    assert.equal((await f.request(path)).status, 302);
  const csrf = await f.login();
  assert.equal((await f.request("/owner/schoolsoft/login", {})).status, 403);
  const started = await f.request("/owner/schoolsoft/login", { csrf });
  assert.equal(started.headers.get("location"), "/owner/schoolsoft/qr");
  const page = await f.request("/owner/schoolsoft/qr");
  const html = await page.text();
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  assert.ok(
    page.headers
      .get("content-security-policy")!
      .includes("sha256-" + createHash("sha256").update(script).digest("base64")),
  );
  assert.doesNotMatch(html, /grandidsession|code_verifier|unsafe-inline/);
  const image = await f.request("/owner/schoolsoft/qr/image");
  assert.equal(image.status, 200);
  assert.equal(await image.text(), "<svg>synthetic</svg>");
  assert.match(image.headers.get("content-security-policy")!, /sandbox/);
  assert.match(image.headers.get("content-type")!, /image\/svg/);
  assert.deepEqual(await (await f.request("/owner/schoolsoft/qr/status")).json(), {
    state: "pending",
  });
  f.setState("complete");
  assert.deepEqual(await (await f.request("/owner/schoolsoft/qr/status")).json(), {
    state: "complete",
  });
  f.setImage(undefined);
  assert.equal((await f.request("/owner/schoolsoft/qr/image")).status, 404);
  assert.equal((await f.request("/owner/schoolsoft/qr/cancel", {})).status, 403);
  assert.equal((await f.request("/owner/schoolsoft/qr/cancel", { csrf })).status, 302);
  assert.deepEqual(await (await f.request("/owner/schoolsoft/qr/status")).json(), {
    state: "failed",
  });
});
test("QR routes without a challenge never expose an image or claim a pending sign-in", async (t) => {
  const f = await fixture(t, false);
  const csrf = await f.login();
  assert.equal((await f.request("/owner/schoolsoft/qr/image")).status, 404);
  assert.deepEqual(await (await f.request("/owner/schoolsoft/qr/status")).json(), {
    state: "failed",
  });
  assert.equal((await f.request("/owner/schoolsoft/qr/cancel", { csrf })).status, 302);
});
