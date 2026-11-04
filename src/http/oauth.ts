/** Single-owner OAuth grants; storage is supplied by the encrypted deployment store. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import { unchanged, type VersionedFormat } from "../core/index.js";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  TemporarilyUnavailableError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { clientKey } from "./client-key.js";

export interface ConnectorGrant {
  resourceUrl: string;
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  childIds: number[];
  createdAt: number;
  expiresAt: number;
}
export interface PendingConsent {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  redirectUri: string;
  state?: string;
  challenge: string;
  expiresAt: number;
  /**
   * Who asked, for sharing the pending cap fairly: a pseudonym of the caller's network
   * (`requesterPseudonym`), never the address itself. Equal networks give equal
   * pseudonyms within one process; its key is never stored, so nothing on disk leads back
   * to an address.
   */
  requester: string;
}
interface Code {
  clientId: string;
  grantId: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
  /** Set once exchanged. The entry stays until expiry so a second use is recognised. */
  used?: true;
}
interface Token {
  clientId: string;
  grantId: string;
  scopes: string[];
  expiresAt: number;
}
export interface OAuthState {
  clients: Record<string, OAuthClientInformationFull>;
  pending: Record<string, PendingConsent>;
  codes: Record<string, Code>;
  grants: Record<string, ConnectorGrant>;
  tokens: Record<string, Token>;
  refresh: Record<string, { key: string; counter: number; scopes: string[] }>;
}
/** The stored OAuthState's format (oauth.enc); a new shape is one more migration here. */
export const OAUTH_STATE_FORMAT: VersionedFormat = { migrations: [unchanged] };
export interface OAuthRepository {
  read(): OAuthState | undefined;
  write(state: OAuthState): void;
}
interface Options {
  resourceUrl: string;
  scopes: string[];
  repository: OAuthRepository;
  now?: () => number;
  randomToken?: () => string;
  /** Capacity overrides for tests; production uses LIMITS. */
  limits?: Partial<typeof LIMITS>;
  /**
   * Exact callback URLs on the connector's own origin (its reference page), accepted
   * next to the vendor allowlist. Compared as whole strings: no prefix, query or variant.
   */
  ownCallbacks?: readonly string[];
  /** Opt-in RFC 8252 loopback callbacks for desktop MCP clients. */
  allowLoopbackClients?: boolean;
}
/** Bounds on state that anonymous callers can create. */
const LIMITS = { clients: 256, pending: 128, pendingPerRequester: 8 };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const DAY = 86_400_000;
/** Registration time in seconds; registrations without one count as oldest. */
const issuedAt = (client: OAuthClientInformationFull) => client.client_id_issued_at ?? 0;
/** Marks a stored requester as a pseudonym; a value without it is a plain address from an older build. */
const PSEUDONYM = "h:";

/** Callback destinations are exact known vendor paths; never fetch client-supplied URLs. */
export function approvedRedirect(value: string, allowLoopbackClients = false): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (
    allowLoopbackClients &&
    url.protocol === "http:" &&
    ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
    url.port !== ""
  )
    return true;
  if (url.protocol !== "https:" || url.port) return false;
  return (
    (url.hostname === "claude.ai" && url.pathname === "/api/mcp/auth_callback") ||
    (url.hostname === "chatgpt.com" &&
      (url.pathname === "/connector_platform_oauth_redirect" ||
        /^\/connector\/oauth\/[a-zA-Z0-9_-]+$/.test(url.pathname)))
  );
}

