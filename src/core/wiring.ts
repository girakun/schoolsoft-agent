/**
 * Production wiring (composition root of core): turns a resolved Config
 * into the object graph the adapters use, through the configured school
 * portal provider. This is the one core module allowed to import
 * src/providers; everything external is a dependency with a default here
 * and an injection point for tests.
 *
 * It also installs the request budget: one per session manager (so one per
 * process in every host), handed to the provider's session, auth
 * strategies, API portal, browser session and school directory, which wrap
 * every request in it. Keepalive runs as background work, which the budget
 * never lets wait in line or test the water.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Config } from "./config.js";
import { accountKeyOf } from "./accounts.js";
import { RENEW_LEAD_MS, SessionManager } from "./session/session-manager.js";
import { FileSessionStore } from "./session/file-store.js";
import type { SessionStore } from "./session/store.js";
import { createCompositePortal, type BrowserPortalPart } from "./portal/composite.js";
import { withSessionRecovery } from "./portal/recovering.js";
import { SessionLostError, type Portal } from "./portal/types.js";
import { childOf, orgIdOf } from "./portal/guardian.js";
import type { BrowserEngine } from "./browser/session.js";
import { PlaywrightSession, type PlaywrightLoader } from "./browser/playwright.js";
import { webLogin, type WebSession } from "./browser/web-login.js";
import { defaultOpenInBrowser } from "./auth/open-browser.js";
import { FilePendingLoginStore, type PendingLoginStore } from "./session/pending-login.js";
import type { ApiPortalContext, BrowserAuthorization, SchoolProvider } from "./provider/types.js";
import {
  FileSessionHistoryStore,
  SessionHistoryRecorder,
  type SessionHistoryStore,
} from "./session/history.js";
import { MemoryReadCache, type ReadCache } from "./cache/read-cache.js";
import { DEFAULT_CACHE_TTL_MS } from "./cache/policy.js";
import { withReadCache, type CacheScope } from "./portal/cached.js";
import { withWebSessionObserver } from "./portal/observed.js";
import {
  KeepaliveScheduler,
  type KeepaliveTask,
  type KeepaliveTimer,
} from "./keepalive/scheduler.js";
import { PortalBudget, type BudgetTimer, type RequestBudget } from "./budget/budget.js";
import { getProvider } from "../providers/index.js";

export { getProvider, providerIds } from "../providers/index.js";

/** The provider a Config selects (throws for an unknown id). */
export function resolveProvider(config: Pick<Config, "provider">): SchoolProvider {
  return getProvider(config.provider);
}

/** Real timers for the budget: a request waiting for a token must keep a one-shot CLI alive. */
const budgetTimer: BudgetTimer = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Set while keepalive work runs, so the budget treats its requests as background. */
const BACKGROUND = new AsyncLocalStorage<true>();

export interface BudgetDeps {
  now?: () => number;
  timer?: BudgetTimer;
}

/**
 * A request budget for a Config: the provider's limits with the config's
 * overrides. Hosts get one per session manager from createSessionManager;
 * this is for callers without a session (configure, doctor).
 */
export function createRequestBudget(
  config: Pick<Config, "provider" | "requestBudget">,
  deps: BudgetDeps = {},
): RequestBudget {
  const provider = resolveProvider(config);
  return new PortalBudget({
    limits: { ...provider.requestBudget, ...config.requestBudget },
    now: deps.now ?? Date.now,
    timer: deps.timer ?? budgetTimer,
    isBackground: () => BACKGROUND.getStore() === true,
  });
}

/** Run `work` as background work (keepalive): its requests never wait in line and never probe. */
export function asBackground<T>(work: () => Promise<T>): Promise<T> {
  return BACKGROUND.run(true, work);
}

/** The budget of each manager built here; everything built for that manager finds it again. */
const BUDGETS = new WeakMap<SessionManager, RequestBudget>();

/** The request budget every request made for this manager goes through (created with defaults if missing). */
export function requestBudgetOf(manager: SessionManager): RequestBudget {
  let budget = BUDGETS.get(manager);
  if (!budget) {
    budget = createRequestBudget({ provider: manager.providerId, requestBudget: {} });
    BUDGETS.set(manager, budget);
  }
  return budget;
}

