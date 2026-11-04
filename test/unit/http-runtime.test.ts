import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTOR_OPERATIONS,
  ConnectorRuntime,
  type ConnectorRuntimeOptions,
} from "../../src/http/runtime.js";
import {
  MemorySessionStore,
  MemoryPendingLoginStore,
  MemorySessionHistoryStore,
  resolveConfig,
  operations,
  type PlaywrightLike,
} from "../../src/core/index.js";
import { FakeTimer } from "../helpers/fake-timer.js";
import { CountingBudget } from "../helpers/budget.js";
import { ResponseDriftError } from "../../src/core/errors/index.js";
import {
  DRIFT_FIELDS,
  DRIFT_KINDS,
  driftedList,
  driftedParent,
  rawLessonsWeek,
  rawLunch,
} from "../helpers/portal-json.js";
import { lunchYear } from "../../src/core/operations/get-lunch-menu.js";
import { weekOf } from "../../src/core/operations/_week.js";
import { isoWeekDate } from "../../src/core/domain/time.js";

/** The one lesson the fake portal answers, titled with the cookie that read it. */
const lessonsFor = (cookie: string) => [
  {
    id: "lesson:1@2026-09-07T08:30:00+02:00",
    title: cookie,
    start: "2026-09-07T08:30:00+02:00",
    end: "2026-09-07T09:30:00+02:00",
    room: null,
    group: null,
    teacher: null,
    note: null,
  },
];

function fixture(
  options: {
    timeout?: number;
    pinned?: string;
    now?: () => number;
    keepalive?: string;
    timer?: FakeTimer;
    qrLogin?: boolean;
  } = {},
) {
  const store = new MemorySessionStore();
  let identity = options.pinned;
  let userId = 21;
  let failed = false;
  let override: ((url: string) => unknown) | null = null;
  let children = [100, 101];
  let rejectRead = false;
  let onRead: (() => void) | undefined;
  const events: string[] = [];
  const history = new MemorySessionHistoryStore();
  const runtimeOptions: ConnectorRuntimeOptions = {
    config: resolveConfig([{ school: "taby", keepalive: options.keepalive }], {
      home: "/unused",
      platform: "linux",
    }),
    keepaliveDeps: options.timer ? { timer: options.timer, random: () => 0 } : undefined,
    redirectUri: "https://parent.example/school/callback",
    qrLogin: options.qrLogin,
    store,
    identityStore: {
      read: () => identity,
      write: (id) => {
        identity = id;
      },
    },
    loginTimeoutMs: options.timeout,
    now: options.now,
    deps: {
      pending: new MemoryPendingLoginStore(),
      history,
      // Not about the budget: these tests send more than a burst; its limits are tested elsewhere.
      budget: new CountingBudget(),
      fetchImpl: async (
        url: string,
        _school: string,
        request: { headers?: Record<string, string> },
      ) => {
        if (failed) throw new Error("upstream unavailable");
        // The session check after a restore (budgeted like every request); not a data read.
        if (url.endsWith("/rest-api/session"))
          return { status: 200, data: {}, headers: {}, setCookies: [] };
        const replaced = override?.(url);
        if (replaced !== undefined)
          return { status: 200, data: replaced, headers: {}, setCookies: [] };
        if (url.includes("/login/token"))
          return {
            status: 200,
            data: { access_token: "token", refresh_token: "refresh", expires: 3600 },
            headers: {},
            setCookies: [],
          };
        if (url.endsWith("/eva/api/v1/parent"))
          return {
            status: 200,
            data: {
              userId,
              firstName: "Parent",
              lastName: "Test",
              children: children.map((studentId) => ({
                studentId,
                firstName: `Child ${studentId}`,
                schools: [{ orgId: 20, name: "School" }],
              })),
            },
            headers: {},
            setCookies: [],
          };
        if (url.includes("eva-apps/auth")) {
          const child = request.headers!.childInFocus;
          events.push(`focus:${child}`);
          await delay(1);
          return {
            status: 303,
            data: "",
            headers: {},
            setCookies: [`JSESSIONID=${child}; Path=/`, "hash=h; Path=/"],
          };
        }
        events.push(`read:${request.headers?.Cookie ?? "lunch"}`);
        onRead?.();
        if (rejectRead) {
          rejectRead = false;
          return { status: 401, data: null, headers: {}, setCookies: [] };
        }
        await delay(5);
        const lunchWeek = /\/lunchmenu\/(\d+)$/.exec(url);
        return {
          status: 200,
          data: url.includes("/agenda?")
            ? [
                {
                  eventId: 1,
                  name: "Synthetic",
                  startDate: "2026-09-07T09:00",
                  endDate: "2026-09-07T10:00",
                  allDay: false,
                  description: request.headers?.Cookie,
                },
              ]
            : lunchWeek
              ? [
                  {
                    week: Number(lunchWeek[1]),
                    dayId: 1,
                    dishes: [{ mealType: "Lunch", description: "lunch" }],
                  },
                ]
              : [
                  {
                    eventId: 1,
                    name: request.headers?.Cookie,
                    startDate: "2026-09-07T08:30",
                    endDate: "2026-09-07T09:30",
                  },
                ],
          headers: {},
          setCookies: [],
        };
      },
    },
  };
  const runtime = new ConnectorRuntime(runtimeOptions);
  return {
    runtime,
    runtimeOptions,
    store,
    events,
    history,
    identity: () => identity,
    rejectNextRead: (remaining = [100, 101]) => {
      children = remaining;
      rejectRead = true;
    },
    onRead: (callback: () => void) => {
      onRead = callback;
    },
    changeUser: () => {
      userId = 22;
    },
    fail: () => {
      failed = true;
    },
    /** Answer matching URLs with other JSON (a drifted shape); undefined = the usual answer. */
    override: (fn: ((url: string) => unknown) | null) => {
      override = fn;
    },
  };
}
async function login(runtime: ConnectorRuntime) {
  const { url } = await runtime.beginLogin();
  const state = new URLSearchParams(url.split("?")[1]).get("state")!;
  assert.equal(runtime.callback(state, "CODE"), true);
  await runtime.execute("list_children", {}, [100, 101]);
  return state;
}