export class ConnectorOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private state: OAuthState;
  private readonly now: () => number;
  private readonly random: () => string;
  private readonly limits: typeof LIMITS;
  /** Keys the requester pseudonyms; random per process and never written anywhere. */
  private readonly requesterKey = randomBytes(32);
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.limits = { ...LIMITS, ...options.limits };
    this.random = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.state = options.repository.read() ?? {
      clients: {},
      pending: {},
      codes: {},
      grants: {},
      tokens: {},
      refresh: {},
    };
    this.pseudonymizeRestored();
    this.clientsStore = {
      getClient: (id) =>
        Object.hasOwn(this.state.clients, id) ? structuredClone(this.state.clients[id]) : undefined,
      registerClient: (client) => {
        if (
          !client.redirect_uris.length ||
          !client.redirect_uris.every((uri) => this.callbackAllowed(uri))
        )
          throw new InvalidClientMetadataError("Unsupported callback URL");
        this.prune();
        for (const [id, existing] of Object.entries(this.state.clients)) {
          if (issuedAt(existing) * 1000 + DAY <= this.now() && !this.clientInUse(id))
            delete this.state.clients[id];
        }
        // Anonymous callers can register, so a full table makes room instead of refusing:
        // the oldest registration that holds neither a grant nor a pending consent goes.
        // Clients in use are never evicted; only when every slot is in use is the caller
        // turned away.
        if (Object.keys(this.state.clients).length >= this.limits.clients) {
          const idle = Object.values(this.state.clients)
            .filter((candidate) => !this.clientInUse(candidate.client_id))
            .sort((a, b) => issuedAt(a) - issuedAt(b))[0];
          if (!idle) throw new TemporarilyUnavailableError("Client registration limit reached");
          delete this.state.clients[idle.client_id];
        }
        const registered = {
          ...client,
          client_id: this.random(),
          client_id_issued_at: Math.floor(this.now() / 1000),
        };
        this.state.clients[registered.client_id] = registered;
        this.save();
        return structuredClone(registered);
      },
    };
  }
  /** The pseudonym of a caller's network (clientKey: IPv4, or IPv6 by its /64). */
  private requesterPseudonym(key: string): string {
    return PSEUDONYM + createHmac("sha256", this.requesterKey).update(key).digest("base64url");
  }
  /** Pending requests stored by an older build hold the plain address: replace it and rewrite the file at once. */
  private pseudonymizeRestored(): void {
    const plain = Object.values(this.state.pending).filter(
      (pending) => !pending.requester.startsWith(PSEUDONYM),
    );
    for (const pending of plain) pending.requester = this.requesterPseudonym(pending.requester);
    if (plain.length) this.save();
  }
  private callbackAllowed(uri: string): boolean {
    return (
      approvedRedirect(uri, this.options.allowLoopbackClients) ||
      (this.options.ownCallbacks ?? []).includes(uri)
    );
  }
  private clientInUse(id: string): boolean {
    return (
      Object.values(this.state.grants).some((grant) => grant.clientId === id) ||
      Object.values(this.state.pending).some((pending) => pending.clientId === id)
    );
  }
  /**
   * Consent requests are created before anyone has authenticated, so the table makes
   * room rather than refusing. Whoever holds the most requests loses their oldest one:
   * a flood displaces itself, and a parent's single request survives unless the flood
   * comes from more distinct networks than the table has slots.
   */
  private admitPending(requester: string): void {
    const all = Object.values(this.state.pending);
    const own = all.filter((pending) => pending.requester === requester);
    let evict: PendingConsent | undefined;
    if (own.length >= this.limits.pendingPerRequester) evict = own[0];
    else if (all.length >= this.limits.pending) {
      const held = new Map<string, PendingConsent[]>();
      for (const pending of all)
        held.set(pending.requester, [...(held.get(pending.requester) ?? []), pending]);
      evict = [...held.values()].sort((a, b) => b.length - a.length)[0][0];
    }
    if (evict) delete this.state.pending[evict.id];
  }
  private save(): void {
    this.options.repository.write(structuredClone(this.state));
  }
  private prune(): void {
    for (const [id, pending] of Object.entries(this.state.pending))
      if (pending.expiresAt <= this.now()) delete this.state.pending[id];
    for (const [id, code] of Object.entries(this.state.codes))
      if (code.expiresAt <= this.now()) delete this.state.codes[id];
    for (const [id, token] of Object.entries(this.state.tokens))
      if (token.expiresAt <= this.now()) delete this.state.tokens[id];
    for (const [id, grant] of Object.entries(this.state.grants))
      if (grant.expiresAt <= this.now()) {
        delete this.state.grants[id];
        delete this.state.refresh[id];
      }
  }
  private resource(resource: URL | undefined): void {
    if (resource?.href !== this.options.resourceUrl)
      throw new InvalidTargetError("Invalid resource");
  }
  private scopes(scopes: string[], allowed = this.options.scopes): string[] {
    if (!scopes.length || scopes.some((scope) => !allowed.includes(scope)))
      throw new InvalidScopeError("Invalid scope");
    return [...new Set(scopes)];
  }
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.resource(params.resource);
    if (
      !client.redirect_uris.includes(params.redirectUri) ||
      !this.callbackAllowed(params.redirectUri) ||
      !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)
    )
      throw new InvalidRequestError("Invalid authorization request");
    this.prune();
    const scopes = this.scopes(params.scopes ?? this.options.scopes);
    // The address is used here and not kept: only its pseudonym is stored.
    const requester = this.requesterPseudonym(clientKey(res.req?.ip));
    this.admitPending(requester);
    const id = this.random();
    this.state.pending[id] = {
      id,
      clientId: client.client_id,
      clientName: client.client_name ?? "AI connector",
      scopes,
      redirectUri: params.redirectUri,
      state: params.state,
      challenge: params.codeChallenge,
      expiresAt: this.now() + 10 * 60_000,
      requester,
    };
    this.save();
    res.redirect(`/owner/consent?request=${encodeURIComponent(id)}`);
  }
  pending(id: string): PendingConsent {
    const request = Object.hasOwn(this.state.pending, id) ? this.state.pending[id] : undefined;
    if (!request || request.expiresAt <= this.now())
      throw new InvalidGrantError("Consent request expired");
    return structuredClone(request);
  }
  approve(id: string, scopes?: string[], childIds: number[] = []): string {
    const pending = this.pending(id);
    const selected = this.scopes(scopes ?? pending.scopes, pending.scopes);
    if (!childIds.length || childIds.some((child) => !Number.isSafeInteger(child) || child <= 0))
      throw new InvalidRequestError("Choose at least one child");
    this.prune();
    if (Object.keys(this.state.grants).length >= 64)
      throw new TemporarilyUnavailableError("Connection limit reached");
    const grantId = this.random();
    this.state.grants[grantId] = {
      resourceUrl: this.options.resourceUrl,
      id: grantId,
      clientId: pending.clientId,
      clientName: pending.clientName,
      scopes: selected,
      childIds: [...new Set(childIds)],
      createdAt: this.now(),
      expiresAt: this.now() + 30 * DAY,
    };
    const code = this.random();
    this.state.codes[hash(code)] = {
      clientId: pending.clientId,
      grantId,
      redirectUri: pending.redirectUri,
      challenge: pending.challenge,
      expiresAt: this.now() + 60_000,
    };
    delete this.state.pending[id];
    this.save();
    return this.redirect(pending, "code", code);
  }
  deny(id: string): string {
    const pending = this.pending(id);
    delete this.state.pending[id];
    this.save();
    return this.redirect(pending, "error", "access_denied");
  }
  private redirect(pending: PendingConsent, key: string, value: string): string {
    const url = new URL(pending.redirectUri);
    url.searchParams.set(key, value);
    if (pending.state !== undefined) url.searchParams.set("state", pending.state);
    return url.href;
  }
  private code(client: OAuthClientInformationFull, code: string): Code {
    const stored = this.state.codes[hash(code)];
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt <= this.now())
      throw new InvalidGrantError("Invalid authorization code");
    if (stored.used) {
      // Second presentation by the same client: the code leaked or was intercepted.
      // Withdraw everything issued from it (OAuth 2.0 Security BCP, RFC 9700 4.5).
      this.revokeGrant(stored.grantId);
      throw new InvalidGrantError("Authorization code reused; reconnect this client");
    }
    this.verifyGrant(stored.grantId);
    return stored;
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ): Promise<string> {
    return this.code(client, code).challenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.resource(resource);
    const stored = this.code(client, code);
    if (redirectUri !== stored.redirectUri) throw new InvalidGrantError("Invalid redirect URI");
    return this.issue(
      this.verifyGrant(stored.grantId),
      this.state.grants[stored.grantId].scopes,
      hash(code),
    );
  }
  // Authenticate every rotation counter so old-token replay remains detectable without
  // retaining a growing token history. The per-grant key stays in encrypted storage.
  private refreshMac(id: string, counter: string, key: string): string {
    return createHmac("sha256", key).update(`${id}.${counter}`).digest("base64url");
  }
  private readRefresh(value: string): { id: string; counter: number } | undefined {
    const parts = value.split(".");
    if (parts.length !== 3 || !/^(0|[1-9][0-9]*)$/.test(parts[1])) return undefined;
    const [id, counter, signature] = parts;
    const current = Object.hasOwn(this.state.refresh, id) ? this.state.refresh[id] : undefined;
    if (!current || !Number.isSafeInteger(Number(counter))) return undefined;
    const expected = Buffer.from(this.refreshMac(id, counter, current.key));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received))
      return undefined;
    return { id, counter: Number(counter) };
  }
  private issue(grant: ConnectorGrant, scopes: string[], codeHash?: string): OAuthTokens {
    this.prune();
    if (Object.keys(this.state.tokens).length >= 8192)
      throw new TemporarilyUnavailableError("Token limit reached");
    const next = structuredClone(this.state);
    const current = next.refresh[grant.id] ?? { key: this.random(), counter: 0, scopes };
    current.counter += 1;
    current.scopes = scopes;
    next.refresh[grant.id] = current;
    const access = this.random();
    const refresh = `${grant.id}.${current.counter}.${this.refreshMac(grant.id, String(current.counter), current.key)}`;
    next.tokens[hash(access)] = {
      clientId: grant.clientId,
      grantId: grant.id,
      scopes,
      expiresAt: this.now() + 5 * 60_000,
    };
    if (codeHash !== undefined) next.codes[codeHash].used = true;
    // Publish the next state only after persistence succeeds; failed issuance is retryable.
    this.options.repository.write(structuredClone(next));
    this.state = next;
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 300,
      scope: scopes.join(" "),
    };
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refresh: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.resource(resource);
    const parsed = this.readRefresh(refresh);
    if (!parsed) throw new InvalidGrantError("Invalid refresh token");
    const grant = this.verifyGrant(parsed.id);
    if (grant.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    const current = this.state.refresh[parsed.id];
    if (parsed.counter !== current.counter) {
      this.revokeGrant(parsed.id);
      throw new InvalidGrantError("Refresh token reused; reconnect this client");
    }
    const selected = this.scopes(scopes ?? current.scopes, current.scopes);
    return this.issue(grant, selected);
  }
  verifyGrant(id: string): ConnectorGrant {
    const grant = Object.hasOwn(this.state.grants, id) ? this.state.grants[id] : undefined;
    if (!grant || grant.expiresAt <= this.now() || grant.resourceUrl !== this.options.resourceUrl)
      throw new InvalidTokenError("Connection expired or revoked");
    return structuredClone(grant);
  }
  async verifyAccessToken(access: string): Promise<AuthInfo> {
    const token = this.state.tokens[hash(access)];
    if (!token || token.expiresAt <= this.now())
      throw new InvalidTokenError("Invalid access token");
    this.verifyGrant(token.grantId);
    return {
      token: access,
      clientId: token.clientId,
      scopes: [...token.scopes],
      expiresAt: Math.floor(token.expiresAt / 1000),
      resource: new URL(this.options.resourceUrl),
      extra: { grantId: token.grantId },
    };
  }
  listGrants(): ConnectorGrant[] {
    this.prune();
    return structuredClone(Object.values(this.state.grants));
  }
  revokeGrant(id: string): void {
    if (Object.hasOwn(this.state.grants, id)) {
      delete this.state.grants[id];
      delete this.state.refresh[id];
      for (const [key, token] of Object.entries(this.state.tokens))
        if (token.grantId === id) delete this.state.tokens[key];
      for (const [key, code] of Object.entries(this.state.codes))
        if (code.grantId === id) delete this.state.codes[key];
      this.save();
    }
  }
  revokeAll(): void {
    this.state.grants = {};
    this.state.refresh = {};
    this.state.tokens = {};
    this.state.pending = {};
    this.state.codes = {};
    this.save();
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const token = this.state.tokens[hash(request.token)];
    if (token && token.clientId === client.client_id) this.revokeGrant(token.grantId);
    const refresh = this.readRefresh(request.token);
    if (refresh && this.state.grants[refresh.id]?.clientId === client.client_id)
      this.revokeGrant(refresh.id);
  }
}
