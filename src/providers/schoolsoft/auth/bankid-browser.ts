/**
 * BankID-friendly interactive strategy: OAuth2+PKCE in the user's own
 * browser (see browser-flow.ts for the callback-server mechanics), then
 * guardian profile lookup and token → session-cookie exchange.
 *
 * Verified live (Täby, 2026-09-06). Sequence after the browser hands us
 * the code:
 *   1. code → access+refresh token (our oauth.ts; tokens id decides the
 *      token's user_type — vApp for guardians).
 *   2. GET /eva/api/v1/parent (Bearer) → userId + children.
 *   3. GET /eva-apps/auth/login/parent with userId/orgId/childInFocus →
 *      JSESSIONID+hash cookies for the /rest-api/parent/* endpoints.
 */
import type { BrowserAuthorization } from "../../../core/provider/types.js";
import type { AuthStrategy, LoginInfo } from "../../../core/auth/strategy.js";
import type { PersistedSession } from "../../../core/session/store.js";
import type { SchoolsoftSession, SchoolsoftCredentials } from "../session.js";
import type { SessionTokens } from "../tokens.js";
import { runBrowserLogin } from "./browser-flow.js";
import { runQrLogin } from "./qr-flow.js";
import {
  DEFAULT_USER_TYPE,
  DEFAULT_CLIENT_ID_BY_USER_TYPE,
  type SchoolsoftUserType,
} from "../../../core/constants.js";
import { exchangeTokenForCookies, type ExchangeFetch } from "./session-exchange.js";
import { exchangeCode, refreshTokens, decodeJwtClaims, type TokenFetch } from "./oauth.js";
import { GuardianApi, type ApiFetch } from "../portal/api-portal.js";
import { childOf, orgIdOf, type GuardianContext } from "../../../core/portal/guardian.js";
import { AgentError, UpstreamError } from "../../../core/errors/index.js";

export interface BankIdBrowserOptions {
  orgid?: string;
  userType?: SchoolsoftUserType;
  clientId?: string;
  callbackPort?: number;
  /** The budgeted HTTP helper (net.ts) in production, a fake in tests. */
  fetchImpl: ExchangeFetch & TokenFetch & ApiFetch;
  openBrowser?: (url: string) => void;
  browserAuthorization?: BrowserAuthorization;
  redirectUri?: string;
  /** Told about every rotated token pair at once, so it can be persisted before anything else fails. */
  onRefresh?: () => void;
}

export class BankIdBrowserStrategy implements AuthStrategy<SchoolsoftSession> {
  readonly id = "bankid-browser";
  context?: GuardianContext;

  constructor(private readonly options: BankIdBrowserOptions) {}

  private get userType(): SchoolsoftUserType {
    return this.options.userType ?? DEFAULT_USER_TYPE;
  }
  private get clientId(): string {
    return this.options.clientId ?? DEFAULT_CLIENT_ID_BY_USER_TYPE[this.userType];
  }

  async login(session: SchoolsoftSession): Promise<LoginInfo> {
    const held = session.tokens;
    const qr = this.options.browserAuthorization?.qr;
    const result = qr
      ? await runQrLogin({
          school: held.school,
          userType: this.userType,
          clientId: this.clientId,
          fetchImpl: this.options.fetchImpl,
          authorize: qr,
        })
      : (
          await runBrowserLogin({
            school: held.school,
            orgid: this.options.orgid,
            userType: this.userType,
            clientId: this.clientId,
            port: this.options.callbackPort,
            openBrowser: this.options.openBrowser,
            browserAuthorization: this.options.browserAuthorization,
            redirectUri: this.options.redirectUri,
          })
        ).result;
    const tokens = await exchangeCode({
      school: held.school,
      clientId: this.clientId,
      code: result.code,
      verifier: result.verifier,
      fetchImpl: this.options.fetchImpl,
    });
    held.setAccessToken(
      tokens.accessToken,
      tokens.refreshToken ?? undefined,
      tokens.expiresAt ?? undefined,
    );
    // Diagnostic (stderr, non-identifying): SchoolSoft stamps the user
    // type into the token; a mismatch with what we asked for explains
    // every downstream "Vi kunde inte hitta användaren".
    const claims = decodeJwtClaims(tokens.accessToken);
    console.error(
      `schoolsoft token: requested userType=${this.userType} clientId=${this.clientId} → ` +
        `got user_type=${claims?.user_type} client_id=${claims?.client_id} ` +
        `login_method=${claims?.login_method} exp=${claims?.exp}`,
    );
    return this.establish(held, undefined);
  }