test("remote login state is exact, one-use, private; metadata and reads honor child consent", async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.status(), {
    authenticated: false,
    loginInProgress: false,
    sessionHistory: { recordedSince: null, app: null, web: null, losses: [] },
    portal: { state: "ok", retryAt: null },
    children: [],
  });
  const { url } = await f.runtime.beginLogin();
  assert.equal((await f.runtime.status()).loginInProgress, true);
  await assert.rejects(f.runtime.beginLogin(), /already in progress/);
  const state = new URLSearchParams(url.split("?")[1]).get("state")!;
  assert.equal(f.runtime.callback("wrong", "CODE"), false);
  assert.equal(f.runtime.callback("x".repeat(state.length), "CODE"), false);
  assert.equal(f.runtime.callback(state, ""), false);
  assert.equal(f.runtime.callback(state, "CODE"), true);
  assert.equal(f.runtime.callback(state, "CODE"), false);
  assert.deepEqual(await f.runtime.execute("list_children", {}, [101]), {
    children: [{ id: 101, firstName: "Child 101" }],
    childInFocus: null,
  });
  assert.equal(f.identity(), "schoolsoft:taby:21");
  const connected = await f.runtime.status();
  assert.equal(connected.sessionHistory?.app?.activityCount, 0, "the login is on record");
  assert.deepEqual(connected.sessionHistory?.losses, []);
  assert.deepEqual(
    { ...connected, sessionHistory: undefined },
    {
      authenticated: true,
      loginInProgress: false,
      webSession: false,
      sessionHistory: undefined,
      portal: { state: "ok", retryAt: null },
      children: [
        { id: 100, name: "Child 100" },
        { id: 101, name: "Child 101" },
      ],
    },
  );
  await assert.rejects(f.runtime.execute("login", {}, [100]), /not available/);
  await assert.rejects(f.runtime.execute("logout", {}, [100]), /not available/);
  await assert.rejects(
    f.runtime.execute("report_absence", { child_id: 100, confirm: true }, [100]),
    /not available/,
  );
  await assert.rejects(f.runtime.execute("get_schedule", { week: 54 }, [100]), /arguments/);
  await assert.rejects(f.runtime.execute("get_schedule", { unknown: 1 }, [100]), /arguments/);
  await assert.rejects(f.runtime.execute("get_schedule", {}, []), /No permitted/);
  await assert.rejects(f.runtime.execute("get_schedule", {}, [999]), /No permitted/);
  await assert.rejects(f.runtime.execute("get_schedule", {}, [101]), /not permitted/);
  await assert.rejects(
    f.runtime.execute("get_schedule", { child_id: 101 }, [100]),
    /not permitted/,
  );
  const year = lunchYear(2);
  assert.deepEqual(await f.runtime.execute("get_lunch_menu", { week: 2 }, [100]), {
    year,
    week: 2,
    child: { id: 100, firstName: "Child 100" },
    days: [
      {
        date: isoWeekDate(year, 2, 1),
        weekday: 1,
        dishes: [{ kind: "Lunch", description: "lunch" }],
      },
    ],
  });
  await f.runtime.logout();
  assert.equal(f.store.load(), null);
  assert.equal(f.identity(), "schoolsoft:taby:21");
  await assert.rejects(f.runtime.execute("get_schedule", {}, [100]), /Not logged in/);
  assert.equal(f.runtime.callback(state, "CODE"), false);
  await f.runtime.close();
  await assert.rejects(f.runtime.beginLogin(), /closed/);
  await assert.rejects(f.runtime.execute("list_children", {}, [100]), /closed/);
  assert.equal((await f.runtime.status()).authenticated, false);
});

test("concurrent reads keep focus and request atomic; logout waits for an active read", async () => {
  const f = fixture();
  await login(f.runtime);
  f.events.length = 0;
  const a = f.runtime.execute("get_schedule", { child_id: 101, week: 2 }, [100, 101]);
  const b = f.runtime.execute("get_schedule", { child_id: 100, week: 3 }, [100, 101]);
  const logout = f.runtime.logout();
  const [first, second] = await Promise.all([a, b]);
  assert.deepEqual(first, {
    ...weekOf(2),
    child: { id: 101, firstName: "Child 101" },
    lessons: lessonsFor("JSESSIONID=101; hash=h; usertype=1"),
  });
  assert.deepEqual(second, {
    ...weekOf(3),
    child: { id: 100, firstName: "Child 100" },
    lessons: lessonsFor("JSESSIONID=100; hash=h; usertype=1"),
  });
  assert.deepEqual(f.events, [
    "focus:101",
    "read:JSESSIONID=101; hash=h; usertype=1",
    "focus:100",
    "read:JSESSIONID=100; hash=h; usertype=1",
  ]);
  await logout;
  assert.equal(f.store.load(), null);
  await f.runtime.close();
});

