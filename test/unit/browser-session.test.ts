/**
 * PlaywrightSession against a fake playwright: engine selection, cookie
 * injection, the non-GET guard, redirect detection, missing dependency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaywrightSession, type PlaywrightLike } from "../../src/core/browser/playwright.js";
import { CountingBudget, FakeClock, fakeBudget } from "../helpers/budget.js";
import { PortalPushbackError } from "../../src/core/index.js";
import {
  BrowserRequiredError,
  PortalGatedError,
  SessionLostError,
} from "../../src/core/portal/types.js";
import { browserStatus, installChromium } from "../../src/core/browser/install.js";

interface FakeState {
  launched: { headless: boolean }[];
  connected: string[];
  cookies: { name: string; value: string; domain: string }[];
  routeDecisions: string[];
  closedContexts: number;
  closedBrowsers: number;
  landing: string;
  /** What a navigation answers (Playwright's Response); null for none. */
  response?: { status: () => number; headers: () => Record<string, string> } | null;
}

function fakePlaywright(state: FakeState): PlaywrightLike {
  let handler: ((route: unknown) => unknown) | null = null;
  const page = {
    addInitScript: async () => {},
    route: async (_glob: string, h: (route: unknown) => unknown) => {
      handler = h;
    },
    goto: async (url: string) => {
      state.landing = state.landing || url;
      return state.response ?? null;
    },
    url: () => state.landing,
    evaluate: async (fn: () => unknown) => fn(),
    waitForResponse: async (pred: (r: { url: () => string }) => boolean) => {
      pred({ url: () => "https://sms.schoolsoft.se/x" });
      return { json: async () => ({ ok: true }) };
    },
    // test hook: simulate a request through the route handler
    simulateRequest: (method: string, url: string) => {
      const decisions = state.routeDecisions;
      handler!({
        request: () => ({ method: () => method, url: () => url }),
        continue: () => decisions.push(`continue ${method} ${url}`),
        abort: (reason: string) => decisions.push(`abort(${reason}) ${method} ${url}`),
      });
    },
  };
  const context = {
    addCookies: async (c: FakeState["cookies"]) => {
      state.cookies.push(...c);
    },
    newPage: async () => page,
    close: async () => {
      state.closedContexts++;
    },
  };
  const browser = {
    newContext: async () => context,
    close: async () => {
      state.closedBrowsers++;
    },
  };
  return {
    chromium: {
      launch: async (o: { headless: boolean }) => {
        state.launched.push(o);
        return browser as never;
      },
      executablePath: () => "/fake/chromium",
      connectOverCDP: async (endpoint: string) => {
        state.connected.push(endpoint);
        return browser as never;
      },
    },
  };
}

function fresh(): FakeState {
  return {
    launched: [],
    connected: [],
    cookies: [],
    routeDecisions: [],
    closedContexts: 0,
    closedBrowsers: 0,
    landing: "",
  };
}

test("chromium engine launches headless once, injects cookies, closes contexts", async () => {
  const state = fresh();
  const s = new PlaywrightSession({
    budget: new CountingBudget(),
    school: "taby",
    cookieHeader: () => "JSESSIONID=a; hash=b; usertype=2",
    loader: async () => fakePlaywright(state),
  });
  const r1 = await s.withPage(async (p) => {
    await p.goto("/jsp/student/right_student_class.jsp");
    return p.url();
  });
  assert.equal(r1, "https://sms.schoolsoft.se/taby/jsp/student/right_student_class.jsp");
  await s.withPage(async () => 1);
  assert.deepEqual(state.launched, [{ headless: true }, { headless: true }], "one launch per call");
  assert.deepEqual(
    state.cookies.slice(0, 3).map((c) => c.name),
    ["JSESSIONID", "hash", "usertype"],
  );
  assert.equal(state.cookies[0].domain, "sms.schoolsoft.se");
  assert.equal(state.closedContexts, 2);
  assert.equal(state.closedBrowsers, 2, "browser closed after each call so the process can exit");
  await s.close();
  assert.equal(state.closedBrowsers, 2);
});

test("cdp engine connects to the endpoint instead of launching", async () => {
  const state = fresh();
  const s = new PlaywrightSession({
    budget: new CountingBudget(),
    school: "taby",
    cookieHeader: () => "JSESSIONID=a; hash=b",
    engine: { kind: "cdp", endpoint: "ws://obscura:9222" },
    loader: async () => fakePlaywright(state),
  });
  await s.withPage(async () => 0);
  assert.deepEqual(state.connected, ["ws://obscura:9222"]);
  assert.equal(state.launched.length, 0);
});

