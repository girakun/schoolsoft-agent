/** Parent-owned session lifecycle and serialized, consent-scoped read operations. */
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  AgentError,
  InputError,
  MemoryPendingLoginStore,
  createSessionManager,
  createPortals,
  createKeepalive,
  runOperation,
  resolveProvider,
  getOperation,
  portalHealth,
  requestBudgetOf,
  type Config,
  type GuardianChild,
  type Operation,
  type PortalHealth,
  type KeepaliveDeps,
  type Portal,
  type SessionHistorySummary,
  type SessionStore,
  type SessionDeps,
  type BrowserAuthorization,
  type QrAuthorizationRequest,
} from "../core/index.js";
import { QrLoginSession } from "./qr-session.js";

export const CONNECTOR_OPERATIONS = [
  "list_children",
  "get_schedule",
  "get_calendar",
  "get_lunch_menu",
] as const;
export interface ConnectorRuntimeOptions {
  config: Config;
  store: SessionStore;
  identityStore: { read(): string | undefined; write(id: string): void };
  redirectUri: string;
  qrLogin?: boolean;
  deps?: SessionDeps;
  now?: () => number;
  loginTimeoutMs?: number;
  /** Timer, randomness and HTTP for the opt-in keepalive (tests). */
  keepaliveDeps?: Pick<KeepaliveDeps, "timer" | "random" | "hourOf" | "fetchImpl" | "log">;
}
export type LoginFailure = "expired" | "cancelled" | "different_guardian" | "upstream";
/**
 * Why the runtime refused a request that was well-formed: the child is outside the
 * grant or no longer on the account, the connector is busy or closing, or the child in
 * focus moved while the request waited. Still an input error with the same message (the
 * MCP surface is unchanged); the reason lets an adapter answer with a precise status
 * without parsing prose.
 */
export type RefusalReason = "child" | "unavailable" | "child_changed";
export class ConnectorRefusedError extends InputError {
  constructor(
    readonly reason: RefusalReason,
    detail: string,
  ) {
    super(detail);
  }
}
/** One read of `executeForChild`: an offered operation and its arguments without `child_id`. */
export interface ChildRead {
  name: string;
  args: Record<string, unknown>;
}
/** A read's value, or the failure `executeForChild` was told to keep in its place. */
export type ReadOutcome = { ok: true; value: unknown } | { ok: false; error: unknown };
export interface ExecutionAuthorization {
  check?: () => void;
  signal?: AbortSignal;
}
interface Pending {
  cancelled: boolean;
  state?: string;
  expires?: number;
  accept?: (code: string) => void;
  reject?: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  qr?: QrLoginSession;
}
function loginError(reason: string): AgentError {
  return new AgentError({
    kind: "not_authenticated",
    key: "not_authenticated",
    params: { reason },
    hint: "login",
  });
}

export class ConnectorRuntime {
  private readonly manager;
  private readonly now;
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: Pending;
  private closed = false;
  private outstanding = 0;
  private lastLoginError?: LoginFailure;
  private readonly keepalive;

  constructor(private readonly options: ConnectorRuntimeOptions) {
    this.now = options.now ?? Date.now;
    const browserAuthorization: BrowserAuthorization = ({ url, state }) =>
      this.authorize(url, state);
    if (options.qrLogin) browserAuthorization.qr = (request) => this.authorizeQr(request);
    this.manager = createSessionManager(options.config, {
      now: this.now,
      // One process tracks its own login (this.pending); no marker is written to the data disk.
      pending: new MemoryPendingLoginStore(),
      ...options.deps,
      store: options.store,
      redirectUri: options.redirectUri,
      browserAuthorization,
    });
    // Keepalive ticks wait their turn in the same queue as reads, and end with the connector.
    this.keepalive = createKeepalive(options.config, this.manager, {
      ...options.keepaliveDeps,
      now: this.now,
      wrap: (run) =>
        this.serialized(async () => {
          if (this.closed) throw new InputError("Connector is closed.");
          return run();
        }),
    });
  }

  /** Start the opt-in keepalive (no-op unless the deployment enabled it). */
  startKeepalive(): void {
    this.keepalive?.start();
  }

