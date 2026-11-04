/**
 * The provider seam: everything vendor-specific about a school portal is
 * behind this interface. Core owns the capability vocabulary (Portal), the
 * operations, the session lifecycle, the browser session guard and the
 * "BankID in the user's own browser" mechanics; a provider supplies the
 * concrete auth strategies, the API and browser portals, the pages it
 * reads and how to recognise its own login pages.
 */
import type { Config } from "../config.js";
import type { AuthStrategy } from "../auth/strategy.js";
import type { BrowserSession } from "../browser/session.js";
import type { WebCookie } from "../browser/web-login.js";
import type { ApiPortalPart, BrowserPortalPart } from "../portal/composite.js";
import type { PageFingerprint, PageMap } from "../portal/page-spec.js";
import type { Capability, PortalProvider } from "../portal/types.js";
import type { SchoolDirectoryPort } from "../school-directory.js";
import type { RequestBudget } from "../budget/budget.js";
import type { BudgetLimits } from "../budget/policy.js";

/** What core needs from a provider's live session object (credentials holder). */
export interface ProviderSession {
  readonly school: string;
  /** Is the session still accepted upstream? */
  verify(): Promise<boolean>;
  /** Cookie header for the browser session with the app credentials, null when none. */
  cookieHeader(): string | null;
}

/**
 * Browser authorization owned by the host. It must bind the response to the
 * supplied state, reject errors/replays and resolve only with a verified code.
 * The PKCE verifier stays inside the provider and is never exposed to the host.
 */
export interface QrAuthorizationRequest {
  state: string;
  qrSvg: string;
  /** Check a human-approved challenge; credentials and provider session ids stay private. */
  poll(): Promise<{ qrSvg?: string; code?: string }>;
}
export type BrowserAuthorization = ((request: {
  url: string;
  state: string;
}) => Promise<string>) & {
  /** An owner-controlled browser can display a QR challenge instead of following a redirect. */
  qr?: (request: QrAuthorizationRequest) => Promise<string>;
};

/**
 * What a provider's live session gets: the process's request budget, which
 * every request the session itself makes (e.g. checking it is still
 * accepted) goes through, and the injected HTTP for tests.
 */
export interface SessionContext {
  budget: RequestBudget;
  fetchImpl?: unknown;
}

/** Dependencies every provider's auth strategies accept. */
export interface AuthDeps {
  /** The process's request budget; every auth request goes through it. */
  budget: RequestBudget;
  /** Injected HTTP for the provider's auth calls (tests); still wrapped in the budget. */
  fetchImpl?: unknown;
  /** Opens a URL in the user's browser; tests inject a callback simulator. */
  openBrowser?: (url: string) => void;
  /** Remote hosts supply both this callback and their validated redirect URI. */
  browserAuthorization?: BrowserAuthorization;
  redirectUri?: string;
  /**
   * A strategy calls this right after it obtained rotated credentials and put
   * them on the session, before doing anything else that can fail, so the
   * session manager can persist them at once (a lost rotation is a lost login).
   */
  onRefresh?: () => void;
}

/** What a provider gets when building its API portal. */
export interface ApiPortalContext {
  /** The process's request budget; every API request goes through it. */
  budget: RequestBudget;
  /** The host request's cancellation: a request still queued in the budget is then never sent. */
  signal?: AbortSignal;
  /** Called before each API read; may throw when host consent is no longer valid. */
  beforeRead?: () => void;
  /** Cookies from the web login, as a header, null without a web session. */
  webCookieHeader: () => string | null;
  /** Which child the caller wants the WEB session on; null = leave it. */
  webChildTarget: () => { childId: number; orgId: number } | null;
  /** Injected HTTP for tests (still wrapped in the budget); the provider's default otherwise. */
  fetchImpl?: unknown;
}

export interface BrowserPortalContext {
  hasWebSession: () => boolean;
  /** Align the provider's web session with the requested child before a gated page. */
  syncWebChild: () => Promise<void>;
}

/** Vendor-specific half of the headed-browser web login (cookie capture). */
export interface WebLoginSpec {
  /** Origin the portal is served from (cookies are filtered to its host). */
  origin: string;
  /** Where to open the login for a tenant. */
  loginUrl(school: string): string;
  /** True when a URL on the tenant is a portal page rather than any login step. */
  isPortalUrl(url: string, school: string): boolean;
}

export interface SchoolProvider<S extends ProviderSession = ProviderSession> {
  readonly id: string;
  readonly displayName: string;
  /** Provider order per capability; a capability absent here is not offered by this provider. */
  readonly routing: Partial<Record<Capability, readonly PortalProvider[]>>;
  /** Capabilities that need the web-login session, whichever provider serves them. */
  readonly webSessionCapabilities: readonly Capability[];
  /** Pages the browser provider reads, for `browser verify` and fingerprints. */
  readonly pages: PageMap;
  readonly fingerprints: Partial<Record<string, PageFingerprint>>;
  readonly webLogin: WebLoginSpec;
  /**
   * The rate, burst and parallelism this provider's portal is treated to by
   * default (per process); configuration may override them within
   * BUDGET_BOUNDS. Conservative on purpose: nobody asked the vendor.
   */
  readonly requestBudget: BudgetLimits;

  createSession(school: string, ctx: SessionContext): S;
  /** Provider-owned persisted credentials (the `data` blob of a PersistedSession). */
  serializeSession(session: S): Record<string, unknown>;
  createAuthStrategies(config: Config, deps: AuthDeps): AuthStrategy<S>[];
  createApiPortal(
    session: S,
    ctx: ApiPortalContext,
  ): ApiPortalPart & {
    syncWebChild(): Promise<void>;
    /**
     * Keepalive: one harmless GET the portal itself makes, with the web-login
     * cookies. Never a write, never a child switch. Rejects with a web
     * SessionLostError when the web session is gone, WebLoginRequiredError
     * when there is none.
     */
    touchWebSession(): Promise<void>;
  };
  createBrowserPortal(browser: BrowserSession, ctx: BrowserPortalContext): BrowserPortalPart;
  /** The provider's public school list; its fetch goes through the budget like every other request. */
  createSchoolDirectory(cacheFile: string, budget: RequestBudget): SchoolDirectoryPort;
  /**
   * `doctor`: one HEAD of the portal's front page through the budget, for
   * connectivity. Resolves with the HTTP status; rejects when unreachable.
   */
  probeReachability(budget: RequestBudget, fetchImpl?: unknown): Promise<number>;
  /** Web cookies filtered for the browser session; default keeps the provider origin's cookies. */
  webCookies?(cookies: WebCookie[]): WebCookie[];
}