test("the guard aborts non-GET requests unless allowed", async () => {
  const state = fresh();
  const pw = fakePlaywright(state);
  const s = new PlaywrightSession({
    budget: new CountingBudget(),
    school: "taby",
    cookieHeader: () => "JSESSIONID=a",
    loader: async () => pw,
  });
  await s.withPage(
    async (p) => {
      // reach the fake page through the loader's closure
      const page = (await (await pw.chromium.launch({ headless: true })).newContext()).newPage();
      const fake = (await page) as unknown as { simulateRequest: (m: string, u: string) => void };
      fake.simulateRequest("GET", "https://sms.schoolsoft.se/taby/x");
      fake.simulateRequest(
        "POST",
        "https://sms.schoolsoft.se/taby/rest/blogpost/getbyloggedinuser",
      );
      fake.simulateRequest(
        "POST",
        "https://sms.schoolsoft.se/taby/jsp/student/right_student_absence.jsp",
      );
      return p.url();
    },
    { allowedNonGet: [/\/rest\/blogpost\/getbyloggedinuser$/] },
  );
  assert.deepEqual(state.routeDecisions, [
    "continue GET https://sms.schoolsoft.se/taby/x",
    "continue POST https://sms.schoolsoft.se/taby/rest/blogpost/getbyloggedinuser",
    "abort(blockedbyclient) POST https://sms.schoolsoft.se/taby/jsp/student/right_student_absence.jsp",
  ]);
});

test("landing on Login.jsp or the app-blocked page throws typed errors", async () => {
  for (const [landing, Err] of [
    [
      "https://sms.schoolsoft.se/taby/jsp/Login.jsp?eventMessage=ERR_Not_Logged_In",
      SessionLostError,
    ],
    ["https://sms.schoolsoft.se/taby/jsp/student/right_student_app_blocked.jsp", PortalGatedError],
  ] as const) {
    const state = fresh();
    state.landing = landing;
    const s = new PlaywrightSession({
      budget: new CountingBudget(),
      school: "taby",
      cookieHeader: () => "JSESSIONID=a",
      loader: async () => fakePlaywright(state),
    });
    await assert.rejects(
      s.withPage((p) => p.goto("/jsp/student/right_student_review.jsp")),
      Err,
    );
    assert.equal(state.closedContexts, 1, "context closed even on error");
  }
});

test("missing playwright surfaces as BrowserRequiredError; missing cookies as SessionLostError", async () => {
  const s = new PlaywrightSession({
    budget: new CountingBudget(),
    school: "taby",
    cookieHeader: () => "JSESSIONID=a",
    loader: async () => {
      throw new BrowserRequiredError("browser", "playwright is not installed");
    },
  });
  await assert.rejects(
    s.withPage(async () => 1),
    /headless browser/,
  );
  const t = new PlaywrightSession({
    budget: new CountingBudget(),
    school: "taby",
    cookieHeader: () => null,
    loader: async () => fakePlaywright(fresh()),
  });
  await assert.rejects(
    t.withPage(async () => 1),
    SessionLostError,
  );
});

test("browserStatus reports the three states and installChromium spawns playwright's cli", async () => {
  const missing = await browserStatus(
    { kind: "chromium" },
    {
      resolvePlaywright: () => {
        throw new Error("nope");
      },
    },
  );
  assert.equal(missing.ready, false);
  assert.match(missing.hint ?? "", /browser install/);
  const noChromium = await browserStatus(
    { kind: "chromium" },
    {
      resolvePlaywright: () => "/x/playwright/package.json",
      chromiumPath: async () => "/nonexistent/chrome",
    },
  );
  assert.equal(noChromium.playwrightInstalled, true);
  assert.equal(noChromium.ready, false);
  const cdp = await browserStatus(
    { kind: "cdp", endpoint: "ws://x" },
    { resolvePlaywright: () => "/x/playwright/package.json" },
  );
  assert.equal(cdp.ready, true);
  const calls: string[][] = [];
  const code = await installChromium(
    async (cmd, args) => {
      calls.push([cmd, ...args]);
      return 0;
    },
    () => "/x/playwright/package.json",
  );
  assert.equal(code, 0);
  assert.deepEqual(calls[0].slice(1), ["/x/playwright/cli.js", "install", "chromium"]);
  await assert.rejects(
    installChromium(
      async () => 0,
      () => {
        throw new Error("nope");
      },
    ),
    /playwright is not installed/,
  );
});