test("wrong guardian never becomes available and credentials are cleared", async () => {
  const f = fixture({ pinned: "schoolsoft:taby:999" });
  const { url } = await f.runtime.beginLogin();
  f.runtime.callback(new URLSearchParams(url.split("?")[1]).get("state")!, "CODE");
  await assert.rejects(f.runtime.execute("list_children", {}, [100]), /Not logged in/);
  assert.equal(f.store.load(), null);
  assert.equal((await f.runtime.status()).authenticated, false);
  assert.equal(f.identity(), "schoolsoft:taby:999");
  assert.equal((await f.runtime.status()).loginError, "different_guardian");
  await f.runtime.close();
});

test("QR login delivers a code internally and persists the same refreshable guardian session", async () => {
  const f = fixture({ qrLogin: true });
  assert.equal(f.runtime.qrImage(), undefined);
  f.override((url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/bankid/secure"))
      return {
        sessionId: "synthetic",
        QRCode: Buffer.from("<svg>initial</svg>").toString("base64"),
      };
    if (u.pathname.endsWith("/bankid/secure/collect")) return { username: "Synthetic" };
    if (u.pathname.endsWith("/bankid/secure/redirect"))
      return {
        redirect_uri:
          "com.schoolsoft.vapp://?" +
          new URLSearchParams({ state: u.searchParams.get("state")!, code: "CODE" }),
      };
    return undefined;
  });
  assert.deepEqual(await f.runtime.beginLogin(), { url: "/owner/schoolsoft/qr" });
  assert.equal(f.runtime.qrImage(), "<svg>initial</svg>");
  assert.equal(await f.runtime.qrStatus(), "pending");
  await f.runtime.execute("list_children", {}, [100]);
  assert.equal(await f.runtime.qrStatus(), "complete");
  assert.equal(f.runtime.qrImage(), undefined);
  assert.ok(f.store.load());
  await f.runtime.close();
});
test("QR failures stop the login and expose only a failed status", async () => {
  const f = fixture({ qrLogin: true });
  f.override((url) =>
    url.includes("/bankid/secure")
      ? { sessionId: "synthetic", QRCode: Buffer.from("<svg>initial</svg>").toString("base64") }
      : undefined,
  );
  await f.runtime.beginLogin();
  f.fail();
  await f.runtime.qrStatus();
  await assert.rejects(f.runtime.execute("list_children", {}, [100]));
  assert.equal(await f.runtime.qrStatus(), "failed");
  assert.equal(f.runtime.qrImage(), undefined);
  await f.runtime.close();
});
test("owner can cancel a QR login immediately without clearing other app grants", async () => {
  const f = fixture({ qrLogin: true });
  f.runtime.cancelQrLogin();
  f.override((url) =>
    url.includes("/bankid/secure")
      ? { sessionId: "synthetic", QRCode: Buffer.from("<svg>initial</svg>").toString("base64") }
      : undefined,
  );
  await f.runtime.beginLogin();
  f.runtime.cancelQrLogin();
  await assert.rejects(f.runtime.execute("list_children", {}, [100]));
  assert.equal(await f.runtime.qrStatus(), "failed");
  assert.equal(f.runtime.qrImage(), undefined);
  await f.runtime.close();
});
test("deadline and cancellation terminate pending login and reject late callbacks", async () => {
  let now = 0;
  const f = fixture({ timeout: 20, now: () => now });
  const { url } = await f.runtime.beginLogin();
  now = 21;
  assert.equal(
    f.runtime.callback(new URLSearchParams(url.split("?")[1]).get("state")!, "CODE"),
    false,
  );
  await f.runtime.logout();
  assert.equal((await f.runtime.status()).loginError, "expired");
  const again = await f.runtime.beginLogin();
  await delay(30);
  assert.equal(
    f.runtime.callback(new URLSearchParams(again.url.split("?")[1]).get("state")!, "CODE"),
    false,
  );
  assert.equal((await f.runtime.status()).authenticated, false);
  await f.runtime.beginLogin();
  await f.runtime.close();
  assert.equal((await f.runtime.status()).loginError, "cancelled");
});

test("the connector keeps its login in progress in memory: nothing is written to the data disk", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "connector-pending-"));
  const f = fixture();
  // The production default: no pending store injected.
  const { pending: _injected, ...deps } = f.runtimeOptions.deps!;
  const runtime = new ConnectorRuntime({
    ...f.runtimeOptions,
    config: resolveConfig([{ school: "taby", stateDir }], { home: "/unused", platform: "linux" }),
    deps,
  });
  await runtime.beginLogin();
  let during: string[];
  try {
    assert.equal((await runtime.status()).loginInProgress, true);
    during = readdirSync(stateDir);
  } finally {
    await runtime.close();
  }
  assert.deepEqual(during, []);
  assert.equal((await runtime.status()).loginError, "cancelled");
  assert.deepEqual(readdirSync(stateDir), []);
});

test("cancel queued login before it starts and close after callback cannot persist credentials", async () => {
  const f = fixture();
  const beginning = f.runtime.beginLogin();
  const rejection = assert.rejects(beginning, /cancelled/);
  await f.runtime.logout();
  await rejection;
  assert.equal((await f.runtime.status()).loginError, "cancelled");
  const { url } = await f.runtime.beginLogin();
  f.runtime.callback(new URLSearchParams(url.split("?")[1]).get("state")!, "CODE");
  await f.runtime.close();
  assert.equal(f.store.load(), null);
});

