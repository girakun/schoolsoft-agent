import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { runQrLogin } from "../../src/providers/schoolsoft/auth/qr-flow.js";
import type { QrAuthorizationRequest } from "../../src/core/index.js";
import type { TokenFetch } from "../../src/providers/schoolsoft/auth/oauth.js";

function fixture(
  options: {
    response?: (
      path: string,
      query: URLSearchParams,
    ) => { status: number; data: unknown } | undefined;
    authorize?: (request: QrAuthorizationRequest) => Promise<string>;
    userType?: string;
    clientId?: string;
  } = {},
) {
  const requests: URL[] = [];
  let request: QrAuthorizationRequest;
  const fetchImpl: TokenFetch = async (url, school, init) => {
    const u = new URL(url);
    requests.push(u);
    assert.equal(school, "synthetic");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    const path = u.pathname.split("/secure")[1];
    return (
      options.response?.(path, u.searchParams) ?? {
        status: 200,
        data:
          path === ""
            ? {
                sessionId: "synthetic-session",
                QRCode: Buffer.from("<svg>initial</svg>").toString("base64"),
              }
            : path === "/collect"
              ? { username: "Synthetic Parent" }
              : {
                  redirect_uri:
                    "com.schoolsoft.vapp://?" +
                    new URLSearchParams({
                      state: u.searchParams.get("state")!,
                      code: "synthetic-code",
                    }),
                },
      }
    );
  };
  const run = () =>
    runQrLogin({
      school: "synthetic",
      userType: options.userType ?? "parent",
      clientId: options.clientId ?? "vApp",
      fetchImpl,
      authorize: async (r) => {
        request = r;
        return options.authorize ? options.authorize(r) : (await r.poll()).code!;
      },
    });
  return { run, requests, request: () => request! };
}

test("QR login uses the registered guardian redirect and keeps PKCE through every step", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.code, "synthetic-code");
  assert.equal(f.request().qrSvg, "<svg>initial</svg>");
  assert.equal(f.requests.length, 3);
  for (const u of f.requests) {
    assert.equal(u.searchParams.get("redirect_uri"), "com.schoolsoft.vapp://");
    assert.equal(u.searchParams.get("client_id"), "vApp");
    assert.equal(
      u.searchParams.get("code_challenge"),
      createHash("sha256").update(result.verifier).digest("base64url"),
    );
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  }
  assert.equal(f.requests[1].searchParams.get("grandidsession"), "synthetic-session");
});
test("QR login is guardian-only and validates startup without exposing upstream data", async () => {
  for (const options of [{ userType: "student" }, { clientId: "eApp" }])
    await assert.rejects(fixture(options).run(), /guardian app/);
  for (const data of [
    null,
    {},
    { sessionId: "" },
    { sessionId: "s", QRCode: 0 },
    { sessionId: "s", QRCode: "" },
  ])
    await assert.rejects(fixture({ response: () => ({ status: 200, data }) }).run());
  for (const status of [401, 503])
    await assert.rejects(
      fixture({ response: () => ({ status, data: { private: "must not leave" } }) }).run(),
      (e: Error) => !e.message.includes("must not leave"),
    );
});
test("QR polls update the image, tolerate pending without an image, and stop on failed BankID", async () => {
  let step = 0;
  const f = fixture({
    response: (path) =>
      path === "/collect"
        ? {
            status: 200,
            data:
              ++step === 1
                ? {
                    grandidObject: {
                      QRCode: Buffer.from("<svg>next</svg>").toString("base64"),
                      message: { status: "pending" },
                    },
                  }
                : step === 2
                  ? {}
                  : { grandidObject: { message: { status: "failed" } } },
          }
        : undefined,
    authorize: async (request) => {
      assert.deepEqual(await request.poll(), { qrSvg: "<svg>next</svg>" });
      assert.deepEqual(await request.poll(), {});
      await assert.rejects(request.poll(), /BankID sign-in ended/);
      return "unused";
    },
  });
  await f.run();
  assert.ok(f.requests.every((u) => !u.pathname.endsWith("/redirect")));
});
test("QR images must be bounded base64-encoded SVG", async () => {
  for (const QRCode of [
    "not SVG",
    Buffer.from("<html>invalid</html>").toString("base64"),
    "A".repeat(256001),
  ])
    await assert.rejects(
      fixture({ response: () => ({ status: 200, data: { sessionId: "s", QRCode } }) }).run(),
      /invalid QR image/,
    );
});
test("QR completion rejects missing, malformed, foreign and unbound return codes", async () => {
  for (const target of [
    undefined,
    "not a URL",
    "https://elsewhere.example/?state=x&code=x",
    "com.schoolsoft.vapp://?code=x&state=wrong",
    "com.schoolsoft.vapp://?code=x#bad",
  ]) {
    const f = fixture({
      response: (path) =>
        path === "/redirect" ? { status: 200, data: { redirect_uri: target } } : undefined,
    });
    await assert.rejects(f.run());
  }
  const empty = fixture({
    response: (path, q) =>
      path === "/redirect"
        ? { status: 200, data: { redirect_uri: "com.schoolsoft.vapp://?state=" + q.get("state") } }
        : undefined,
  });
  await assert.rejects(empty.run());
});