test("web-login cookies are used only when a call asks for them (gated pages)", async () => {
  const state = fresh();
  const s = new PlaywrightSession({
    budget: new CountingBudget(),
    school: "taby",
    cookieHeader: () => "JSESSIONID=app; hash=h",
    webCookies: () => [
      { name: "JSESSIONID", value: "web", domain: "sms.schoolsoft.se", path: "/", expires: -1 },
    ],
    loader: async () => fakePlaywright(state),
  });
  await s.withPage(async () => 0);
  assert.deepEqual(
    state.cookies.map((c) => c.value),
    ["app", "h"],
    "app cookies by default",
  );
  state.cookies.length = 0;
  await s.withPage(async () => 0, { web: true });
  assert.deepEqual(
    state.cookies.map((c) => c.value),
    ["web"],
    "web cookies when asked",
  );
  const noWeb = new PlaywrightSession({
    budget: new CountingBudget(),
    school: "taby",
    cookieHeader: () => "JSESSIONID=app",
    loader: async () => fakePlaywright(fresh()),
  });
  await assert.rejects(
    noWeb.withPage(async () => 0, { web: true }),
    /web login session/,
  );
});

test("headless default, cookie expiry, allowWrites, web-session loss and waitForJson", async () => {
  const state = fresh();
  const pw = fakePlaywright(state);
  const s = new PlaywrightSession({
    budget: new CountingBudget(),
    school: "taby",
    cookieHeader: () => "JSESSIONID=app",
    webCookies: () => [
      {
        name: "JSESSIONID",
        value: "web",
        domain: "sms.schoolsoft.se",
        path: "/",
        expires: 1_900_000_000,
      },
      { name: "hash", value: "h", domain: "sms.schoolsoft.se", path: "/", expires: -1 },
    ],
    engine: { kind: "chromium" },
    loader: async () => pw,
  });
  const json = await s.withPage(
    async (p) => {
      const page = (await (await pw.chromium.launch({ headless: true })).newContext()).newPage();
      const fake = (await page) as unknown as { simulateRequest: (m: string, u: string) => void };
      fake.simulateRequest("POST", "https://sms.schoolsoft.se/taby/anything");
      return p.waitForJson<{ ok: boolean }>(/x/);
    },
    { web: true, allowWrites: true },
  );
  assert.deepEqual(json, { ok: true });
  assert.deepEqual(
    state.launched,
    [{ headless: true }, { headless: true }],
    "headless defaults to true",
  );
  assert.deepEqual(
    state.cookies.map((c) => (c as { expires?: number }).expires),
    [1_900_000_000, undefined],
    "positive expiry kept, session cookies get none",
  );
  assert.deepEqual(state.routeDecisions, ["continue POST https://sms.schoolsoft.se/taby/anything"]);

  // web cookies present but empty → app cookies
  const st2 = fresh();
  const s2 = new PlaywrightSession({
    budget: new CountingBudget(),
    school: "taby",
    cookieHeader: () => "JSESSIONID=app",
    webCookies: () => [],
    loader: async () => fakePlaywright(st2),
  });
  await s2.withPage(async () => 0, { web: false });
  assert.deepEqual(
    st2.cookies.map((c) => c.value),
    ["app"],
  );

  // landing on Login.jsp with web cookies names login --web
  const st3 = fresh();
  st3.landing = "https://sms.schoolsoft.se/taby/jsp/Login.jsp";
  const s3 = new PlaywrightSession({
    budget: new CountingBudget(),
    school: "taby",
    cookieHeader: () => "JSESSIONID=app",
    webCookies: () => [{ name: "JSESSIONID", value: "w", domain: "sms.schoolsoft.se", path: "/" }],
    loader: async () => fakePlaywright(st3),
  });
  await assert.rejects(
    s3.withPage((p) => p.goto("/jsp/student/x.jsp"), { web: true }),
    /web login session/,
  );
});