test("failed upstream login clears any partial tokens", async () => {
  const f = fixture();
  const { url } = await f.runtime.beginLogin();
  f.fail();
  f.runtime.callback(new URLSearchParams(url.split("?")[1]).get("state")!, "CODE");
  await assert.rejects(f.runtime.execute("list_children", {}, [100]), /Not logged in/);
  assert.equal(f.store.load(), null);
  assert.equal((await f.runtime.status()).loginError, "upstream");
  await f.runtime.close();
});

test("restart restores the encrypted-store session and enforces identity pin on restore", async () => {
  const f = fixture();
  await login(f.runtime);
  await f.runtime.close();
  const restored = new ConnectorRuntime(f.runtimeOptions);
  assert.equal((await restored.status()).authenticated, true);
  await restored.close();
  f.changeUser();
  const changed = new ConnectorRuntime(f.runtimeOptions);
  assert.equal((await changed.status()).authenticated, false);
  assert.equal(f.store.load(), null);
  await changed.close();
});

test("recovery cannot retry a read against an unapproved fallback sibling", async () => {
  const f = fixture();
  await login(f.runtime);
  f.events.length = 0;
  f.rejectNextRead([101]);
  await assert.rejects(
    f.runtime.execute("get_schedule", { week: 2 }, [100]),
    /no longer permitted/,
  );
  assert.deepEqual(f.events, ["read:JSESSIONID=100; hash=h; usertype=1", "focus:101"]);
  await f.runtime.close();
});

test("recovery revalidates the guardian and succeeds only for the original child", async () => {
  const f = fixture();
  await login(f.runtime);
  f.rejectNextRead();
  const result = await f.runtime.execute("get_schedule", { child_id: 101, week: 2 }, [101]);
  assert.deepEqual(result, {
    ...weekOf(2),
    child: { id: 101, firstName: "Child 101" },
    lessons: lessonsFor("JSESSIONID=101; hash=h; usertype=1"),
  });
  f.changeUser();
  f.rejectNextRead();
  // fresh: the week is cached by now, and only an upstream read can meet the changed guardian.
  await assert.rejects(
    f.runtime.execute("get_schedule", { week: 2, fresh: true }, [101]),
    /different guardian/,
  );
  assert.equal(f.store.load(), null);
  await f.runtime.close();
});

test("queued revoked and aborted operations never read; interrupted results are withheld", async () => {
  const f = fixture();
  await login(f.runtime);
  f.events.length = 0;
  let active = true;
  const controller = new AbortController();
  const first = f.runtime.execute("get_schedule", {}, [100]);
  const revoked = f.runtime.execute("get_schedule", {}, [100], {
    check: () => {
      if (!active) throw new Error("revoked");
    },
  });
  const aborted = f.runtime.execute("get_schedule", {}, [100], { signal: controller.signal });
  active = false;
  controller.abort();
  await Promise.all([
    first,
    assert.rejects(revoked, /revoked/),
    assert.rejects(aborted, /cancelled/),
  ]);
  assert.equal(f.events.filter((e) => e.startsWith("read:")).length, 1);
  const late = new AbortController();
  f.onRead(() => late.abort());
  await assert.rejects(
    f.runtime.execute("get_schedule", { fresh: true }, [100], { signal: late.signal }),
    /cancelled/,
  );
  await f.runtime.close();
});

test("permission guard runs after restore, during recovery and before releasing child lists", async () => {
  const f = fixture();
  await login(f.runtime);
  let checks = 0;
  await assert.rejects(
    f.runtime.execute("list_children", {}, [100], {
      check: () => {
        if (++checks === 2) throw new Error("revoked");
      },
    }),
    /revoked/,
  );
  f.rejectNextRead();
  let active = true;
  f.onRead(() => {
    active = false;
  });
  const before = f.events.filter((e) => e.startsWith("read:")).length;
  await assert.rejects(
    f.runtime.execute("get_schedule", {}, [100], {
      check: () => {
        if (!active) throw new Error("revoked");
      },
    }),
    /revoked/,
  );
  assert.equal(f.events.filter((e) => e.startsWith("read:")).length, before + 1);
  await f.runtime.close();
});

test("post-read child authorization and focus are checked before releasing results", async () => {
  const f = fixture();
  await login(f.runtime);
  const allowed = [100];
  f.onRead(() => {
    allowed.length = 0;
  });
  await assert.rejects(f.runtime.execute("get_schedule", {}, allowed), /no longer permitted/);
  // Simulate a provider changing its context during a read, despite serialization.
  f.onRead(() => {
    f.runtime["manager"].guardian().childInFocus = 101;
  });
  await assert.rejects(
    f.runtime.execute("get_schedule", { fresh: true }, [100]),
    /session changed/,
  );
  await f.runtime.close();
});

test("outstanding execute requests are bounded while owner status and cancellation remain usable", async () => {
  const f = fixture();
  await f.runtime.beginLogin();
  const queued = Array.from({ length: 16 }, () =>
    assert.rejects(f.runtime.execute("get_schedule", {}, [100]), /Not logged in/),
  );
  await assert.rejects(f.runtime.execute("get_schedule", {}, [100]), /busy/);
  assert.equal((await f.runtime.status()).loginInProgress, true);
  await f.runtime.logout();
  await Promise.all(queued);
  await assert.rejects(f.runtime.execute("get_schedule", {}, [100]), /Not logged in/);
  await f.runtime.close();
});