/** `doctor`: one HEAD of the provider's portal through a budget; resolves with the HTTP status. */
export function probePortal(
  config: Pick<Config, "provider" | "requestBudget">,
  deps: { budget?: RequestBudget; fetchImpl?: unknown } = {},
): Promise<number> {
  return resolveProvider(config).probeReachability(
    deps.budget ?? createRequestBudget(config),
    deps.fetchImpl,
  );
}

export interface SessionDeps {
  store?: SessionStore;
  /** The process's request budget; default one built from the config (real clock and timers). */
  budget?: RequestBudget;
  /** Injected HTTP for the provider's auth calls (tests). */
  fetchImpl?: unknown;
  openBrowser?: (url: string) => void;
  /** Host-managed authorization callback, paired with redirectUri. */
  browserAuthorization?: BrowserAuthorization;
  redirectUri?: string;
  /** Override the interactive web login (tests); default opens a headed Playwright window. */
  webLogin?: (school: string) => Promise<WebSession>;
  playwrightLoader?: PlaywrightLoader;
  /** Where a login in progress is recorded; default a file in the state dir. */
  pending?: PendingLoginStore;
  pid?: number;
  /** Clock for the session manager, the history and the read cache. */
  now?: () => number;
  /** Where session lifetimes are recorded; default a file in the state dir. */
  history?: SessionHistoryStore;
  /** Read cache; default in-memory when config.cache is on. null disables it. */
  cache?: ReadCache | null;
}

/** The read cache of each manager built here; createPortals finds it again (one cache per session, not per portal). */
const CACHES = new WeakMap<SessionManager, ReadCache>();

