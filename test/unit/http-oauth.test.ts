import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Response } from "express";
import { ConnectorOAuthProvider, approvedRedirect, type OAuthState } from "../../src/http/oauth.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
const resource = new URL("https://parent.example/mcp");
const callback = "https://claude.ai/api/mcp/auth_callback";
const scopes = ["list_children", "get_schedule", "get_lunch_menu"];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
let fixtureId = 0;
type Limits = { clients?: number; pending?: number; pendingPerRequester?: number };
function setup(initial?: OAuthState, defaults = false, limits?: Limits) {
  const fixture = ++fixtureId;
  let clock = 1_000_000;
  let sequence = 0;
  let saved: OAuthState | undefined = initial;
  const repository = {
    read: () => saved,
    write: (value: OAuthState) => {
      saved = value;
    },
  };
  const provider = new ConnectorOAuthProvider({
    resourceUrl: resource.href,
    scopes,
    repository,
    limits,
    ...(defaults ? {} : { now: () => clock, randomToken: () => `opaque-${fixture}-${++sequence}` }),
  });
  return {
    provider,
    repository,
    state: () => structuredClone(saved!),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
async function client(p: ConnectorOAuthProvider, name: string | undefined = "Claude") {
  return await p.clientsStore.registerClient!({
    redirect_uris: [callback],
    client_name: name,
    token_endpoint_auth_method: "none",
  });
}
async function consent(
  p: ConnectorOAuthProvider,
  c: OAuthClientInformationFull,
  custom: Record<string, unknown> = {},
  ip?: string,
) {
  let location = "";
  await p.authorize(
    c,
    {
      redirectUri: callback,
      resource,
      codeChallenge: "a".repeat(43),
      state: "original-state",
      ...custom,
    },
    {
      redirect: (value: string) => {
        location = value;
      },
      ...(ip ? { req: { ip } } : {}),
    } as Response,
  );
  return new URL(location, resource).searchParams.get("request")!;
}
async function connected(s = setup()) {
  const c = await client(s.provider);
  const id = await consent(s.provider, c);
  const redirect = new URL(s.provider.approve(id, undefined, [1, 2, 1]));
  const code = redirect.searchParams.get("code")!;
  const tokens = await s.provider.exchangeAuthorizationCode(c, code, undefined, callback, resource);
  return { ...s, c, tokens, code };
}
test("callback allowlist rejects hostile origins, path variants and URL components", () => {
  for (const value of [
    callback,
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/oauth/abc_123-DEF",
  ])
    assert.equal(approvedRedirect(value), true);
  for (const value of [
    "invalid",
    "http://claude.ai/api/mcp/auth_callback",
    "https://x@claude.ai/api/mcp/auth_callback",
    "https://x:y@claude.ai/api/mcp/auth_callback",
    `${callback}:123`,
    "https://claude.ai:123/api/mcp/auth_callback",
    `${callback}?evil=1`,
    `${callback}#evil`,
    "https://claude.ai.evil/api/mcp/auth_callback",
    "https://chatgpt.com/connector/oauth/",
    "https://chatgpt.com/connector/oauth/a/b",
    "https://evil.example/callback",
    "https://claude.ai/other",
  ])
    assert.equal(approvedRedirect(value), false, value);
});
test("desktop callbacks accept only explicit loopback listeners when enabled", () => {
  for (const value of [
    "http://127.0.0.1:43123/callback",
    "http://localhost:43123/oauth/callback",
    "http://[::1]:43123/callback",
  ]) {
    assert.equal(approvedRedirect(value), false);
    assert.equal(approvedRedirect(value, true), true);
  }
  for (const value of [
    "http://127.0.0.1/callback",
    "http://192.168.1.2:43123/callback",
    "http://127.0.0.1.evil.example:43123/callback",
    "http://localhost.evil.example:43123/callback",
    "https://localhost:43123/callback",
    "http://user@127.0.0.1:43123/callback",
    "http://:password@127.0.0.1:43123/callback",
    "http://127.0.0.1:43123/callback?next=evil",
    "http://127.0.0.1:43123/callback#evil",
    "file:///callback",
  ])
    assert.equal(approvedRedirect(value, true), false, value);
});
test("the connector's own callbacks are accepted exactly, next to the vendor allowlist", async () => {
  const own = "https://parent.example/reference/";
  const provider = new ConnectorOAuthProvider({
    resourceUrl: resource.href,
    scopes,
    repository: { read: () => undefined, write: () => {} },
    ownCallbacks: [own],
  });
  const page = await provider.clientsStore.registerClient!({
    redirect_uris: [own],
    client_name: "Reference page",
    token_endpoint_auth_method: "none",
  });
  const id = await consent(provider, page, { redirectUri: own });
  assert.equal(provider.pending(id).redirectUri, own);
  const redirect = new URL(provider.approve(id, undefined, [1]));
  assert.equal(redirect.origin + redirect.pathname, own);
  assert.ok(redirect.searchParams.get("code"));
  // The vendors stay accepted; nothing else on the connector's origin is.
  await provider.clientsStore.registerClient!({ redirect_uris: [callback] });
  for (const value of [
    "https://parent.example/reference",
    "https://parent.example/reference/x",
    "https://parent.example/reference/?a=1",
    "https://parent.example/reference/#a",
    "https://parent.example:8443/reference/",
    "http://parent.example/reference/",
    "https://parent.example/owner",
  ])
    assert.throws(() => provider.clientsStore.registerClient!({ redirect_uris: [value] }), value);
  // Without the option (every existing deployment path but the composition root) it is refused.
  assert.throws(() => setup().provider.clientsStore.registerClient!({ redirect_uris: [own] }));
  // A client registered for the callback cannot authorize elsewhere.
  await assert.rejects(consent(provider, page, { redirectUri: callback }));
});
test("client registration is bounded, copies data and never fetches callback URLs", async () => {
  const s = setup();
  const c = await client(s.provider);
  assert.deepEqual(await s.provider.clientsStore.getClient(c.client_id), c);
  assert.equal(await s.provider.clientsStore.getClient("toString"), undefined);
  c.redirect_uris.push("https://evil.example");
  assert.equal((await s.provider.clientsStore.getClient(c.client_id))!.redirect_uris.length, 1);
  for (const redirect_uris of [[], ["https://evil.example"]])
    assert.throws(() => s.provider.clientsStore.registerClient!({ redirect_uris }));
});
test("a full client table evicts the oldest idle registration, never one holding a grant or consent", async () => {
  const s = await connected(setup(undefined, false, { clients: 4 }));
  const idleOld = await client(s.provider, "Idle old");
  s.advance(1000);
  const waiting = await client(s.provider, "Waiting for consent");
  const waitingId = await consent(s.provider, waiting);
  s.advance(1000);
  const idleNew = await client(s.provider, "Idle new");
  s.advance(1000);
  const added = await client(s.provider, "Newcomer");
  const has = async (c: OAuthClientInformationFull) =>
    (await s.provider.clientsStore.getClient(c.client_id)) !== undefined;
  assert.deepEqual(
    [await has(s.c), await has(idleOld), await has(waiting), await has(idleNew), await has(added)],
    [true, false, true, true, true],
  );
  await s.provider.verifyAccessToken(s.tokens.access_token);
  s.provider.pending(waitingId);
  // Registrations without an issue time count as oldest.
  const state = s.state();
  delete state.clients[added.client_id].client_id_issued_at;
  const reloaded = setup(state, false, { clients: 4 });
  await client(reloaded.provider, "Another");
  assert.equal(await reloaded.provider.clientsStore.getClient(added.client_id), undefined);
  assert.ok(await reloaded.provider.clientsStore.getClient(idleNew.client_id));
  // Only when every slot is in use is a registration turned away.
  const busy = await connected(setup(undefined, false, { clients: 2 }));
  await consent(busy.provider, await client(busy.provider));
  await assert.rejects(client(busy.provider), /limit reached/);
  assert.ok(await busy.provider.clientsStore.getClient(busy.c.client_id));
});
test("authorization binds scope, callback, resource and PKCE before creating consent", async () => {
  const s = setup();
  const c = await client(s.provider);
  delete c.client_name;
  for (const custom of [
    { resource: undefined },
    { resource: new URL("https://evil.example") },
    { redirectUri: "https://evil.example" },
    { codeChallenge: "bad" },
    { scopes: [] },
    { scopes: ["write"] },
  ])
    await assert.rejects(consent(s.provider, c, custom));
  await assert.rejects(
    consent(
      s.provider,
      { ...c, redirect_uris: ["https://evil.example"] },
      { redirectUri: "https://evil.example" },
    ),
  );
  const id = await consent(s.provider, c, {
    scopes: ["get_schedule", "get_schedule"],
    state: undefined,
  });
  const pending = s.provider.pending(id);
  assert.equal(pending.clientName, "AI connector");
  assert.deepEqual(pending.scopes, ["get_schedule"]);
  pending.scopes.push("write");
  assert.deepEqual(s.provider.pending(id).scopes, ["get_schedule"]);
  assert.throws(() => s.provider.pending("toString"));
  assert.throws(() => s.provider.approve(id));
  assert.throws(() => s.provider.approve(id, undefined, [0]));
  assert.throws(() => s.provider.approve(id, undefined, [1.5]));
  assert.throws(() => s.provider.approve(id, ["get_lunch_menu"], [1]));
  const denied = new URL(s.provider.deny(id));
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.has("state"), false);
  assert.throws(() => s.provider.deny(id));
  const expired = await consent(s.provider, c);
  s.advance(600_000);
  assert.throws(() => s.provider.pending(expired));
});
test("pending consent makes room by displacing the largest requester, so a flood cannot block a parent", async () => {
  const s = setup(undefined, false, { pending: 4, pendingPerRequester: 3 });
  const c = await client(s.provider);
  const alive = (id: string) => {
    try {
      s.provider.pending(id);
      return true;
    } catch {
      return false;
    }
  };
  const parent = await consent(s.provider, c, {}, "203.0.113.5");
  // One network, rotating inside its IPv6 /64, is one requester with a small share.
  const flood: string[] = [];
  for (let i = 1; i <= 3; i++) flood.push(await consent(s.provider, c, {}, `2001:db8:9:9::${i}`));
  assert.deepEqual([alive(parent), ...flood.map(alive)], [true, true, true, true]);
  flood.push(await consent(s.provider, c, {}, "2001:db8:9:9::4"));
  assert.deepEqual([alive(parent), ...flood.map(alive)], [true, false, true, true, true]);
  // A newcomer at a full table displaces the largest holder's oldest request, not the parent's.
  const newcomer = await consent(s.provider, c, {}, "198.51.100.1");
  assert.deepEqual(
    [alive(parent), alive(newcomer), ...flood.map(alive)],
    [true, true, false, false, true, true],
  );
  // Rejected requests displace nothing.
  await assert.rejects(consent(s.provider, c, { scopes: ["write"] }, "198.51.100.2"));
  assert.ok(alive(parent) && alive(newcomer));
  assert.equal(Object.keys(s.state().pending).length, 4);
});
test("pending consent keeps a per-process pseudonym of the caller's network, never the address", async () => {
  const s = setup();
  const c = await client(s.provider);
  const first = await consent(s.provider, c, {}, "203.0.113.5");
  const sameNetwork = await consent(s.provider, c, {}, "2001:db8:9:9::1");
  const sameNetworkAgain = await consent(s.provider, c, {}, "2001:db8:9:9::2");
  const noAddress = await consent(s.provider, c);
  const stored = s.state();
  const text = JSON.stringify(stored);
  for (const address of ["203.0.113.5", "2001:db8:9:9", "unknown"])
    assert.equal(text.includes(address), false, address);
  const requester = (id: string) => stored.pending[id].requester;
  assert.match(requester(first), /^h:[A-Za-z0-9_-]{43}$/);
  assert.equal(requester(sameNetwork), requester(sameNetworkAgain));
  assert.notEqual(requester(first), requester(sameNetwork));
  assert.notEqual(requester(noAddress), requester(first));
  // Another process has another key: the same address cannot be linked across restarts.
  const other = setup();
  const again = await consent(other.provider, await client(other.provider), {}, "203.0.113.5");
  assert.notEqual(other.state().pending[again].requester, requester(first));
  // The pseudonym goes with its request when it is answered.
  s.provider.deny(first);
  s.provider.approve(sameNetwork, undefined, [1]);
  assert.deepEqual(Object.keys(s.state().pending).sort(), [noAddress, sameNetworkAgain].sort());
});

test("pending requests an older build stored with a plain address get a pseudonym on start", async () => {
  const s = setup();
  const c = await client(s.provider);
  const kept = await consent(s.provider, c, {}, "198.51.100.7");
  const legacy = s.state();
  const restored = legacy.pending[kept].requester;
  for (const [id, address] of [
    ["old-v4", "203.0.113.5"],
    ["old-v6", "2001:db8:9:9::/64"],
    ["old-none", "unknown"],
  ])
    legacy.pending[id] = { ...legacy.pending[kept], id, requester: address };
  let writes = 0;
  const saved: OAuthState[] = [];
  const provider = new ConnectorOAuthProvider({
    resourceUrl: resource.href,
    scopes,
    repository: {
      read: () => structuredClone(legacy),
      write: (value) => {
        writes++;
        saved.push(value);
      },
    },
    now: () => 1_000_000,
  });
  assert.equal(writes, 1, "rewritten at once, before any request");
  const text = JSON.stringify(saved[0]);
  for (const address of ["203.0.113.5", "2001:db8:9:9", "unknown"])
    assert.equal(text.includes(address), false, address);
  assert.equal(saved[0].pending[kept].requester, restored, "a pseudonym is left as it is");
  assert.match(saved[0].pending["old-v4"].requester, /^h:/);
  // The restored request still counts for its network: a new request from it shares the group.
  const fresh = await consent(provider, c, {}, "203.0.113.5");
  assert.equal(saved.at(-1)!.pending[fresh].requester, saved[0].pending["old-v4"].requester);
  // A state without plain addresses is not rewritten on start.
  let quiet = 0;
  const reloaded = new ConnectorOAuthProvider({
    resourceUrl: resource.href,
    scopes,
    repository: { read: () => structuredClone(saved.at(-1)), write: () => void quiet++ },
  });
  assert.equal(quiet, 0);
  assert.equal(reloaded.listGrants().length, 0);
});

test("codes are one-use, short-lived, PKCE/client/callback/resource bound and stored hashed", async () => {
  const s = setup();
  const c = await client(s.provider);
  const other = await client(s.provider);
  const id = await consent(s.provider, c);
  const url = new URL(s.provider.approve(id, ["get_schedule"], [1]));
  const code = url.searchParams.get("code")!;
  assert.equal(url.searchParams.get("state"), "original-state");
  assert.equal(await s.provider.challengeForAuthorizationCode(c, code), "a".repeat(43));
  await assert.rejects(s.provider.challengeForAuthorizationCode(other, code));
  await assert.rejects(s.provider.challengeForAuthorizationCode(c, "unknown"));
  await assert.rejects(
    s.provider.exchangeAuthorizationCode(c, code, undefined, "https://evil.example", resource),
  );
  await assert.rejects(s.provider.exchangeAuthorizationCode(c, code, undefined, callback));
  const tokens = await s.provider.exchangeAuthorizationCode(c, code, undefined, callback, resource);
  assert.equal(tokens.scope, "get_schedule");
  assert.equal(JSON.stringify(s.state()).includes(tokens.access_token), false);
  assert.equal(JSON.stringify(s.state()).includes(tokens.refresh_token!), false);
  const info = await s.provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.clientId, c.client_id);
  assert.equal(info.resource!.href, resource.href);
  info.scopes.push("write");
  assert.deepEqual((await s.provider.verifyAccessToken(tokens.access_token)).scopes, [
    "get_schedule",
  ]);
  const nextId = await consent(s.provider, c);
  const nextCode = new URL(s.provider.approve(nextId, undefined, [1])).searchParams.get("code")!;
  s.advance(60_000);
  await assert.rejects(s.provider.challengeForAuthorizationCode(c, nextCode));
  s.advance(240_000);
  await assert.rejects(s.provider.verifyAccessToken(tokens.access_token));
});
test("a second use of an authorization code withdraws the tokens issued from it", async () => {
  const s = await connected();
  const other = await client(s.provider);
  const bystander = await connected(s);
  // Another client presenting the code learns nothing and harms nothing.
  await assert.rejects(s.provider.challengeForAuthorizationCode(other, s.code));
  await s.provider.verifyAccessToken(s.tokens.access_token);
  // The SDK asks for the challenge before it checks PKCE, so a thief without the verifier
  // is recognised at this first step.
  await assert.rejects(s.provider.challengeForAuthorizationCode(s.c, s.code), /reused/);
  await assert.rejects(s.provider.verifyAccessToken(s.tokens.access_token));
  await assert.rejects(
    s.provider.exchangeRefreshToken(s.c, s.tokens.refresh_token!, undefined, resource),
  );
  await assert.rejects(
    s.provider.exchangeAuthorizationCode(s.c, s.code, undefined, callback, resource),
  );
  assert.deepEqual(
    s.provider.listGrants().map((grant) => grant.clientId),
    [bystander.c.client_id],
  );
  await s.provider.verifyAccessToken(bystander.tokens.access_token);
  // The marker lives only as long as the code would have: afterwards it is just unknown.
  const late = await connected();
  late.advance(60_000);
  await assert.rejects(late.provider.challengeForAuthorizationCode(late.c, late.code), /Invalid/);
  await late.provider.verifyAccessToken(late.tokens.access_token);
});
test("refresh rotates tokens, narrows scope, rejects cross-client replay and revokes the family", async () => {
  const s = await connected();
  const p = s.provider;
  const other = await client(p);
  await assert.rejects(p.exchangeRefreshToken(other, s.tokens.refresh_token!, undefined, resource));
  await assert.rejects(p.exchangeRefreshToken(s.c, s.tokens.access_token, undefined, resource));
  await assert.rejects(p.exchangeRefreshToken(s.c, "unknown", undefined, resource));
  await assert.rejects(p.exchangeRefreshToken(s.c, s.tokens.refresh_token!));
  await assert.rejects(p.exchangeRefreshToken(s.c, s.tokens.refresh_token!, ["write"], resource));
  await assert.rejects(p.verifyAccessToken(s.tokens.refresh_token!));
  await assert.rejects(p.verifyAccessToken("unknown"));
  const rotated = await p.exchangeRefreshToken(
    s.c,
    s.tokens.refresh_token!,
    ["get_schedule"],
    resource,
  );
  assert.notEqual(rotated.refresh_token, s.tokens.refresh_token);
  await assert.rejects(
    p.exchangeRefreshToken(s.c, rotated.refresh_token!, ["get_lunch_menu"], resource),
  );
  const twice = await p.exchangeRefreshToken(s.c, rotated.refresh_token!, undefined, resource);
  assert.equal(twice.scope, "get_schedule");
  await assert.rejects(p.exchangeRefreshToken(s.c, s.tokens.refresh_token!, undefined, resource));
  await assert.rejects(p.verifyAccessToken(twice.access_token));
  await assert.rejects(p.exchangeRefreshToken(s.c, twice.refresh_token!, undefined, resource));
  assert.deepEqual(p.listGrants(), []);
});
test("revocation is client-specific, durable across restart and clears pending approvals on revoke all", async () => {
  const s = await connected();
  const second = await connected(setup(s.state()));
  const p = second.provider;
  const grants = p.listGrants();
  assert.equal(grants.length, 2);
  assert.deepEqual(grants[0].childIds, [1, 2]);
  grants[0].childIds.push(3);
  assert.deepEqual(p.verifyGrant(grants[0].id).childIds, [1, 2]);
  await p.revokeToken(second.c, { token: s.tokens.access_token });
  await p.verifyAccessToken(s.tokens.access_token);
  await p.revokeToken(second.c, { token: "missing" });
  p.revokeGrant("missing");
  await p.revokeToken(s.c, { token: s.tokens.access_token });
  await assert.rejects(p.verifyAccessToken(s.tokens.access_token));
  await p.verifyAccessToken(second.tokens.access_token);
  assert.throws(() => p.verifyGrant("toString"));
  await consent(p, second.c);
  p.revokeAll();
  assert.deepEqual(second.state().pending, {});
  assert.deepEqual(second.state().codes, {});
  const restored = setup(second.state()).provider;
  await assert.rejects(restored.verifyAccessToken(second.tokens.access_token));
  assert.deepEqual(restored.listGrants(), []);
});
test("expiry and capacity prune bounded state without allowing expired grants", async () => {
  const s = await connected();
  const grant = s.provider.listGrants()[0];
  const id = await consent(s.provider, s.c);
  s.provider.approve(id, undefined, [1]);
  await consent(s.provider, s.c);
  s.advance(30 * 86_400_000);
  assert.throws(() => s.provider.verifyGrant(grant.id));
  await assert.rejects(
    s.provider.exchangeRefreshToken(s.c, s.tokens.refresh_token!, undefined, resource),
  );
  await client(s.provider);
  assert.deepEqual(s.state().tokens, {});
  assert.deepEqual(s.state().codes, {});
  assert.deepEqual(s.state().grants, {});
  const fresh = await connected();
  const state = fresh.state();
  const g = Object.values(state.grants)[0];
  for (let i = 0; i < 64; i++) state.grants[`grant-${i}`] = g;
  const full = setup(state);
  const pending = await consent(full.provider, fresh.c);
  assert.throws(() => full.provider.approve(pending, undefined, [1]));
  const tokens = fresh.state();
  const token = tokens.tokens[digest(fresh.tokens.access_token)];
  for (let i = 0; i < 8192; i++) tokens.tokens[`token-${i}`] = token;
  const capped = setup(tokens);
  await assert.rejects(
    capped.provider.exchangeRefreshToken(fresh.c, fresh.tokens.refresh_token!, undefined, resource),
  );
  const grantId = fresh.provider.listGrants()[0].id;
  assert.equal(capped.state().refresh[grantId].counter, 1);
  capped.advance(5 * 60_000);
  const retried = await capped.provider.exchangeRefreshToken(
    fresh.c,
    fresh.tokens.refresh_token!,
    undefined,
    resource,
  );
  await capped.provider.verifyAccessToken(retried.access_token);
  assert.equal(capped.state().refresh[grantId].counter, 2);
});
test("production defaults generate unpredictable tokens and retain no cleartext tokens", async () => {
  const s = await connected(setup(undefined, true));
  assert.equal(s.tokens.access_token.length, 43);
  assert.notEqual(s.tokens.access_token, s.tokens.refresh_token);
});