test("calendar reads are serialized across children and each source uses the selected child's cookies", async () => {
  const f = fixture();
  await login(f.runtime);
  f.events.length = 0;
  const results = (await Promise.all(
    [101, 100].map((child_id) =>
      f.runtime.execute(
        "get_calendar",
        { child_id, start_date: "2026-09-01", end_date: "2026-09-30" },
        [100, 101],
      ),
    ),
  )) as { child: { id: number }; events: { note: string }[] }[];
  for (const [index, child] of [101, 100].entries()) {
    assert.equal(results[index].child.id, child);
    assert.equal(results[index].events.length, 2);
    assert.ok(results[index].events.every((entry) => entry.note.includes(`JSESSIONID=${child};`)));
  }
  assert.deepEqual(f.events, [
    "focus:101",
    "read:JSESSIONID=101; hash=h; usertype=1",
    "read:JSESSIONID=101; hash=h; usertype=1",
    "focus:100",
    "read:JSESSIONID=100; hash=h; usertype=1",
    "read:JSESSIONID=100; hash=h; usertype=1",
  ]);
  await assert.rejects(
    f.runtime.execute("get_calendar", { child_id: 101 }, [100]),
    /not permitted/,
  );
  await f.runtime.close();
});

test("calendar revocation, abort and focus changes stop the second read and withhold completed results", async () => {
  for (const interruptAfter of [1, 2]) {
    for (const mode of ["revoke", "abort", "focus", "child"]) {
      const f = fixture();
      await login(f.runtime);
      f.events.length = 0;
      let active = true,
        reads = 0;
      const controller = new AbortController();
      const allowed = [100];
      f.onRead(() => {
        if (++reads !== interruptAfter) return;
        if (mode === "revoke") active = false;
        if (mode === "abort") controller.abort();
        if (mode === "focus") f.runtime["manager"].guardian().childInFocus = 101;
        if (mode === "child") allowed.length = 0;
      });
      await assert.rejects(
        f.runtime.execute("get_calendar", {}, allowed, {
          check: () => {
            if (!active) throw new Error("revoked");
          },
          signal: controller.signal,
        }),
        /revoked|cancelled|session changed|no longer permitted/,
      );
      assert.equal(f.events.filter((event) => event.startsWith("read:")).length, interruptAfter);
      await f.runtime.close();
    }
  }
});

test("calendar recovery restarts both sources for the same permitted child", async () => {
  for (const failAt of [1, 2]) {
    const f = fixture();
    await login(f.runtime);
    let reads = 0;
    f.onRead(() => {
      if (++reads === failAt) f.rejectNextRead();
    });
    const result = (await f.runtime.execute("get_calendar", { child_id: 101 }, [101])) as {
      events: { note: string }[];
    };
    assert.equal(result.events.length, 2);
    assert.ok(result.events.every((entry) => entry.note.includes("JSESSIONID=101;")));
    assert.equal(reads, failAt + 2);
    await f.runtime.close();
  }
});

test("calendar recovery refuses a fallback sibling or different guardian", async () => {
  for (const mode of ["child", "guardian", "revoked"]) {
    const f = fixture();
    await login(f.runtime);
    let reads = 0,
      active = true;
    f.onRead(() => {
      if (++reads !== 2) return;
      if (mode === "guardian") f.changeUser();
      if (mode === "revoked") active = false;
      f.rejectNextRead(mode === "child" ? [101] : [100, 101]);
    });
    await assert.rejects(
      f.runtime.execute("get_calendar", {}, [100], {
        check: () => {
          if (!active) throw new Error("revoked");
        },
      }),
      /no longer permitted|different guardian|revoked/,
    );
    assert.equal(reads, 2);
    await f.runtime.close();
  }
});

// ------------------------------------------------------------------ read cache

const reads = (f: ReturnType<typeof fixture>) => f.events.filter((e) => e.startsWith("read:"));

test("cache: repeated reads are served from memory per child, fresh goes upstream, and a child never gets a sibling's copy", async () => {
  const f = fixture();
  await login(f.runtime);
  const both = [100, 101];
  const first = await f.runtime.execute("get_schedule", { child_id: 100, week: 2 }, both);
  assert.deepEqual(
    await f.runtime.execute("get_schedule", { child_id: 100, week: 2 }, both),
    first,
  );
  assert.equal(reads(f).length, 1, "the second answer came from memory");
  const sibling = (await f.runtime.execute("get_schedule", { child_id: 101, week: 2 }, both)) as {
    lessons: unknown[];
  };
  assert.deepEqual(sibling.lessons, lessonsFor("JSESSIONID=101; hash=h; usertype=1"));
  const back = (await f.runtime.execute("get_schedule", { child_id: 100, week: 2 }, both)) as {
    lessons: unknown[];
  };
  assert.deepEqual(back.lessons, lessonsFor("JSESSIONID=100; hash=h; usertype=1"));
  assert.equal(
    reads(f).length,
    3,
    "a child switch empties the cache: both were read for themselves",
  );
  await f.runtime.execute("get_schedule", { child_id: 100, week: 2, fresh: true }, both);
  assert.equal(reads(f).length, 4);
  // Lunch is the same school for both children; it is still keyed, and read, per child.
  await f.runtime.execute("get_lunch_menu", { child_id: 100, week: 2 }, both);
  await f.runtime.execute("get_lunch_menu", { child_id: 100, week: 2 }, both);
  await f.runtime.execute("get_lunch_menu", { child_id: 101, week: 2 }, [101]);
  assert.equal(reads(f).filter((e) => e === "read:lunch").length, 2);
  await f.runtime.close();
});