/** Production wiring of a SessionManager for a resolved Config. */
export function createSessionManager(config: Config, deps: SessionDeps = {}): SessionManager {
  const provider = resolveProvider(config);
  let manager: SessionManager | null = null;
  const open = deps.openBrowser ?? defaultOpenInBrowser;
  const now = deps.now ?? Date.now;
  const cache =
    deps.cache === undefined ? (config.cache ? new MemoryReadCache(now) : null) : deps.cache;
  const budget = deps.budget ?? createRequestBudget(config);
  // The state files hold one entry per account; this manager reads and writes the current one's.
  const account = accountKeyOf(config);
  manager = new SessionManager({
    school: config.school,
    provider: provider.id,
    store: deps.store ?? new FileSessionStore(config.stateDir, account),
    pending: deps.pending ?? new FilePendingLoginStore(config.stateDir),
    pid: deps.pid,
    now,
    history: new SessionHistoryRecorder(
      deps.history ?? new FileSessionHistoryStore(config.stateDir, account),
      now,
    ),
    onEvent: (event) => {
      // Anything that changes who is reading, or for which child, empties the cache.
      if (event.type !== "refresh" && event.type !== "web_use" && event.type !== "web_login") {
        cache?.clear();
      }
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    createSession: (school) =>
      provider.createSession(school, { budget, fetchImpl: deps.fetchImpl }),
    serialize: (s) => provider.serializeSession(s),
    strategies: provider.createAuthStrategies(config, {
      budget,
      fetchImpl: deps.fetchImpl,
      browserAuthorization: deps.browserAuthorization,
      redirectUri: deps.redirectUri,
      onRefresh: () => manager?.noteRefresh(),
      // Record the URL for callers that did not wait (login --background), then open it.
      openBrowser: (url) => {
        manager?.noteLoginUrl(url);
        open(url);
      },
    }),
    webLogin:
      deps.webLogin ??
      ((school) =>
        webLogin({
          school,
          spec: provider.webLogin,
          engine:
            config.browser.kind === "cdp" ? config.browser : { kind: "chromium", headless: false },
          loader: deps.playwrightLoader,
          onOpen: (url) =>
            console.error(`Web login: complete BankID/SAML in the browser window (${url})`),
        })),
  });
  if (cache) CACHES.set(manager, cache);
  BUDGETS.set(manager, budget);
  return manager;
}

/** Portal bound to the manager's live session: API provider always; browser provider when supplied. */
export interface PortalDeps {
  /** Revalidate host authorization before each API read, including multi-request operations. */
  beforeRead?: () => void;
  /** Stop cancelled or revoked host requests before session recovery starts. */
  beforeRecovery?: () => void;
  /** Revalidate host authorization after session recovery, before any read is retried. */
  afterRecovery?: () => Promise<void>;
  /** Explicit browser provider; null disables the browser (tests, --no-browser). */
  browser?: BrowserPortalPart | null;
  browserUnavailableReason?: string;
  /** Engine for the default PlaywrightSession; defaults to config.browser. */
  engine?: BrowserEngine;
  playwrightLoader?: PlaywrightLoader;
  /** Injected HTTP for the API provider (tests); still wrapped in the manager's budget. */
  fetchImpl?: unknown;
  /** The host request's cancellation: requests still queued in the budget are then never sent. */
  signal?: AbortSignal;
}

/** The cached portal, and the same portal with the cache bypassed and refreshed (`fresh: true`). */
export interface Portals {
  portal: Portal;
  freshPortal: Portal;
}

/** The browser session bound to the manager's live cookies (app) and its web-login cookies (gated pages). */
export function createBrowserSession(
  manager: SessionManager,
  deps: Pick<PortalDeps, "engine" | "playwrightLoader" | "beforeRead" | "signal"> = {},
): PlaywrightSession {
  const provider = getProvider(manager.providerId);
  const session = manager.getSession();
  return new PlaywrightSession({
    school: session.school,
    budget: requestBudgetOf(manager),
    origin: provider.webLogin.origin,
    cookieHeader: () => session.cookieHeader(),
    webCookies: () => manager.getWebSession()?.cookies ?? null,
    engine: deps.engine,
    loader: deps.playwrightLoader,
    beforeRead: deps.beforeRead,
    signal: deps.signal,
  });
}

function apiContext(
  manager: SessionManager,
  deps: Pick<PortalDeps, "fetchImpl" | "beforeRead" | "signal">,
): ApiPortalContext {
  return {
    budget: requestBudgetOf(manager),
    fetchImpl: deps.fetchImpl,
    beforeRead: deps.beforeRead,
    signal: deps.signal,
    webCookieHeader: () => {
      const w = manager.getWebSession();
      return w ? w.cookies.map((c) => `${c.name}=${c.value}`).join("; ") : null;
    },
    webChildTarget: () => {
      try {
        const g = manager.guardian();
        return { childId: g.childInFocus, orgId: orgIdOf(childOf(g)) };
      } catch {
        return null;
      }
    },
  };
}

/** API provider bound to the manager's live session, app cookies and web-login cookies. */
export function createApiPortal(
  manager: SessionManager,
  deps: Pick<PortalDeps, "fetchImpl" | "beforeRead" | "signal"> = {},
) {
  return getProvider(manager.providerId).createApiPortal(
    manager.getSession(),
    apiContext(manager, deps),
  );
}

export function createPortal(manager: SessionManager, deps: PortalDeps = {}): Portal {
  return createPortals(manager, deps).portal;
}

function cacheScope(manager: SessionManager): CacheScope | null {
  try {
    const g = manager.guardian();
    const { school } = manager.getSession();
    return { provider: manager.providerId, school, userId: g.userId, childId: g.childInFocus };
  } catch {
    return null; // no session yet: nothing is cached, nothing is served
  }
}

export function createPortals(manager: SessionManager, deps: PortalDeps = {}): Portals {
  const provider = getProvider(manager.providerId);
  const api = createApiPortal(manager, deps);
  const browser =
    deps.browser === undefined
      ? provider.createBrowserPortal(createBrowserSession(manager, deps), {
          hasWebSession: () => manager.getWebSession() !== null,
          syncWebChild: () => api.syncWebChild(),
        })
      : deps.browser;
  const composite = createCompositePortal({
    routing: provider.routing,
    providerId: provider.id,
    api,
    browser,
    browserUnavailableReason: deps.browserUnavailableReason,
  });
  const observed = withWebSessionObserver(composite, {
    capabilities: provider.webSessionCapabilities,
    onUse: () => manager.noteWebUse("read"),
    onLost: () => manager.noteWebSessionLost(),
  });
  const recovering = withSessionRecovery(observed, {
    recover: async () => {
      deps.beforeRecovery?.();
      await manager.reauthenticate();
      await deps.afterRecovery?.();
    },
  });
  const cache = CACHES.get(manager);
  if (!cache) return { portal: recovering, freshPortal: recovering };
  const cached = (mode: "read" | "refresh") =>
    withReadCache(recovering, {
      cache,
      ttls: DEFAULT_CACHE_TTL_MS,
      never: provider.webSessionCapabilities,
      scope: () => cacheScope(manager),
      guard: deps.beforeRead,
      mode,
    });
  return { portal: cached("read"), freshPortal: cached("refresh") };
}

export interface KeepaliveDeps {
  timer?: KeepaliveTimer;
  now?: () => number;
  random?: () => number;
  hourOf?: (ms: number) => number;
  /** Injected HTTP for the web-session touch (tests). */
  fetchImpl?: unknown;
  /** Runs every tick; a host with its own request queue passes it here (HTTP connector). */
  wrap?: <T>(run: () => Promise<T>) => Promise<T>;
  log?: (message: string) => void;
}

/** Timers that never keep the process alive on their own. */
const unrefTimer: KeepaliveTimer = {
  set: (run, ms) => setTimeout(run, ms).unref(),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const FIRST_KEEPALIVE_DELAY_MS = 60_000;
export const APP_KEEPALIVE_INTERVAL_MS = 10 * 60_000;

/**
 * The opt-in keepalive for a long-lived process; null when the config leaves
 * it off. The caller starts and stops it. It renews and touches, and never
 * logs in: a task that meets a dead session stops until the user's next
 * login (app) or web login (web) starts it again.
 */
export function createKeepalive(
  config: Pick<Config, "keepalive">,
  manager: SessionManager,
  deps: KeepaliveDeps = {},
): KeepaliveScheduler | null {
  const { mode, webIntervalMs, quietHours } = config.keepalive;
  if (mode === "off") return null;
  const now = deps.now ?? Date.now;
  const budget = requestBudgetOf(manager);
  // Every tick is background work: the budget never lets it wait in line or test the water.
  const hostWrap = deps.wrap ?? (<T>(run: () => Promise<T>) => run());
  const wrap = <T>(run: () => Promise<T>) => asBackground(() => hostWrap(run));
  const tasks: KeepaliveTask[] = [
    {
      name: "app",
      intervalMs: APP_KEEPALIVE_INTERVAL_MS,
      firstDelayMs: FIRST_KEEPALIVE_DELAY_MS,
      run: () =>
        wrap(async () => {
          const { expiresAt } = await manager.renew(RENEW_LEAD_MS);
          return expiresAt === null ? null : expiresAt - now() - RENEW_LEAD_MS;
        }),
    },
  ];
  if (mode === "all") {
    const api = createApiPortal(manager, { fetchImpl: deps.fetchImpl });
    tasks.push({
      name: "web",
      intervalMs: webIntervalMs,
      firstDelayMs: FIRST_KEEPALIVE_DELAY_MS,
      run: () =>
        wrap(async () => {
          try {
            await api.touchWebSession();
          } catch (e) {
            if (e instanceof SessionLostError && e.web) manager.noteWebSessionLost();
            throw e;
          }
          manager.noteWebUse("keepalive");
          return null;
        }),
    });
  }
  const scheduler = new KeepaliveScheduler({
    tasks,
    timer: deps.timer ?? unrefTimer,
    now,
    random: deps.random ?? Math.random,
    quietHours,
    hourOf: deps.hourOf,
    log: deps.log,
    pausedUntil: () => {
      const s = budget.snapshot();
      return s.breaker === "closed" && s.retryAt === null ? null : (s.retryAt ?? now());
    },
  });
  manager.subscribe((event) => {
    if (event.type === "login") scheduler.resume("app");
    if (event.type === "web_login") scheduler.resume("web");
    if (event.type === "logout") scheduler.stop();
  });
  return scheduler;
}