test("browserStatus without probes resolves the real playwright; chromiumPath failures and cdp without playwright are reported", async () => {
  const real = await browserStatus({ kind: "chromium" });
  assert.equal(real.playwrightInstalled, true);
  assert.equal(typeof real.executablePath, "string");
  const unresolved = await browserStatus(
    { kind: "chromium" },
    {
      resolvePlaywright: () => "/x/playwright/package.json",
      chromiumPath: async () => {
        throw new Error("no browser");
      },
    },
  );
  assert.equal(unresolved.ready, false);
  assert.equal(unresolved.executablePath, undefined);
  const cdpNoPw = await browserStatus(
    { kind: "cdp", endpoint: "ws://x" },
    {
      resolvePlaywright: () => {
        throw new Error("nope");
      },
    },
  );
  assert.equal(cdpNoPw.ready, false);
  assert.match(cdpNoPw.hint ?? "", /install playwright/);
  const calls: string[][] = [];
  const code = await installChromium(async (cmd, args) => {
    calls.push([cmd, ...args]);
    return 0;
  });
  assert.equal(code, 0);
  assert.match(calls[0][1], /playwright\/cli\.js$/);
});

test("defaultSpawner resolves the exit code, 1 for a signal, rejects on spawn error", async () => {
  const { defaultSpawner } = await import("../../src/core/browser/install.js");
  const { EventEmitter } = await import("node:events");
  const mk = (fire: (c: InstanceType<typeof EventEmitter>) => void) => {
    const child = new EventEmitter();
    queueMicrotask(() => fire(child));
    return (() => child) as never;
  };
  assert.equal(
    await defaultSpawner(
      "x",
      [],
      mk((c) => c.emit("exit", 3)),
    ),
    3,
  );
  assert.equal(
    await defaultSpawner(
      "x",
      [],
      mk((c) => c.emit("exit", null)),
    ),
    1,
  );
  await assert.rejects(
    defaultSpawner(
      "x",
      [],
      mk((c) => c.emit("error", new Error("ENOENT"))),
    ),
    /ENOENT/,
  );
});

test("every navigation is one request of the budget; its status and Retry-After teach the breaker", async () => {
  const state = fresh();
  const counting = new CountingBudget();
  const s = new PlaywrightSession({
    budget: counting,
    school: "taby",
    cookieHeader: () => "JSESSIONID=a",
    loader: async () => fakePlaywright(state),
  });
  await s.withPage(async (p) => {
    await p.goto("/jsp/one.jsp");
    state.response = { status: () => 503, headers: () => ({ "retry-after": "12" }) };
    await p.goto("/jsp/two.jsp");
  });
  assert.equal(counting.calls.length, 2);
  assert.deepEqual(counting.answers, [
    { status: 200, retryAfter: null },
    { status: 503, retryAfter: "12" },
  ]);
  const clock = new FakeClock();
  const budget = fakeBudget(clock);
  state.response = { status: () => 429, headers: () => ({}) };
  const limited = new PlaywrightSession({
    budget,
    school: "taby",
    cookieHeader: () => "JSESSIONID=a",
    loader: async () => fakePlaywright(state),
  });
  await assert.rejects(
    limited.withPage((p) => p.goto("/jsp/three.jsp")),
    (e) => e instanceof PortalPushbackError && e.sent,
  );
});

test("host consent is checked when a queued browser navigation dispatches and before extraction", async () => {
  const state = fresh();
  let allowed = true;
  let checks = 0;
  const controller = new AbortController();
  const session = new PlaywrightSession({
    budget: new CountingBudget(),
    school: "taby",
    cookieHeader: () => "JSESSIONID=a",
    loader: async () => fakePlaywright(state),
    signal: controller.signal,
    beforeRead: () => {
      checks++;
      if (!allowed) throw new Error("revoked");
    },
  });
  await session.withPage(async (page) => {
    await page.goto("/test");
    assert.equal(await page.evaluate(() => 42), 42);
    assert.deepEqual(await page.waitForJson(/schoolsoft/), { ok: true });
    allowed = false;
    await assert.rejects(page.goto("/forbidden"), /revoked/);
    await assert.rejects(async () => page.evaluate(() => 43), /revoked/);
    await assert.rejects(page.waitForJson(/schoolsoft/), /revoked/);
  });
  assert.equal(checks, 6);
  assert.equal(state.landing, "https://sms.schoolsoft.se/taby/test");
  assert.equal(state.closedBrowsers, 1);
});
