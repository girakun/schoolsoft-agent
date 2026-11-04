import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createConnectorApp } from "../../src/http/server.js";
import { ConnectorOAuthProvider, type OAuthState } from "../../src/http/oauth.js";
import type { ConnectorConfig } from "../../src/http/config.js";

const origin = "https://connector.example";
const resource = origin + "/mcp";
const callback = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const allowedScopes = ["list_children", "get_schedule", "get_calendar", "get_lunch_menu"];
async function fixture(t: TestContext, vendorCallback = callback, allowLoopbackClients = false) {
  let state: OAuthState | undefined;
  const oauth = new ConnectorOAuthProvider({
    resourceUrl: resource,
    allowLoopbackClients,
    scopes: allowedScopes,
    repository: {
      read: () => state,
      write: (value) => {
        state = value;
      },
    },
  });
  let authenticated = true;
  let executeHook: (() => void) | undefined;
  const executions: { name: string; args: Record<string, unknown>; children: readonly number[] }[] =
    [];
  const config: ConnectorConfig = {
    publicUrl: origin,
    adminPassword: "synthetic-admin-password-32-characters",
    storageKey: Buffer.alloc(32, 1),
    stateDir: "/unused",
    port: 3000,
    school: "synthetic",
    proxyHops: 1,
  };
  const app = createConnectorApp({
    config,
    oauth,
    runtime: {
      beginLogin: async () => ({ url: "https://school.example/login" }),
      callback: (callbackState, code) =>
        callbackState === "synthetic-state" && code === "synthetic-code",
      status: async () => ({
        authenticated,
        loginInProgress: false,
        portal: { state: "ok" as const, retryAt: null },
        children: authenticated
          ? [
              { id: 1, name: "Synthetic One" },
              { id: 2, name: "Synthetic Two" },
            ]
          : [],
      }),
      execute: async (name, args, children, authorization) => {
        authorization?.check?.();
        executions.push({ name, args, children });
        executeHook?.();
        return { synthetic: true, children };
      },
      executeForChild: () => Promise.reject(new Error("the overview is not under test here")),
      logout: async () => {
        authenticated = false;
      },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (
    path: string,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        local + path,
        { method: init.method ?? "GET", headers: { Host: "connector.example", ...init.headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(res.headers))
              if (value !== undefined)
                headers.set(key, Array.isArray(value) ? value.join(", ") : value);
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers }));
          });
        },
      );
      req.on("error", reject);
      req.end(init.body?.toString());
    });
  const form = (
    path: string,
    values: Record<string, string> | URLSearchParams,
    headers: Record<string, string> = {},
  ) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, ...headers },
      body: new URLSearchParams(values),
    });
  const login = await form("/owner/login", { password: config.adminPassword });
  assert.equal(login.status, 302);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const dashboard = await request("/owner", { headers: { Cookie: cookie } });
  const html = await dashboard.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  async function register(redirect = vendorCallback) {
    const response = await request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Synthetic Claude",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    return { response, client: (await response.json()) as { client_id: string } };
  }
  async function authorize(clientId: string, extra: Record<string, string> = {}) {
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: vendorCallback,
      resource,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "original-state",
      scope: allowedScopes.join(" "),
      ...extra,
    });
    return request("/authorize?" + query);
  }
  async function connection(scopes = allowedScopes) {
    const { response, client } = await register();
    assert.equal(response.status, 201);
    const auth = await authorize(client.client_id, { scope: scopes.join(" ") });
    assert.equal(auth.status, 302);
    const consentUrl = auth.headers.get("location")!;
    const page = await request(consentUrl, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    const consentHtml = await page.text();
    assert.match(consentHtml, /Synthetic One/);
    assert.match(consentHtml, /started connecting this app yourself.*choose Cancel/);
    const id = new URL(consentUrl, origin).searchParams.get("request")!;
    const approval = await form(
      "/owner/approve",
      new URLSearchParams([
        ["csrf", csrf],
        ["request", id],
        ["children", "1"],
        ...scopes.map((s) => ["scopes", s]),
      ]),
      { Cookie: cookie },
    );
    assert.equal(approval.status, 302);
    const redirect = new URL(approval.headers.get("location")!);
    assert.equal(redirect.origin, new URL(vendorCallback).origin);
    assert.equal(redirect.searchParams.get("state"), "original-state");
    const code = redirect.searchParams.get("code")!;
    return { client, code, id };
  }
  const exchange = (clientId: string, code: string, extra: Record<string, string> = {}) =>
    form("/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: vendorCallback,
      resource,
      ...extra,
    });
  const rpc = async (
    token: string,
    method: string,
    params?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await response.text();
    const data = text.startsWith("event:")
      ? JSON.parse(
          text
            .split("\n")
            .find((line) => line.startsWith("data:"))!
            .slice(5),
        )
      : JSON.parse(text);
    return { response, data };
  };
  return {
    oauth,
    request,
    form,
    cookie,
    csrf,
    register,
    authorize,
    connection,
    exchange,
    rpc,
    executions,
    setAuthenticated: (value: boolean) => {
      authenticated = value;
    },
    setHook: (hook: () => void) => {
      executeHook = hook;
    },
  };
}
test("desktop clients complete OAuth with PKCE and call MCP over HTTP", async (t) => {
  const localCallback = "http://127.0.0.1:43123/callback";
  const f = await fixture(t, localCallback, true);
  const { client, code } = await f.connection(["list_children", "get_calendar"]);
  const changed = await f.exchange(client.client_id, code, {
    redirect_uri: "http://127.0.0.1:43124/callback",
  });
  assert.equal(changed.status, 400, "the registered port remains bound to the code");
  const tokens = await (await f.exchange(client.client_id, code)).json();
  const listed = await f.rpc(tokens.access_token, "tools/list");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.data.result.tools.length, 2);
  const closed = await fixture(t, localCallback);
  assert.equal((await closed.register()).response.status, 400);
});
test("real HTTP OAuth discovery, DCR, consent, PKCE and scoped stateless MCP", async (t) => {
  const f = await fixture(t);
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    const response = await f.request(path);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body);
  }
  const missing = await f.request("/mcp");
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate")!, /resource_metadata=/);
  const invalid = await f.request("/mcp", { headers: { Authorization: "Bearer wrong" } });
  assert.equal(invalid.status, 401);
  const malicious = await f.register("https://evil.example/callback");
  assert.equal(malicious.response.status, 400);
  const { client, code } = await f.connection();
  const wrong = await f.exchange(client.client_id, code, { code_verifier: "wrong".repeat(16) });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, "invalid_grant");
  const noResource = await f.form("/token", {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    code_verifier: verifier,
    redirect_uri: callback,
  });
  assert.equal(noResource.status, 400);
  assert.equal((await noResource.json()).error, "invalid_target");
  const exchanged = await f.exchange(client.client_id, code);
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  const initialized = await f.rpc(tokens.access_token, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "synthetic", version: "1" },
  });
  assert.equal(initialized.response.status, 200);
  const listed = await f.rpc(tokens.access_token, "tools/list");
  assert.deepEqual(
    listed.data.result.tools.map((v: { name: string }) => v.name).sort(),
    allowedScopes.map((s) => "schoolsoft_" + s).sort(),
  );
  const read = await f.rpc(tokens.access_token, "tools/call", {
    name: "schoolsoft_list_children",
    arguments: {},
  });
  assert.equal(read.data.result.isError, undefined);
  assert.deepEqual(JSON.parse(read.data.result.content[0].text), {
    synthetic: true,
    children: [1],
  });
  assert.deepEqual(f.executions[0].children, [1]);
  const excluded = await f.rpc(tokens.access_token, "tools/call", {
    name: "schoolsoft_get_messages",
    arguments: {},
  });
  assert.ok(excluded.data.error || excluded.data.result?.isError);
  assert.equal(f.executions.length, 1);
  const forbidden = await f.request("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens.access_token}`, Origin: "https://evil.example" },
  });
  assert.equal(forbidden.status, 403);
  const get = await f.request("/mcp", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const refresh = await f.form("/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    resource,
    scope: "list_children",
  });
  assert.equal(refresh.status, 200);
  const rotated = await refresh.json();
  const narrowed = await f.rpc(rotated.access_token, "tools/list");
  assert.deepEqual(
    narrowed.data.result.tools.map((v: { name: string }) => v.name),
    ["schoolsoft_list_children"],
  );
  const replay = await f.form("/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    resource,
  });
  assert.equal(replay.status, 400);
  assert.equal(
    (await f.request("/mcp", { headers: { Authorization: `Bearer ${rotated.access_token}` } }))
      .status,
    401,
  );
});
test("HTTP consent needs owner cookie and CSRF, supports cancellation and independent revoke", async (t) => {
  const f = await fixture(t);
  const { client } = await f.register();
  const auth = await f.authorize(client.client_id);
  const location = auth.headers.get("location")!;
  const id = new URL(location, origin).searchParams.get("request")!;
  const noOwner = await f.request(location);
  assert.equal(noOwner.status, 302);
  assert.match(noOwner.headers.get("location")!, /owner\/login\?request=/);
  const noCsrf = await f.form(
    "/owner/approve",
    { request: id, children: "1", scopes: "list_children" },
    { Cookie: f.cookie },
  );
  assert.equal(noCsrf.status, 403);
  const foreignChild = await f.form(
    "/owner/approve",
    { csrf: f.csrf, request: id, children: "999", scopes: "list_children" },
    { Cookie: f.cookie },
  );
  assert.equal(foreignChild.status, 400);
  const cancelled = await f.form(
    "/owner/deny",
    { csrf: f.csrf, request: id },
    { Cookie: f.cookie },
  );
  assert.equal(cancelled.status, 302);
  assert.equal(
    new URL(cancelled.headers.get("location")!).searchParams.get("error"),
    "access_denied",
  );
  const pendingAuth = await f.authorize(client.client_id);
  f.setAuthenticated(false);
  const unavailable = await f.request(pendingAuth.headers.get("location")!, {
    headers: { Cookie: f.cookie },
  });
  assert.equal(unavailable.status, 409);
  assert.match(await unavailable.text(), /Sign in to SchoolSoft first/);
  f.setAuthenticated(true);
  const a = await f.connection();
  const b = await f.connection();
  const aTokens = await (await f.exchange(a.client.client_id, a.code)).json();
  const bTokens = await (await f.exchange(b.client.client_id, b.code)).json();
  const revoke = await f.form("/revoke", {
    client_id: a.client.client_id,
    token: aTokens.access_token,
  });
  assert.equal(revoke.status, 200);
  assert.equal(
    (await f.request("/mcp", { headers: { Authorization: `Bearer ${aTokens.access_token}` } }))
      .status,
    401,
  );
  assert.equal((await f.rpc(bTokens.access_token, "tools/list")).response.status, 200);
  const dashboard = await f.request("/owner", { headers: { Cookie: f.cookie } });
  assert.match(await dashboard.text(), /Synthetic Claude/);
  f.setAuthenticated(false);
  const disconnectedDashboard = await f.request("/owner", { headers: { Cookie: f.cookie } });
  assert.equal(disconnectedDashboard.status, 200);
  f.setAuthenticated(true);
  const extra = await f.connection();
  const extraTokens = await (await f.exchange(extra.client.client_id, extra.code)).json();
  const extraGrant = f.oauth.listGrants().find((g) => g.clientId === extra.client.client_id)!;
  const ownerRevoked = await f.form(
    "/owner/revoke",
    { csrf: f.csrf, grant: extraGrant.id },
    { Cookie: f.cookie },
  );
  assert.equal(ownerRevoked.status, 302);
  assert.equal(
    (await f.request("/mcp", { headers: { Authorization: `Bearer ${extraTokens.access_token}` } }))
      .status,
    401,
  );
  const grant = f.oauth.listGrants()[0];
  f.setHook(() => f.oauth.revokeGrant(grant.id));
  const withheld = await f.rpc(bTokens.access_token, "tools/call", {
    name: "schoolsoft_list_children",
    arguments: {},
  });
  assert.equal(withheld.data.result.isError, true);
  assert.doesNotMatch(JSON.stringify(withheld.data), /"synthetic":true/);
});

