/** Composition root for one parent-owned connector process. */
import {
  HISTORY_FORMAT,
  SESSION_FORMAT,
  accountHistoryStore,
  accountKeyOf,
  accountSessionStore,
  detectLang,
  resolveConfig,
  type HistoryDocument,
  type VersionedFormat,
  type KeepaliveDeps,
  type SessionDeps,
  type SessionDocument,
  type SessionHistoryStore,
  type SessionStore,
} from "../core/index.js";
import { connectorConfig, type ConnectorConfig } from "./config.js";
import { EncryptedRepository } from "./storage.js";
import { ConnectorOAuthProvider, OAUTH_STATE_FORMAT, type OAuthState } from "./oauth.js";
import { ConnectorRuntime, CONNECTOR_OPERATIONS } from "./runtime.js";
import { createConnectorApp } from "./server.js";
import { PAGE_PATH } from "./reference/app.js";
type ConnectorKeepaliveDeps = Pick<
  KeepaliveDeps,
  "timer" | "random" | "hourOf" | "fetchImpl" | "log"
>;
/** The pinned guardian (identity.enc). v0 stored the bare string; v1 wraps it so it can carry a version. */
export const IDENTITY_FORMAT: VersionedFormat = {
  migrations: [(pin: string) => ({ identity: pin })],
};
/**
 * One account's saved session and session history in the connector's
 * encrypted session.enc and history.enc, which hold one entry per account in
 * the same formats as the local files. A connector serves one account; the
 * others' entries are kept as they are. Reading fails closed, as before.
 */
export function connectorAccountState(
  config: Pick<ConnectorConfig, "stateDir" | "storageKey">,
  account: string,
): { store: SessionStore; history: SessionHistoryStore } {
  const session = new EncryptedRepository<SessionDocument>(
    config.stateDir,
    "session",
    config.storageKey,
    SESSION_FORMAT,
  );
  const history = new EncryptedRepository<HistoryDocument>(
    config.stateDir,
    "history",
    config.storageKey,
    HISTORY_FORMAT,
  );
  return {
    store: accountSessionStore(
      {
        read: () => session.read() ?? null,
        write: (doc) => session.write(doc),
        remove: () => session.clear(),
      },
      account,
    ),
    history: accountHistoryStore(
      { read: () => history.read() ?? null, write: (doc) => history.write(doc) },
      account,
    ),
  };
}

/**
 * The object graph without a listener, so callers choose where (and whether) to listen.
 * Nothing is started here: `startConnector` starts the keepalive.
 */
export function composeConnector(
  config: ConnectorConfig,
  deps?: SessionDeps,
  env: Record<string, string | undefined> = {},
  keepaliveDeps?: ConnectorKeepaliveDeps,
) {
  const identity = new EncryptedRepository<{ identity: string }>(
    config.stateDir,
    "identity",
    config.storageKey,
    IDENTITY_FORMAT,
  );
  const oauth = new ConnectorOAuthProvider({
    resourceUrl: config.publicUrl + "/mcp",
    scopes: [...CONNECTOR_OPERATIONS],
    // The connector's own reference page is an OAuth client like any other UI.
    ownCallbacks: [config.publicUrl + PAGE_PATH],
    allowLoopbackClients: config.allowLoopbackClients,
    repository: new EncryptedRepository<OAuthState>(
      config.stateDir,
      "oauth",
      config.storageKey,
      OAUTH_STATE_FORMAT,
    ),
  });
  const resolved = resolveConfig(
    [
      {
        school: config.school,
        stateDir: config.stateDir,
        configDir: config.stateDir,
        keepalive: env.SCHOOLSOFT_KEEPALIVE || undefined,
        keepaliveWebMinutes: env.SCHOOLSOFT_KEEPALIVE_WEB_MINUTES || undefined,
        keepaliveQuietHours: env.SCHOOLSOFT_KEEPALIVE_QUIET_HOURS || undefined,
        cache: env.SCHOOLSOFT_CACHE || undefined,
        requestsPerMinute: env.SCHOOLSOFT_REQUESTS_PER_MINUTE || undefined,
        requestBurst: env.SCHOOLSOFT_REQUEST_BURST || undefined,
        maxConcurrentRequests: env.SCHOOLSOFT_MAX_CONCURRENT_REQUESTS || undefined,
      },
    ],
    { home: config.stateDir, platform: "linux" },
  );
  const state = connectorAccountState(config, accountKeyOf(resolved));
  const runtime = new ConnectorRuntime({
    config: resolved,
    store: state.store,
    identityStore: {
      read: () => identity.read()?.identity,
      write: (pin) => identity.write({ identity: pin }),
    },
    deps: {
      history: state.history,
      ...deps,
    },
    keepaliveDeps,
    redirectUri: config.publicUrl + "/schoolsoft/callback",
  });
  // SCHOOLSOFT_LANG (or the locale) picks the REST fallback language; English otherwise.
  return {
    app: createConnectorApp({ config, oauth, runtime, lang: detectLang(env) }),
    runtime,
  };
}
export function startConnector(
  env: Record<string, string | undefined>,
  deps?: SessionDeps,
  keepaliveDeps?: ConnectorKeepaliveDeps,
) {
  const config = connectorConfig(env);
  const { app, runtime } = composeConnector(config, deps, env, keepaliveDeps);
  runtime.startKeepalive();
  const server = app.listen(config.port, "0.0.0.0");
  return { server, runtime };
}
