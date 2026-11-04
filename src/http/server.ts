/* oxlint-disable oxc/no-async-endpoint-handlers -- Express 5 forwards rejected promises; http-owner.test.ts verifies sanitized failures. */
/** HTTP transport and owner-only routes. School data is accessed only through the runtime. */
import { timingSafeEqual } from "node:crypto";
import { rateLimit, type Options as RateLimitOptions } from "express-rate-limit";
import express, { type Request, type Response, type NextFunction } from "express";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { AgentError, operations, type Lang, type PortalHealth } from "../core/index.js";
import type { ConnectorConfig } from "./config.js";
import type { ConnectorOAuthProvider } from "./oauth.js";
import { CONNECTOR_OPERATIONS, type ConnectorRuntime } from "./runtime.js";
import { OwnerSessions } from "./owner-session.js";
import { clientKey } from "./client-key.js";
import { escapeHtml as esc, page, form, hidden, signInHistory } from "./pages.js";
import { restApi } from "./rest.js";
import { API_BASE } from "./routes.js";
import { PACKAGE_VERSION } from "../shared/version.js";
import { PAGE_PATH } from "./reference/app.js";
import { referencePage } from "./reference/page.js";
import { qrPage, type QrPageRuntime } from "./qr-page.js";
export interface ServerOptions {
  config: ConnectorConfig;
  oauth: ConnectorOAuthProvider;
  runtime: Pick<
    ConnectorRuntime,
    "beginLogin" | "callback" | "status" | "execute" | "executeForChild" | "logout"
  > &
    QrPageRuntime;
  sessions?: OwnerSessions;
  /** Operator-facing notices; never receives request data. Default: stderr. */
  warn?: (message: string) => void;
  /** Language of REST problem details when the caller names neither sv nor en. */
  lang?: Lang;
  /** Clock for REST's Retry-After (tests). */
  now?: () => number;
}
function sameToken(received: unknown, expected: string): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  // The token length is public (fixed by its generator); only its content is secret.
  return a.length === b.length && timingSafeEqual(a, b);
}
export function createConnectorApp({
  config,
  oauth,
  runtime,
  sessions = new OwnerSessions(config.adminPassword),
  warn = (message) => void process.stderr.write(message + "\n"),
  lang = "en",
  now,
}: ServerOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.proxyHops);
  // With no trusted hop every caller is keyed by its socket address. A forwarding header
  // then means a proxy is in front that was not declared: all visitors share the proxy's
  // budget until SCHOOLSOFT_PROXY_HOPS says how many hops to trust. Say so once.
  let warnedForwarded = config.proxyHops !== 0;
  app.use((req, _res, next) => {
    if (!warnedForwarded && req.headers["x-forwarded-for"] !== undefined) {
      warnedForwarded = true;
      warn(
        "Connector notice: a request carried X-Forwarded-For but SCHOOLSOFT_PROXY_HOPS is 0, so it was ignored. If a reverse proxy or tunnel is in front of this service, set SCHOOLSOFT_PROXY_HOPS to the number of proxies you operate or trust; see the parent connector guide.",
      );
    }
    next();
  });
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      // Never a Referer to another site. Not "no-referrer": under it, browsers send
      // `Origin: null` on the owner pages' own form posts, which the Origin checks
      // below then refuse, so a real browser could not sign in to the dashboard.
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; form-action 'self' https://claude.ai https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
      "Strict-Transport-Security": "max-age=31536000",
    });
    next();
  });
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.use((req, res, next) => {
    if (req.headers.host !== new URL(config.publicUrl).host) {
      res.status(421).end();
      return;
    }
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(express.json({ limit: "64kb" }));
  app.get("/", (_req, res) => {
    res.redirect("/owner");
  });
  // The reference page: public and data-free; it reads through /api/v1 with its own grant.
  app.use(referencePage());
  // Every per-caller limit uses the same address normalisation (IPv6 by /64). The
  // library's forwarding-header check is replaced by the single notice above.
  const perCaller: Partial<RateLimitOptions> = {
    keyGenerator: (req) => clientKey(req.ip),
    validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  };
  const perMinute = (extra: Partial<RateLimitOptions> = {}) =>
    rateLimit({
      windowMs: 60_000,
      limit: 20,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      ...perCaller,
      ...extra,
    });
  // Flood guard for wrong passwords. A request carrying the owner's secret bypasses it,
  // so nobody who shares the owner's address can keep the owner out (see OwnerSessions).
  const ownerLoginLimit = perMinute({ skip: (req) => sessions.matches(req.body?.password) });
  // Reachable only with an owner session; separate so login floods cannot spend it.
  const upstreamLoginLimit = perMinute();
  app.get("/owner/login", (req, res) => {
    const request = typeof req.query.request === "string" ? req.query.request : "";
    res.send(
      page(
        "Open your connector",
        `<p>Use the administrator password from your hosting account. This password is separate from SchoolSoft.</p>${form("/owner/login", "", hidden("request", request) + '<label>Administrator password <input type="password" name="password" autocomplete="current-password" required></label>', "Continue")}`,
      ),
    );
  });
  app.post("/owner/login", ownerLoginLimit, (req, res) => {
    if (req.get("origin") !== config.publicUrl) {
      res.status(403).end();
      return;
    }
    const result = sessions.login(req.body?.password);
    if (!result) {
      res
        .status(401)
        .send(
          page(
            "Could not sign in",
            '<p>Check your administrator password. After repeated attempts, wait a minute and try again.</p><a href="/owner/login">Try again</a>',
          ),
        );
      return;
    }
    res.cookie("__Host-owner", result.token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 30 * 60_000,
    });
    res.redirect(
      typeof req.body.request === "string" && req.body.request
        ? "/owner/consent?request=" + encodeURIComponent(req.body.request)
        : "/owner",
    );
  });
  app.use("/owner", (req, res, next) => {
    const session = sessions.get(req.headers.cookie);
    if (!session) {
      res.redirect(
        "/owner/login" +
          (typeof req.query.request === "string"
            ? "?request=" + encodeURIComponent(req.query.request)
            : ""),
      );
      return;
    }
    res.locals.csrf = session.csrf;
    if (
      req.method === "POST" &&
      (req.get("origin") !== config.publicUrl || !sameToken(req.body?.csrf, session.csrf))
    ) {
      res.status(403).end();
      return;
    }
    next();
  });
  /** One line, only while the school portal is pushing back: nothing for the parent to fix, just wait. */
  const portalNotice = (portal: PortalHealth) =>
    portal.state === "ok"
      ? ""
      : `<p>SchoolSoft is pushing back (${esc(portal.state.replace("_", " "))}): the connector sends it nothing ${portal.retryAt ? `until ${esc(portal.retryAt)} (UTC)` : "until one request has tested whether it answers again"}. Signing in again does not help; try later.</p>`;
  app.get("/owner", async (req, res) => {
    const status = await runtime.status();
    const csrf = res.locals.csrf as string;
    const loginMessage = status.loginError
      ? {
          expired: "The sign-in link expired. Start BankID again.",
          cancelled: "Sign-in was cancelled. Start again when ready.",
          different_guardian:
            "This connector belongs to another guardian. Sign in with its original account.",
          upstream:
            "SchoolSoft sign-in could not finish. Check your hosting settings and try again.",
        }[status.loginError]
      : "";
    res.send(
      page(
        "Your SchoolSoft connector",
        `<p>1. Sign in to SchoolSoft. 2. Add your connector to your AI app. 3. Approve the children and tools it may use.</p><p>${esc(loginMessage)}</p><p>SchoolSoft: ${status.authenticated ? "connected" : status.loginInProgress ? "waiting for BankID" : "not connected"}</p>${portalNotice(status.portal)}${form("/owner/schoolsoft/login", csrf, "", "Sign in with BankID")}<p>You complete BankID yourself in SchoolSoft. Return here afterwards.</p><p>Your connector address: <code>${esc(config.publicUrl)}/mcp</code></p><p><a href="${PAGE_PATH}">Reference page</a>: one child's week, read through this connector's REST API with its own approval.</p><p>Your hosting provider can access data processed on this server. Your AI provider receives the results you permit. The project author has no account or access.</p><p>Address check: this visit appears to come from <code>${esc(String(req.ip))}</code>. If that is not your own public internet address, the proxy setting (SCHOOLSOFT_PROXY_HOPS) does not match your hosting setup; see the guide.</p><h2>Connected apps</h2>${oauth
          .listGrants()
          .map(
            (g) =>
              `<p>${esc(g.clientName)}: ${esc(g.scopes.join(", "))}. Children: ${esc(g.childIds.map((id) => status.children.find((c) => c.id === id)?.name ?? "Previously selected child").join(", "))}. Expires: ${esc(new Date(g.expiresAt).toISOString().slice(0, 10))}</p>${form("/owner/revoke", csrf, hidden("grant", g.id), "Disconnect this app")}`,
          )
          .join(
            "",
          )}${signInHistory(status.sessionHistory)}${form("/owner/signout", csrf, "", "Sign out of this dashboard")}<h2>Stop access</h2>${form("/owner/schoolsoft/logout", csrf, "<p>This disconnects every AI app and removes the saved SchoolSoft session.</p>", "Disconnect everything")}`,
      ),
    );
  });
  app.post("/owner/schoolsoft/login", upstreamLoginLimit, async (_req, res) => {
    const { url } = await runtime.beginLogin();
    if (config.loginMode === "qr") {
      res.redirect("/owner/schoolsoft/qr");
      return;
    }
    res.send(
      page(
        "Complete BankID",
        `<p><a href="${esc(url)}" rel="noreferrer">Open SchoolSoft and complete BankID</a></p><p>Do not share this sign-in link. After signing in, return to <a href="/owner">your connector</a>.</p>`,
      ),
    );
  });
  app.use("/owner/schoolsoft", qrPage(runtime));
  // Unauthenticated by design (the portal redirects the parent's browser here), so bound
  // state guessing per caller. Separate from ownerAuthLimit: returning from BankID must
  // not spend the owner's login budget, and the reverse.
  const callbackLimit = perMinute();
  app.get("/schoolsoft/callback", callbackLimit, (req, res) => {
    if (
      typeof req.query.state !== "string" ||
      typeof req.query.code !== "string" ||
      !runtime.callback(req.query.state, req.query.code)
    ) {
      res
        .status(400)
        .send(
          page("Sign-in link expired", "<p>Return to your connector and start sign-in again.</p>"),
        );
      return;
    }
    res.redirect("/owner");
  });
  app.get("/owner/consent", async (req, res) => {
    const id = typeof req.query.request === "string" ? req.query.request : "";
    const pending = oauth.pending(id);
    const status = await runtime.status();
    if (!status.authenticated) {
      res
        .status(409)
        .send(
          page(
            "Sign in to SchoolSoft first",
            '<p><a href="/owner">Open your connector</a>, sign in, then reconnect from your AI app.</p>',
          ),
        );
      return;
    }
    const children = status.children
      .map(
        (c) =>
          `<label><input type="checkbox" name="children" value="${c.id}">${esc(c.name)}</label><br>`,
      )
      .join("");
    const scopes = pending.scopes
      .map(
        (s) =>
          `<label><input type="checkbox" name="scopes" value="${esc(s)}" checked>${esc(s)}</label><br>`,
      )
      .join("");
    res.send(
      page(
        "Choose what this app may read",
        `<p>App name (provided by the app): ${esc(pending.clientName)}</p><p>Return address: ${esc(pending.redirectUri)}</p><p>Continue only if you started connecting this app yourself a moment ago. If the link to this page came from someone else, choose Cancel.</p><p>Select at least one child. ${pending.redirectUri === config.publicUrl + PAGE_PATH ? "The selected data will be shown in this browser on your connector's reference page; it is not sent to an AI provider." : "The selected data will be sent to your AI provider when you use these tools."}</p>${form("/owner/approve", res.locals.csrf, hidden("request", id) + children + scopes, "Allow selected access")}${form("/owner/deny", res.locals.csrf, hidden("request", id), "Cancel")}`,
      ),
    );
  });
  app.post("/owner/approve", async (req, res) => {
    const values = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : typeof v === "string"
          ? [v]
          : [];
    const children = values(req.body.children).map(Number);
    const status = await runtime.status();
    if (
      !status.authenticated ||
      !children.length ||
      children.some((id) => !status.children.some((c) => c.id === id))
    ) {
      res.status(400).end();
      return;
    }
    res.redirect(oauth.approve(String(req.body.request), values(req.body.scopes), children));
  });
  app.post("/owner/deny", (req, res) => {
    res.redirect(oauth.deny(String(req.body.request)));
  });
  app.post("/owner/revoke", (req, res) => {
    oauth.revokeGrant(String(req.body.grant));
    res.redirect("/owner");
  });
  app.post("/owner/signout", (req, res) => {
    sessions.logout(req.headers.cookie);
    res.clearCookie("__Host-owner", {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
    });
    res.redirect("/owner/login");
  });
  app.post("/owner/schoolsoft/logout", async (_req, res) => {
    oauth.revokeAll();
    await runtime.logout();
    sessions.clear();
    res.redirect("/owner/login");
  });
  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl: new URL(config.publicUrl),
      resourceServerUrl: new URL(config.publicUrl + "/mcp"),
      scopesSupported: [...CONNECTOR_OPERATIONS],
      authorizationOptions: { rateLimit: perCaller },
      tokenOptions: { rateLimit: perCaller },
      clientRegistrationOptions: { rateLimit: perCaller },
      revocationOptions: { rateLimit: perCaller },
    }),
  );
  app.all(
    "/mcp",
    requireBearerAuth({
      verifier: oauth,
      resourceMetadataUrl: config.publicUrl + "/.well-known/oauth-protected-resource/mcp",
    }),
    async (req, res) => {
      if (req.method !== "POST") {
        res.status(405).set("Allow", "POST").end();
        return;
      }
      if (req.get("origin") && req.get("origin") !== config.publicUrl) {
        res.status(403).end();
        return;
      }
      const cancellation = new AbortController();
      res.on("close", () => cancellation.abort());
      const auth = req.auth!;
      const grantId = String(auth.extra!.grantId);
      const server = new McpServer({ name: "schoolsoft-agent", version: PACKAGE_VERSION });
      for (const op of operations.filter((candidate) => auth.scopes.includes(candidate.name)))
        server.registerTool(
          "schoolsoft_" + op.name,
          {
            title: op.title,
            description: op.description,
            inputSchema: op.input,
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true,
            },
          },
          async (args) => {
            try {
              const grant = oauth.verifyGrant(grantId);
              const data = await runtime.execute(op.name, args, grant.childIds, {
                check: () => {
                  oauth.verifyGrant(grantId);
                },
                signal: cancellation.signal,
              });
              oauth.verifyGrant(grantId);
              return { content: [{ type: "text", text: JSON.stringify(data) }] };
            } catch {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "Access is unavailable. Ask the parent to open their connector dashboard, check the SchoolSoft login and reconnect this app if needed.",
                  },
                ],
              };
            }
          },
        );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );
  // Read-only REST for custom UIs: same tokens, scopes, grants and runtime as /mcp.
  app.use(API_BASE, restApi({ publicUrl: config.publicUrl, oauth, runtime, lang, perCaller, now }));
  app.use((_req, res) => {
    res.status(404).send(page("Page not found", '<p><a href="/owner">Open your connector</a></p>'));
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // The caller's mistake: an OAuth protocol error, a rejected input, or a body the
    // parsers refused (they attach a 4xx status). Anything else is a fault on this side.
    const status = (error as { status?: unknown } | null)?.status;
    const callerFault =
      error instanceof OAuthError ||
      (error instanceof AgentError && error.kind === "input") ||
      (typeof status === "number" && status >= 400 && status < 500);
    if (callerFault) {
      res
        .status(400)
        .send(
          page(
            "Could not complete this step",
            '<p>Return to your connector and try again. If sign-in has expired, reconnect your AI app.</p><a href="/owner">Open your connector</a>',
          ),
        );
      return;
    }
    // No detail leaves the process: the body is fixed and nothing is logged.
    res
      .status(500)
      .send(
        page(
          "The connector had a problem",
          '<p>Try again in a moment; if it keeps happening, restart the service in your hosting account.</p><a href="/owner">Open your connector</a>',
        ),
      );
  });
  return app;
}