test("ChatGPT stable and per-connector callbacks complete the same OAuth exchange", async (t) => {
  for (const url of [
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/oauth/synthetic_callback-123",
  ]) {
    const f = await fixture(t, url);
    const { client, code } = await f.connection();
    const response = await f.exchange(client.client_id, code);
    assert.equal(response.status, 200);
    const tokens = await response.json();
    assert.equal((await f.rpc(tokens.access_token, "tools/list")).response.status, 200);
  }
});

test("disconnect everything revokes both apps' access and refresh tokens", async (t) => {
  const f = await fixture(t);
  const a = await f.connection();
  const b = await f.connection();
  const at = await (await f.exchange(a.client.client_id, a.code)).json();
  const bt = await (await f.exchange(b.client.client_id, b.code)).json();
  const logout = await f.form("/owner/schoolsoft/logout", { csrf: f.csrf }, { Cookie: f.cookie });
  assert.equal(logout.status, 302);
  for (const [client, tokens] of [
    [a.client, at],
    [b.client, bt],
  ]) {
    assert.equal(
      (await f.request("/mcp", { headers: { Authorization: `Bearer ${tokens.access_token}` } }))
        .status,
      401,
    );
    assert.equal(
      (
        await f.form("/token", {
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
          resource,
        })
      ).status,
      400,
    );
  }
  assert.equal((await f.request("/owner", { headers: { Cookie: f.cookie } })).status, 302);
});