test("cache: a revoked or cancelled app receives nothing from a warm cache, at whichever checkpoint the revocation lands", async () => {
  const f = fixture();
  await login(f.runtime);
  const args = { child_id: 100, week: 2 };
  const warm = await f.runtime.execute("get_schedule", args, [100]);
  const before = reads(f).length;
  // How many times is authorization consulted on a pure cache hit?
  let calls = 0;
  assert.deepEqual(
    await f.runtime.execute("get_schedule", args, [100], { check: () => void calls++ }),
    warm,
  );
  assert.ok(calls >= 4, `queue, child validation, cache guard and release: saw ${calls}`);
  for (let revokeAt = 1; revokeAt <= calls; revokeAt++) {
    let n = 0;
    await assert.rejects(
      f.runtime.execute("get_schedule", args, [100], {
        check: () => {
          if (++n >= revokeAt) throw new Error("revoked");
        },
      }),
      /revoked/,
      `revoked at checkpoint ${revokeAt}`,
    );
  }
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    f.runtime.execute("get_schedule", args, [100], { signal: aborted.signal }),
    /cancelled/,
  );
  assert.equal(reads(f).length, before, "and none of it reached SchoolSoft either");
  await f.runtime.close();
});

test("cache: an app without permission for a child cannot obtain that child's cached data, by id, by default focus or through lunch", async () => {
  const f = fixture();
  await login(f.runtime);
  const appA = [100, 101];
  const appB = [100];
  await f.runtime.execute("get_schedule", { child_id: 101, week: 2 }, appA);
  await f.runtime.execute(
    "get_calendar",
    { child_id: 101, start_date: "2026-09-07", end_date: "2026-09-08" },
    appA,
  );
  await f.runtime.execute("get_lunch_menu", { child_id: 101, week: 2 }, appA);
  const before = reads(f).length;
  // Child 101 is in focus and its answers are warm. App B may only see child 100.
  for (const [name, a] of [
    ["get_schedule", { child_id: 101, week: 2 }],
    ["get_schedule", { week: 2 }],
    ["get_calendar", { child_id: 101, start_date: "2026-09-07", end_date: "2026-09-08" }],
    ["get_lunch_menu", { week: 2 }],
  ] as const) {
    await assert.rejects(f.runtime.execute(name, a, appB), /not permitted/, name);
  }
  assert.equal(reads(f).length, before);
  const own = (await f.runtime.execute("get_schedule", { child_id: 100, week: 2 }, appB)) as {
    child: { id: number };
    lessons: unknown[];
  };
  assert.equal(own.child.id, 100);
  assert.deepEqual(
    own.lessons,
    lessonsFor("JSESSIONID=100; hash=h; usertype=1"),
    "its own child, read for itself",
  );
  // Permission withdrawn for a child whose data is warm: refused, from memory too.
  const narrowed = [100];
  await f.runtime.execute("get_schedule", { child_id: 100, week: 2 }, narrowed);
  narrowed.length = 0;
  // A named child outside the grant is refused before the session is even consulted.
  await assert.rejects(
    f.runtime.execute("get_schedule", { child_id: 100, week: 2 }, narrowed),
    /not permitted/,
  );
  await f.runtime.close();
});

test("cache: logout empties it, and so does a focus change that slipped past serialization", async () => {
  const f = fixture();
  await login(f.runtime);
  await f.runtime.execute("get_schedule", { week: 2 }, [100]);
  // A provider changing its context mid-hit is caught by the guard before the cached value is served.
  f.runtime["manager"].guardian().childInFocus = 101;
  const hits = reads(f).length;
  const viaFocus = (await f.runtime.execute("get_schedule", { child_id: 100, week: 2 }, [100])) as {
    lessons: unknown[];
  };
  assert.deepEqual(viaFocus.lessons, lessonsFor("JSESSIONID=100; hash=h; usertype=1"));
  assert.equal(reads(f).length, hits + 1, "refocused, cache cleared, read again");
  await f.runtime.logout();
  await login(f.runtime);
  await f.runtime.execute("get_schedule", { week: 2 }, [100]);
  assert.equal(reads(f).length, hits + 2);
  await f.runtime.close();
});

// ------------------------------------------------------------------- keepalive

test("keepalive: off unless the deployment enables it; ticks queue behind reads, never log in, and end with the connector", async () => {
  const offTimer = new FakeTimer();
  const off = fixture({ timer: offTimer });
  off.runtime.startKeepalive();
  assert.equal(offTimer.pending.size, 0);
  await off.runtime.close();

  const timer = new FakeTimer();
  const f = fixture({ keepalive: "app", timer, now: timer.now });
  await login(f.runtime);
  f.runtime.startKeepalive();
  assert.equal(timer.pending.size, 1);
  const order: string[] = [];
  f.onRead(() => void order.push("read"));
  const slowRead = f.runtime.execute("get_schedule", { week: 9 }, [100]);
  const tick = timer.fire(); // fires while the read holds the queue
  await slowRead;
  await tick;
  await f.runtime.status(); // the queue is serial: once this answers, the tick has run
  assert.equal(
    f.history.read()!.app!.activityCount,
    1,
    "one refresh on record, made after the read",
  );
  assert.equal(f.store.load()!.data.refreshToken, "refresh");
  assert.deepEqual(order, ["read"]);
  assert.equal(timer.pending.size, 1, "and the next check is scheduled");
  await f.runtime.close();
  assert.equal(timer.pending.size, 0, "close stops the timers");

  const late = fixture({ keepalive: "app", timer: new FakeTimer() });
  await login(late.runtime);
  late.runtime.startKeepalive();
  const pendingTimer = late.runtimeOptions.keepaliveDeps!.timer as FakeTimer;
  const [entry] = [...pendingTimer.pending.values()];
  await late.runtime.close();
  entry.run(); // a timer that had already fired when the connector closed
  await delay(5);
  assert.equal(pendingTimer.pending.size, 0, "it is refused and never re-arms");
});