test("persisted grants cannot be retargeted to another resource", async () => {
  const s = await connected();
  const other = new ConnectorOAuthProvider({
    resourceUrl: "https://other.example/mcp",
    scopes,
    repository: s.repository,
    now: () => 1_000_000,
  });
  await assert.rejects(other.verifyAccessToken(s.tokens.access_token));
});

test("registration garbage collects old orphan clients while retaining live grants and pending consent", async () => {
  const s = await connected();
  const orphan = await client(s.provider);
  const pendingClient = await client(s.provider);
  const revokedClient = await client(s.provider);
  const revokeId = await consent(s.provider, revokedClient);
  s.provider.approve(revokeId, undefined, [1]);
  const revokedGrant = s.provider.listGrants().find((g) => g.clientId === revokedClient.client_id)!;
  s.provider.revokeGrant(revokedGrant.id);
  s.advance(86_400_000);
  await consent(s.provider, pendingClient);
  const persisted = s.state();
  delete persisted.clients[orphan.client_id].client_id_issued_at;
  const reloaded = setup(persisted);
  reloaded.advance(86_400_000);
  await client(reloaded.provider);
  assert.equal(await reloaded.provider.clientsStore.getClient(orphan.client_id), undefined);
  assert.equal(await reloaded.provider.clientsStore.getClient(revokedClient.client_id), undefined);
  assert.ok(await reloaded.provider.clientsStore.getClient(s.c.client_id));
  assert.ok(await reloaded.provider.clientsStore.getClient(pendingClient.client_id));
  await reloaded.provider.verifyAccessToken(
    (
      await reloaded.provider.exchangeRefreshToken(
        s.c,
        s.tokens.refresh_token!,
        undefined,
        resource,
      )
    ).access_token,
  );
});

