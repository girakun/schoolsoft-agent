/**
 * Playwright-backed BrowserSession. Playwright is an optional dependency and
 * is imported lazily on first use; when it is missing the caller gets
 * BrowserRequiredError with the install hint.
 *
 * Safety, enforced here rather than promised:
 *  - every non-GET request is aborted unless the caller allowed writes or
 *    the URL matches an explicit read-only allowlist;
 *  - a navigation that lands on the login page or SchoolSoft's "log in
 *    again" gate throws SessionLostError / PortalGatedError instead of
 *    being followed (loading Login.jsp invalidates the cookie session);
 *  - every navigation is one request of the process's RequestBudget: it
 *    waits for a token, fails fast while the portal is pushing back, and its
 *    answer's status feeds the breaker. The page's own sub-requests are the
 *    portal's page at work and are not counted separately.
 */
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { PortalGatedError, SessionLostError } from "../portal/types.js";
import type { BrowserEngine, BrowserSession, PortalPage, WithPageOptions } from "./session.js";
import type { WebCookie } from "./web-login.js";
import type { RequestBudget } from "../budget/budget.js";

import { loadPlaywright, type PlaywrightLike } from "./optional-playwright.js";

export type { PlaywrightLike } from "./optional-playwright.js";
export type PlaywrightLoader = () => Promise<PlaywrightLike>;

export const defaultLoader: PlaywrightLoader = loadPlaywright;

export interface PlaywrightSessionOptions {
  school: string;
  /** The process's request budget; every navigation goes through it. */
  budget: RequestBudget;
  /** Fresh cookie header on every page: the session may have been refreshed. */
  cookieHeader: () => string | null;
  /** Cookies from a real web login; when present they are used instead of cookieHeader. */
  webCookies?: () => WebCookie[] | null;
  engine?: BrowserEngine;
  loader?: PlaywrightLoader;
  origin?: string;
  /** Host authorization, checked before every navigation and extraction. */
  beforeRead?: () => void;
  signal?: AbortSignal;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export class PlaywrightSession implements BrowserSession {
  private browser: Browser | null = null;
  private readonly engine: BrowserEngine;
  private readonly loader: PlaywrightLoader;
  private readonly origin: string;

  constructor(private readonly o: PlaywrightSessionOptions) {
    this.engine = o.engine ?? { kind: "chromium", headless: true };
    this.loader = o.loader ?? defaultLoader;
    this.origin = o.origin ?? "https://sms.schoolsoft.se";
  }

  /** One browser per call (see withPage); kept on the instance only so close() can reach it. */
  private async getBrowser(): Promise<Browser> {
    const pw = await this.loader();
    this.browser =
      this.engine.kind === "cdp"
        ? await pw.chromium.connectOverCDP(this.engine.endpoint)
        : await pw.chromium.launch({ headless: this.engine.headless ?? true });
    return this.browser;
  }

  async withPage<T>(
    fn: (page: PortalPage) => Promise<T>,
    options: WithPageOptions = {},
  ): Promise<T> {
    const web = options.web ? (this.o.webCookies?.() ?? null) : null;
    const cookie = this.o.cookieHeader();
    if (options.web && !web?.length) throw new SessionLostError("(no web-login cookies)", true);
    if (!web?.length && !cookie) throw new SessionLostError("(no web session cookies)");
    const browser = await this.getBrowser();
    const context: BrowserContext = await browser.newContext({ locale: "sv-SE" });
    try {
      const origin = new URL(this.origin);
      const host = origin.hostname;
      // Cookies only make sense for an http(s) origin; fixtures load from file://.
      if (origin.protocol.startsWith("http")) {
        const specs = web?.length
          ? web.map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
              httpOnly: c.httpOnly,
              secure: c.secure,
            }))
          : (cookie as string) // guarded above: no web cookies means cookie is set
              .split(";")
              .map((s) => s.trim())
              .filter(Boolean)
              .map((s) => {
                const i = s.indexOf("=");
                return { name: s.slice(0, i), value: s.slice(i + 1), domain: host, path: "/" };
              });
        await context.addCookies(specs);
      }
      const page = await context.newPage();
      // Bundlers (tsx/esbuild keepNames) decorate serialised function sources
      // with `__name(fn, "name")`; give the page an identity helper so
      // extractors run unchanged in dev and in the built package.
      await page.addInitScript("globalThis.__name = globalThis.__name || ((f) => f);");
      await page.route("**/*", (route: Route) => {
        const req = route.request();
        if (READ_METHODS.has(req.method())) return route.continue();
        if (options.allowWrites) return route.continue();
        if (options.allowedNonGet?.some((re) => re.test(req.url()))) return route.continue();
        return route.abort("blockedbyclient");
      });
      return await fn(this.wrap(page, web));
    } finally {
      await context.close().catch(() => {});
      // One browser per call: a lingering Chromium would keep the CLI / MCP
      // process alive after the operation finished (and cost memory between
      // calls). Launch cost is paid once per operation, not per page.
      await this.close();
    }
  }

  private wrap(page: Page, web: WebCookie[] | null = null): PortalPage {
    const base = `${this.origin}/${this.o.school}`;
    return {
      goto: async (path: string) => {
        await this.o.budget.run(
          { signal: this.o.signal },
          () => {
            this.o.beforeRead?.();
            return page.goto(base + path, { waitUntil: "load", timeout: 30_000 });
          },
          (response) => ({
            status: response?.status() ?? 200,
            retryAfter: response?.headers()["retry-after"] ?? null,
          }),
        );
        const landed = page.url();
        if (/\/jsp\/Login\.jsp/.test(landed))
          throw new SessionLostError(path, Boolean(web?.length));
        if (/right_student_app_blocked\.jsp/.test(landed)) throw new PortalGatedError(path);
      },
      evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => {
        this.o.beforeRead?.();
        return page.evaluate(fn as never, arg as never) as Promise<T>;
      },
      url: () => page.url(),
      waitForJson: async <T>(urlPattern: RegExp, timeoutMs = 30_000) => {
        this.o.beforeRead?.();
        const res = await page.waitForResponse((r) => urlPattern.test(r.url()), {
          timeout: timeoutMs,
        });
        return (await res.json()) as T;
      },
    };
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await b.close().catch(() => {});
  }
}