test("drift: the connector refuses a drifted schedule or lunch answer, caches nothing and keeps the session", async () => {
  const f = fixture();
  await login(f.runtime);
  const cases = [
    [
      "get_schedule",
      /\/lessons\/week\//,
      (k: (typeof DRIFT_KINDS)[number]) => driftedList(rawLessonsWeek(), DRIFT_FIELDS.lessons, k),
    ],
    [
      "get_lunch_menu",
      /\/lunchmenu\//,
      (k: (typeof DRIFT_KINDS)[number]) => driftedList(rawLunch(), DRIFT_FIELDS.lunch, k),
    ],
  ] as const;
  for (const [name, pattern, drifted] of cases) {
    for (const [index, kind] of DRIFT_KINDS.entries()) {
      const week = 2 + index; // one cache key per round
      f.override((url) => (pattern.test(url) ? drifted(kind) : undefined));
      await assert.rejects(
        f.runtime.execute(name, { week }, [100]),
        (e: unknown) => e instanceof ResponseDriftError && e.operation === name,
        `${name} ${kind}`,
      );
      f.override(null);
      const before = f.events.length;
      await f.runtime.execute(name, { week }, [100]);
      assert.ok(f.events.length > before, "the drifted answer was not cached");
    }
  }
  assert.notEqual(f.store.load(), null);
  await f.runtime.close();
});

test("drift: a drifted guardian profile fails the login and never reaches the connector's state", async () => {
  const f = fixture();
  f.override((url) => (url.endsWith("/eva/api/v1/parent") ? driftedParent("renamed") : undefined));
  const { url } = await f.runtime.beginLogin();
  const state = new URLSearchParams(url.split("?")[1]).get("state")!;
  assert.equal(f.runtime.callback(state, "CODE"), true);
  await assert.rejects(
    f.runtime.execute("list_children", {}, [100]),
    /Not logged in|changed shape/,
  );
  const status = await f.runtime.status();
  assert.equal(status.authenticated, false);
  assert.equal(status.loginError, "upstream");
  assert.equal(f.identity(), undefined, "no guardian identity was pinned from a drifted profile");
  await f.runtime.close();
});

test("network operations contain every read and never a mutation, even when writes are enabled", async () => {
  assert.equal(CONNECTOR_OPERATIONS.length, 22);
  assert.deepEqual(
    CONNECTOR_OPERATIONS,
    operations.filter((op) => op.annotations.readOnly).map((op) => op.name),
  );
  const f = fixture();
  f.runtimeOptions.config.allowWrites = true;
  for (const operation of operations.filter((candidate) => !candidate.annotations.readOnly))
    await assert.rejects(
      f.runtime.execute(operation.name, {}, [100]),
      /not available/,
      operation.name,
    );
  await assert.rejects(f.runtime.execute("unknown", {}, [100]), /not available/);
  await f.runtime.close();
});

test("network status is available before and during login and exposes only approved children", async () => {
  const f = fixture();
  assert.equal(
    ((await f.runtime.execute("auth_status", {}, [100])) as { authenticated: boolean })
      .authenticated,
    false,
  );
  const { url } = await f.runtime.beginLogin();
  assert.equal(
    ((await f.runtime.execute("auth_status", {}, [100])) as { loginInProgress: boolean })
      .loginInProgress,
    true,
  );
  const state = new URLSearchParams(url.split("?")[1]).get("state")!;
  f.runtime.callback(state, "CODE");
  await f.runtime.execute("list_children", {}, [100, 101]);
  const status = (await f.runtime.execute("auth_status", {}, [101])) as {
    children: unknown[];
    authenticated: boolean;
  };
  assert.equal(status.authenticated, true);
  assert.deepEqual(status.children, [{ id: 101, name: "Child 101" }]);
  await assert.rejects(f.runtime.execute("auth_status", { extra: true }, [100]), /arguments/);
  await assert.rejects(
    f.runtime.execute("auth_status", {}, [100], {
      check: () => {
        throw new Error("revoked");
      },
    }),
    /revoked/,
  );
  await assert.rejects(
    f.runtime.execute("auth_status", {}, [100], {
      check: (() => {
        let calls = 0;
        return () => {
          if (++calls > 1) throw new Error("revoked after status");
        };
      })(),
    }),
    /revoked after status/,
  );
  await f.runtime.close();
});

test("network school search uses the core operation without requiring a SchoolSoft login", async () => {
  const f = fixture();
  const configDir = mkdtempSync(join(tmpdir(), "connector-directory-"));
  f.runtimeOptions.config.configDir = configDir;
  writeFileSync(
    join(configDir, "schools.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      schools: [{ name: "Synthetic School", slug: "synthetic", orgId: 1 }],
    }),
  );
  try {
    const result = (await f.runtime.execute("find_school", { query: "Synthetic" }, [])) as {
      schools: unknown[];
    };
    assert.equal(result.schools.length, 1);
    assert.equal(f.store.load(), null);
    let checks = 0;
    await assert.rejects(
      f.runtime.execute("find_school", { query: "Synthetic" }, [], {
        check: () => {
          if (++checks > 1) throw new Error("revoked");
        },
      }),
      /revoked/,
    );
  } finally {
    rmSync(configDir, { recursive: true, force: true });
    await f.runtime.close();
  }
});