test("two continuously used apps rotate for their entire lifetime with bounded state and old-token replay detection", async () => {
  const s = await connected();
  const second = await connected(s);
  let firstRefresh = s.tokens.refresh_token!;
  let secondRefresh = second.tokens.refresh_token!;
  for (let i = 0; i < 10799; i++) {
    s.advance(4 * 60_000);
    const one = await s.provider.exchangeRefreshToken(s.c, firstRefresh, undefined, resource);
    const two = await s.provider.exchangeRefreshToken(second.c, secondRefresh, undefined, resource);
    firstRefresh = one.refresh_token!;
    secondRefresh = two.refresh_token!;
  }
  assert.equal(Object.keys(s.state().refresh).length, 2);
  assert.ok(Object.keys(s.state().tokens).length <= 4);
  await assert.rejects(
    s.provider.exchangeRefreshToken(s.c, s.tokens.refresh_token!, undefined, resource),
  );
  await assert.rejects(s.provider.exchangeRefreshToken(s.c, firstRefresh, undefined, resource));
  await s.provider.exchangeRefreshToken(second.c, secondRefresh, undefined, resource);
});

test("failed persistence does not consume an authorization code or refresh token", async () => {
  const s = setup();
  const c = await client(s.provider);
  const id = await consent(s.provider, c);
  const code = new URL(s.provider.approve(id, undefined, [1])).searchParams.get("code")!;
  const write = s.repository.write;
  s.repository.write = () => {
    throw new Error("synthetic disk full");
  };
  await assert.rejects(
    s.provider.exchangeAuthorizationCode(c, code, undefined, callback, resource),
  );
  s.repository.write = write;
  const initial = await s.provider.exchangeAuthorizationCode(
    c,
    code,
    undefined,
    callback,
    resource,
  );
  s.repository.write = () => {
    throw new Error("synthetic disk full");
  };
  await assert.rejects(
    s.provider.exchangeRefreshToken(c, initial.refresh_token!, undefined, resource),
  );
  s.repository.write = write;
  await s.provider.exchangeRefreshToken(c, initial.refresh_token!, undefined, resource);
});