  private publishUrl?: (value: { url: string }) => void;
  private authorizeQr(request: QrAuthorizationRequest): Promise<string> {
    const pending = this.pending!;
    const result = this.authorize("/owner/schoolsoft/qr", request.state);
    pending.qr = new QrLoginSession(
      request,
      this.now,
      () =>
        this.pending === pending &&
        !pending.cancelled &&
        !!pending.accept &&
        this.now() < pending.expires!,
      (code) => {
        this.callback(request.state, code);
      },
      () => this.cancelLogin("upstream"),
    );
    return result;
  }
  qrImage(): string | undefined {
    return this.pending?.qr?.image();
  }
  cancelQrLogin(): void {
    if (this.pending?.qr) this.cancelLogin();
  }
  async qrStatus(): Promise<"pending" | "complete" | "failed"> {
    await this.pending?.qr?.poll();
    return this.pending ? "pending" : this.lastLoginError ? "failed" : "complete";
  }
  private authorize(url: string, state: string): Promise<string> {
    const pending = this.pending!;
    return new Promise((resolve, reject) => {
      pending.state = state;
      pending.expires = this.now() + (this.options.loginTimeoutMs ?? 300_000);
      pending.accept = resolve;
      pending.reject = reject;
      pending.timer = setTimeout(
        () => this.cancelLogin("expired"),
        this.options.loginTimeoutMs ?? 300_000,
      );
      this.publishUrl!({ url });
    });
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  beginLogin(): Promise<{ url: string }> {
    if (this.closed) return Promise.reject(new InputError("Connector is closed."));
    if (this.pending) return Promise.reject(new InputError("A login is already in progress."));
    const pending: Pending = { cancelled: false };
    this.pending = pending;
    this.lastLoginError = undefined;
    return new Promise((resolve, reject) => {
      this.publishUrl = resolve;
      void this.serialized(async () => {
        try {
          if (pending.cancelled) throw loginError("Login cancelled.");
          await this.manager.login();
          if (pending.cancelled) throw loginError("Login cancelled.");
          this.checkIdentity();
        } catch (error) {
          this.lastLoginError ??= "upstream";
          this.manager.logout();
          reject(error);
        } finally {
          clearTimeout(pending.timer);
          this.pending = undefined;
          this.publishUrl = undefined;
        }
      });
    });
  }

  callback(state: string, code: string): boolean {
    const pending = this.pending;
    if (!pending?.state || !pending.accept || pending.cancelled) return false;
    if (this.now() >= pending.expires!) {
      this.cancelLogin("expired");
      return false;
    }
    const received = Buffer.from(state);
    const expected = Buffer.from(pending.state);
    if (received.length !== expected.length || !timingSafeEqual(received, expected) || !code)
      return false;
    const accept = pending.accept;
    pending.accept = undefined;
    clearTimeout(pending.timer);
    accept(code);
    return true;
  }

  private cancelLogin(reason: "expired" | "cancelled" | "upstream" = "cancelled"): void {
    if (!this.pending || this.pending.cancelled) return;
    this.lastLoginError = reason;
    this.pending.cancelled = true;
    this.pending.reject?.(loginError("Login cancelled or expired. Start again."));
  }

  private checkIdentity(): void {
    const { config, identityStore } = this.options;
    const identity = `${config.provider}:${config.school}:${this.manager.guardian().userId}`;
    const pinned = identityStore.read();
    if (pinned !== undefined && pinned !== identity) {
      this.lastLoginError = "different_guardian";
      this.manager.logout();
      throw loginError("This connector belongs to a different guardian. Use its original account.");
    }
    if (pinned === undefined) identityStore.write(identity);
  }

  async status(): Promise<{
    authenticated: boolean;
    loginInProgress: boolean;
    children: { id: number; name: string }[];
    loginError?: LoginFailure;
    /** Whether a gated web-login session is stored (only reported while signed in). */
    webSession?: boolean;
    /** Observed SchoolSoft sign-in lifetimes: timestamps and counters only. */
    sessionHistory?: SessionHistorySummary | null;
    /** Whether the school portal is pushing back (the request budget's breaker), and until when. */
    portal: PortalHealth;
  }> {
    const portal = () => portalHealth(requestBudgetOf(this.manager).snapshot());
    if (this.pending)
      return { authenticated: false, loginInProgress: true, children: [], portal: portal() };
    return this.serialized(async () => {
      if (this.closed)
        return {
          authenticated: false,
          loginInProgress: false,
          children: [],
          portal: portal(),
          ...(this.lastLoginError ? { loginError: this.lastLoginError } : {}),
        };
      try {
        await this.manager.ensureSession();
        this.checkIdentity();
        return {
          authenticated: true,
          loginInProgress: false,
          webSession: this.manager.getWebSession() !== null,
          sessionHistory: this.manager.sessionHistory(),
          portal: portal(),
          children: this.manager
            .guardian()
            .children.map((c) => ({ id: c.studentId, name: c.firstName })),
        };
      } catch {
        return {
          authenticated: false,
          loginInProgress: false,
          sessionHistory: this.manager.sessionHistory(),
          portal: portal(),
          children: [],
          ...(this.lastLoginError ? { loginError: this.lastLoginError } : {}),
        };
      }
    });
  }

  execute(
    name: string,
    args: Record<string, unknown>,
    allowedChildIds: readonly number[],
    authorization: ExecutionAuthorization = {},
  ): Promise<unknown> {
    return this.admitted(authorization, async (check) => {
      const { operation, input } = this.parse(name, args);
      const requested = input.child_id as number | undefined;
      const { guardian, permitted } = await this.permitted(requested, allowedChildIds);
      if (name === "list_children") {
        check();
        return {
          // The domain Child's id and first name only: an AI app learns no more than it needs.
          children: permitted.map((child) => ({
            id: child.studentId,
            firstName: child.firstName,
          })),
          childInFocus: permitted.some((child) => child.studentId === guardian.childInFocus)
            ? guardian.childInFocus
            : null,
        };
      }
      const childId = requested ?? guardian.childInFocus;
      const reader = await this.focused(childId, permitted, allowedChildIds, check, authorization);
      return reader.read(operation, input);
    });
  }

  /**
   * Several reads for one child in one turn of the queue: one grant check, one session
   * restore, at most one child switch, and no other request between the reads, so a
   * UI that alternates children costs one switch per call rather than one per read.
   * Reads run in order, each under the same guards as `execute`. A read whose failure
   * `keep` accepts is reported in its place and the next one runs; any other failure
   * ends the call and nothing is released.
   */
  executeForChild(
    childId: number,
    reads: readonly ChildRead[],
    allowedChildIds: readonly number[],
    authorization: ExecutionAuthorization,
    keep: (error: unknown) => boolean,
  ): Promise<{ child: GuardianChild; results: ReadOutcome[] }> {
    return this.admitted(authorization, async () => {
      const parsed = reads.map((read) =>
        this.parse(read.name, { ...read.args, child_id: childId }),
      );
      const { permitted } = await this.permitted(childId, allowedChildIds);
      const check = this.checker(authorization);
      const reader = await this.focused(childId, permitted, allowedChildIds, check, authorization);
      const results: ReadOutcome[] = [];
      for (const { operation, input } of parsed) {
        try {
          results.push({ ok: true, value: await reader.read(operation, input) });
        } catch (error) {
          if (!keep(error)) throw error;
          results.push({ ok: false, error });
        }
      }
      reader.validateFocus();
      return {
        child: this.manager.guardian().children.find((child) => child.studentId === childId)!,
        results,
      };
    });
  }

  /** At most 16 requests wait or run; each runs alone in the queue, checked first. */
  private admitted<T>(
    authorization: ExecutionAuthorization,
    run: (check: () => void) => Promise<T>,
  ): Promise<T> {
    if (this.outstanding >= 16)
      return Promise.reject(
        new ConnectorRefusedError("unavailable", "Connector is busy. Try again shortly."),
      );
    this.outstanding++;
    const check = this.checker(authorization);
    return this.serialized(async () => {
      check();
      return run(check);
    }).finally(() => {
      this.outstanding--;
    });
  }

  private checker(authorization: ExecutionAuthorization): () => void {
    return () => {
      if (this.closed) throw new ConnectorRefusedError("unavailable", "Connector is closed.");
      if (authorization.signal?.aborted) throw new InputError("Request cancelled.");
      authorization.check?.();
    };
  }

  private parse(name: string, args: Record<string, unknown>) {
    if (!CONNECTOR_OPERATIONS.some((value) => value === name))
      throw new InputError("This operation is not available through the connector.");
    const operation = getOperation(name)!;
    const parsed = z.object(operation.input).strict().safeParse(args);
    if (!parsed.success) throw new InputError("Check the operation arguments.");
    return { operation, input: parsed.data };
  }

  /** The children this grant may read; a named child outside it is refused before restoring. */
  private async permitted(requested: number | undefined, allowedChildIds: readonly number[]) {
    if (requested !== undefined && !allowedChildIds.includes(requested))
      throw new ConnectorRefusedError("child", "This child was not permitted for this connection.");
    await this.manager.ensureSession();
    this.checkIdentity();
    const guardian = this.manager.guardian();
    const permitted = guardian.children.filter((child) =>
      allowedChildIds.includes(child.studentId),
    );
    if (!permitted.length)
      throw new ConnectorRefusedError(
        "child",
        "No permitted children. Reconnect and choose a child.",
      );
    return { guardian, permitted };
  }

  /**
   * Focus `childId` and return a reader for it: every read runs through `runOperation`
   * with consent and focus rechecked before each upstream request and cache hit, after
   * recovery, and on the result before it is released.
   */
  private async focused(
    childId: number,
    permitted: readonly GuardianChild[],
    allowedChildIds: readonly number[],
    check: () => void,
    authorization: ExecutionAuthorization,
  ) {
    if (!permitted.some((child) => child.studentId === childId))
      throw new ConnectorRefusedError("child", "This child was not permitted for this connection.");
    const validateChild = () => {
      check();
      this.checkIdentity();
      if (
        !allowedChildIds.includes(childId) ||
        !this.manager.guardian().children.some((child) => child.studentId === childId)
      )
        throw new ConnectorRefusedError(
          "child",
          "This child is no longer permitted or available. Reconnect and choose a child.",
        );
    };
    const validateFocus = () => {
      validateChild();
      if (this.manager.guardian().childInFocus !== childId)
        throw new ConnectorRefusedError("child_changed", "The child's session changed. Try again.");
    };
    validateChild();
    await this.manager.focusChild(childId);
    // A cache hit makes no HTTP request, so `beforeRead` is also the cache's guard:
    // consent and child focus are rechecked before any cached value is served.
    const portals = createPortals(this.manager, {
      fetchImpl: this.options.deps?.fetchImpl,
      // A request the caller abandoned while it waited in the budget's queue is never sent.
      signal: authorization.signal,
      browser: null,
      beforeRead: validateFocus,
      beforeRecovery: check,
      afterRecovery: async () => {
        validateChild();
        await this.manager.focusChild(childId);
        validateFocus();
      },
    });
    const guarded = (portal: Portal): Portal => ({
      ...portal,
      getScheduleWeek: async (week) => {
        validateFocus();
        return portal.getScheduleWeek(week);
      },
      getLunchWeek: async (orgId, week, year) => {
        validateFocus();
        return portal.getLunchWeek(orgId, week, year);
      },
    });
    const context = {
      config: this.options.config,
      manager: this.manager,
      provider: resolveProvider(this.options.config),
      portal: guarded(portals.portal),
      freshPortal: guarded(portals.freshPortal),
      log: () => {},
    };
    return {
      validateFocus,
      read: async (operation: Operation, input: Record<string, unknown>) => {
        const result = await runOperation(operation, context, { ...input, child_id: childId });
        validateFocus();
        return result;
      },
    };
  }

  logout(): Promise<void> {
    this.cancelLogin();
    return this.serialized(async () => {
      this.manager.logout();
    });
  }

  close(): Promise<void> {
    this.closed = true;
    this.keepalive?.stop();
    this.cancelLogin();
    return this.serialized(async () => {});
  }
}