  async restore(session: SchoolsoftSession, saved: PersistedSession): Promise<void> {
    const tokens = session.tokens;
    const creds = saved.data as SchoolsoftCredentials;
    if (!creds.accessToken) {
      throw new AgentError({
        kind: "not_authenticated",
        key: "not_authenticated",
        params: { reason: "saved session has no access token" },
        hint: "login",
      });
    }
    tokens.setAccessToken(creds.accessToken, creds.refreshToken, creds.accessTokenExpiresAt);
    // Access tokens live ~15 min. Refresh up front when expired or when we
    // don't know (older sessions without a stored expiry).
    if (tokens.isAccessTokenExpired || creds.accessTokenExpiresAt == null) {
      await this.refresh(tokens);
    }
    try {
      await this.establish(tokens, saved.guardian?.childInFocus);
    } catch (e) {
      // Clock skew / early revocation: one refresh-and-retry before giving
      // up, since giving up costs the user a BankID round.
      if (!(e instanceof UpstreamError && e.sessionRejected) || !tokens.refreshToken) throw e;
      await this.refresh(tokens);
      await this.establish(tokens, saved.guardian?.childInFocus);
    }
  }

  /** Refresh and adopt the rotated pair; resolves with the new expiry (unix seconds), null when unknown. */
  private async refresh(tokens: SessionTokens): Promise<number | null> {
    if (!tokens.refreshToken) {
      throw new AgentError({
        kind: "not_authenticated",
        key: "not_authenticated",
        params: { reason: "access token expired and no refresh token saved" },
        hint: "login",
      });
    }
    const t = await refreshTokens({
      school: tokens.school,
      clientId: this.clientId,
      refreshToken: tokens.refreshToken,
      fetchImpl: this.options.fetchImpl,
    });
    tokens.setAccessToken(
      t.accessToken,
      t.refreshToken ?? tokens.refreshToken,
      t.expiresAt ?? undefined,
    );
    this.options.onRefresh?.();
    return t.expiresAt;
  }

  /** Keepalive: adopt the saved tokens and refresh them unless they outlive the lead time. */
  async renew(
    session: SchoolsoftSession,
    saved: PersistedSession,
    options: { now: number; leadMs: number },
  ): Promise<{ expiresAt: number | null }> {
    const tokens = session.tokens;
    const creds = saved.data as SchoolsoftCredentials;
    if (!creds.accessToken) {
      throw new AgentError({
        kind: "not_authenticated",
        key: "not_authenticated",
        params: { reason: "saved session has no access token" },
        hint: "login",
      });
    }
    tokens.setAccessToken(creds.accessToken, creds.refreshToken, creds.accessTokenExpiresAt);
    const savedExpiry =
      creds.accessTokenExpiresAt == null ? null : creds.accessTokenExpiresAt * 1000;
    if (savedExpiry !== null && savedExpiry - options.now > options.leadMs) {
      return { expiresAt: savedExpiry }; // another process refreshed it already
    }
    const expiresAt = await this.refresh(tokens);
    return { expiresAt: expiresAt === null ? null : expiresAt * 1000 };
  }

  async focusChild(session: SchoolsoftSession, studentId: number): Promise<void> {
    const tokens = session.tokens;
    if (!this.context)
      throw new AgentError({
        kind: "not_authenticated",
        key: "not_authenticated",
        params: { reason: "no guardian context yet" },
        hint: "login",
      });
    const child = childOf(this.context, studentId); // validates
    await this.exchange(tokens, this.context, child.studentId);
    this.context = { ...this.context, childInFocus: child.studentId };
  }

  private api(tokens: SessionTokens): GuardianApi {
    return new GuardianApi({
      school: tokens.school,
      accessToken: () => tokens.accessToken,
      cookieHeader: () => null,
      fetchImpl: this.options.fetchImpl,
    });
  }

  /** Look up the guardian profile, then bind cookies to a child. */
  private async establish(
    tokens: SessionTokens,
    preferredChild: number | undefined,
  ): Promise<LoginInfo> {
    const parent = await this.api(tokens).getParent();
    if (!parent.children?.length) {
      throw new AgentError({ kind: "upstream", key: "no_children" });
    }
    const childInFocus =
      parent.children.find((c) => c.studentId === preferredChild)?.studentId ??
      parent.children[0].studentId;
    const context: GuardianContext = {
      userId: parent.userId,
      parentName: `${parent.firstName} ${parent.lastName}`.trim(),
      children: parent.children,
      childInFocus,
    };
    await this.exchange(tokens, context, childInFocus);
    this.context = context;
    const child = childOf(context, childInFocus);
    return {
      name: context.parentName,
      schoolName: child.schools[0].name, // orgIdOf() above guarantees a school
      userType: this.userType,
      children: parent.children.map((c) => ({ studentId: c.studentId, firstName: c.firstName })),
    };
  }

  private async exchange(
    tokens: SessionTokens,
    context: GuardianContext,
    studentId: number,
  ): Promise<void> {
    const child = childOf(context, studentId);
    await exchangeTokenForCookies(tokens, {
      userType: this.userType,
      userId: context.userId,
      orgId: orgIdOf(child),
      childInFocus: child.studentId,
      fetchImpl: this.options.fetchImpl,
    });
  }
}