test("network news and full messages use the authorized child's school and recheck consent", async () => {
  const f = fixture();
  await login(f.runtime);
  f.override((url) =>
    url.endsWith("/messages/inbox")
      ? [
          {
            id: 5,
            subject: "Synthetic",
            message: "Preview",
            isRead: false,
            date: "2026-11-04T12:00:00+01:00",
            hasFiles: false,
          },
        ]
      : url.includes("/messages/")
        ? { id: 5, subject: "Synthetic", message: "Full body" }
        : url.includes("/news?")
          ? [{ title: "Synthetic news", description: "School update" }]
          : undefined,
  );
  assert.deepEqual(await f.runtime.execute("get_message", { child_id: 101, id: 5 }, [101]), {
    message: { id: 5, subject: "Synthetic", message: "Full body" },
  });
  const inbox = (await f.runtime.execute(
    "get_messages",
    { child_id: 101, limit: 1, unread_only: true },
    [101],
  )) as { messages: { id: number }[] };
  assert.equal(inbox.messages[0].id, 5);
  const news = (await f.runtime.execute("get_news", { child_id: 101 }, [101])) as {
    news: unknown[];
  };
  assert.equal(news.news.length, 1);
  await assert.rejects(
    f.runtime.execute("get_message", { child_id: 100, id: 5 }, [101]),
    /not permitted/,
  );
  await f.runtime.close();
});

test("all browser network reads use the focused child's cookies, respect web login and close browsers", async () => {
  const f = fixture();
  await login(f.runtime);
  const visited: string[] = [];
  const cookies: { name: string; value: string }[][] = [];
  let closed = 0;
  let onNavigate = () => {};
  const extracted: Record<string, unknown> = {
    extractContacts: [{ title: "Class", people: [] }],
    extractBookings: [{ title: "Meeting", slots: [] }],
    extractFiles: [{ name: "Newsletter", url: "https://school.example/file", type: "file" }],
    extractTablePage: { title: "Synthetic", sections: [] },
    extractSubjectLinks: [{ subject: "Matematik", subjectId: 1 }],
  };
  f.runtimeOptions.deps!.playwrightLoader = async () =>
    ({
      chromium: {
        launch: async () => ({
          newContext: async () => {
            let current = "";
            return {
              addCookies: async (values: { name: string; value: string }[]) => {
                cookies.push(values);
              },
              newPage: async () => ({
                addInitScript: async () => {},
                route: async () => {},
                goto: async (url: string) => {
                  current = url;
                  visited.push(url);
                  onNavigate();
                  return null;
                },
                url: () => current,
                evaluate: async (fn: Function) => extracted[fn.name],
              }),
              close: async () => {},
            };
          },
          close: async () => {
            closed++;
          },
        }),
      },
    }) as unknown as PlaywrightLike;
  f.override((url) =>
    url.includes("/header/parent") ? { currentChildId: 101, currentOrgId: 20 } : undefined,
  );
  try {
    for (const name of ["get_contacts", "get_bookings", "get_files"]) {
      const result = (await f.runtime.execute(name, { child_id: 101 }, [101])) as {
        child: { studentId: number };
      };
      assert.equal(result.child.studentId, 101);
      assert.equal(cookies.at(-1)!.find((cookie) => cookie.name === "JSESSIONID")!.value, "101");
    }
    const gated = [
      "get_grades",
      "get_student_documents",
      "get_unreported_absence",
      "get_attendance_report",
      "get_assessment_criteria",
    ];
    const before = visited.length;
    for (const name of gated)
      await assert.rejects(
        f.runtime.execute(
          name,
          {
            child_id: 101,
            ...(name === "get_assessment_criteria" ? { subject: "Matematik" } : {}),
          },
          [101],
        ),
        /web login/i,
      );
    assert.equal(visited.length, before, "all gated reads refuse before any navigation");
    assert.equal(closed, visited.length);
    const saved = f.store.load()!;
    saved.web = {
      cookies: [{ name: "JSESSIONID", value: "web-only", domain: "sms.schoolsoft.se", path: "/" }],
      savedAt: Date.now(),
      landedOn: "https://sms.schoolsoft.se/taby/jsp/student/right_student_start.jsp",
    };
    f.store.save(saved);
    const restored = new ConnectorRuntime(f.runtimeOptions);
    try {
      for (const name of gated) {
        await restored.execute(
          name,
          {
            child_id: 101,
            ...(name === "get_assessment_criteria" ? { subject: "Matematik" } : {}),
          },
          [101],
        );
        assert.equal(
          cookies.at(-1)!.find((cookie) => cookie.name === "JSESSIONID")!.value,
          "web-only",
        );
      }
      let allowed = true;
      onNavigate = () => {
        allowed = false;
      };
      await assert.rejects(
        restored.execute("get_contacts", { child_id: 101, fresh: true }, [101], {
          check: () => {
            if (!allowed) throw new Error("revoked");
          },
        }),
        /revoked/,
      );
      assert.equal(closed, visited.length, "even a revoked read closes its browser");
    } finally {
      await restored.close();
    }
    await assert.rejects(
      f.runtime.execute("get_contacts", { child_id: 100 }, [101]),
      /not permitted/,
    );
  } finally {
    await f.runtime.close();
  }
});