test("calendar is separately consented; old grants and refresh tokens cannot gain it", async (t) => {
  const f = await fixture(t);
  const old = await f.connection(["list_children", "get_schedule"]);
  const oldTokens = await (await f.exchange(old.client.client_id, old.code)).json();
  const denied = await f.rpc(oldTokens.access_token, "tools/call", {
    name: "schoolsoft_get_calendar",
    arguments: {},
  });
  assert.ok(denied.data.error || denied.data.result?.isError);
  assert.equal(f.executions.length, 0);
  const upgrade = await f.form("/token", {
    grant_type: "refresh_token",
    client_id: old.client.client_id,
    refresh_token: oldTokens.refresh_token,
    resource,
    scope: "list_children get_schedule get_calendar",
  });
  assert.equal(upgrade.status, 400);
  const fresh = await f.connection(["get_calendar"]);
  const tokens = await (await f.exchange(fresh.client.client_id, fresh.code)).json();
  const listed = await f.rpc(tokens.access_token, "tools/list");
  assert.deepEqual(
    listed.data.result.tools.map((tool: { name: string }) => tool.name),
    ["schoolsoft_get_calendar"],
  );
  const args = { start_date: "2026-09-01", end_date: "2026-09-30", child_id: 1 };
  const read = await f.rpc(tokens.access_token, "tools/call", {
    name: "schoolsoft_get_calendar",
    arguments: args,
  });
  assert.equal(read.data.result.isError, undefined);
  assert.deepEqual(f.executions, [{ name: "get_calendar", args, children: [1] }]);
  f.setHook(() => {
    f.oauth.revokeAll();
  });
  const revoked = await f.rpc(tokens.access_token, "tools/call", {
    name: "schoolsoft_get_calendar",
    arguments: args,
  });
  assert.ok(revoked.data.error || revoked.data.result?.isError);
});

test("replaying an authorization code over HTTP withdraws the access and refresh tokens it produced", async (t) => {
  const f = await fixture(t);
  const { client, code } = await f.connection();
  const bystander = await f.connection();
  const tokens = await (await f.exchange(client.client_id, code)).json();
  const others = await (await f.exchange(bystander.client.client_id, bystander.code)).json();
  assert.equal((await f.rpc(tokens.access_token, "tools/list")).response.status, 200);
  // Even without the PKCE verifier, the second presentation is what counts.
  const replay = await f.exchange(client.client_id, code, { code_verifier: "stolen".repeat(12) });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");
  assert.equal(
    (await f.request("/mcp", { headers: { Authorization: `Bearer ${tokens.access_token}` } }))
      .status,
    401,
  );
  const refresh = await f.form("/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    resource,
  });
  assert.equal(refresh.status, 400);
  assert.equal((await f.rpc(others.access_token, "tools/list")).response.status, 200);
});