test("forged refresh tokens cannot revoke a grant and authenticated revocation frees capacity", async () => {
  const s = await connected();
  const refresh = s.tokens.refresh_token!;
  const [id, counter, signature] = refresh.split(".");
  for (const bad of [
    `${id}.01.${signature}`,
    `${id}.9007199254740992.${signature}`,
    `missing.${counter}.${signature}`,
    `${id}.${counter}.x`,
    `${id}.${counter}.${"a".repeat(43)}`,
  ])
    await assert.rejects(s.provider.exchangeRefreshToken(s.c, bad, undefined, resource));
  await s.provider.verifyAccessToken(s.tokens.access_token);
  const other = await client(s.provider);
  await s.provider.revokeToken(other, { token: refresh });
  await s.provider.verifyAccessToken(s.tokens.access_token);
  await s.provider.revokeToken(s.c, { token: refresh });
  assert.deepEqual(s.provider.listGrants(), []);
  assert.deepEqual(s.state().refresh, {});
  const fresh = await connected();
  const state = fresh.state();
  const grant = Object.values(state.grants)[0];
  for (let i = 0; i < 63; i++) state.grants[`grant-${i}`] = { ...grant, id: `grant-${i}` };
  const full = setup(state);
  const consentId = await consent(full.provider, fresh.c);
  assert.throws(() => full.provider.approve(consentId, undefined, [1]));
  full.provider.revokeGrant(grant.id);
  full.provider.approve(consentId, undefined, [1]);
  assert.equal(full.provider.listGrants().length, 64);
  const pending = await consent(full.provider, fresh.c); // Revocation also invalidates codes that have not been exchanged.
  full.provider.revokeGrant("grant-0");
  const code = new URL(full.provider.approve(pending, undefined, [1])).searchParams.get("code")!;
  full.provider.revokeGrant(full.state().codes[digest(code)].grantId);
  await assert.rejects(full.provider.challengeForAuthorizationCode(fresh.c, code));
});
