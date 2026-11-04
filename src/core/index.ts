/**
 * Public surface of the core. Adapters (src/mcp, src/cli, future src/http)
 * import ONLY from this module — enforced by scripts/check-boundaries.ts.
 */
export type { QrAuthorizationRequest } from "./provider/types.js";
export {
  type Config,
  type ConfigSource,
  ENV,
  NotConfiguredError,
  ConfigValueError,
  parseQuietHours,
  type KeepaliveConfig,
  type KeepaliveMode,
  envSource,
  defaultConfigDir,
  resolveConfig,
  CONFIG_FORMAT,
  ACCOUNT_SETTINGS,
  accountSource,
  foldAccountSettings,
  type AccountSelection,
  type AccountSettings,
  type ConfigDocument,
} from "./config.js";
export { accountKey, accountKeyOf } from "./accounts.js";
export type { AccountsDocument } from "./accounts.js";
export {
  NewerFormatError,
  MalformedVersionError,
  VERSION_FIELD,
  currentVersion,
  describeVersion,
  loadVersioned,
  readVersioned,
  storedVersion,
  unchanged,
  writeVersioned,
} from "./versioned.js";
export type { Migration, VersionedFormat } from "./versioned.js";
export {
  type SessionDeps,
  createSessionManager,
  createPortal,
  createPortals,
  createKeepalive,
  createApiPortal,
  createBrowserSession,
  createRequestBudget,
  requestBudgetOf,
  probePortal,
  asBackground,
  type BudgetDeps,
  resolveProvider,
  getProvider,
  providerIds,
  type PortalDeps,
  type Portals,
  type KeepaliveDeps,
} from "./wiring.js";
export { runOperation } from "./operations/run.js";
export type {
  CalendarEvent,
  Child,
  ChildRef,
  Dish,
  Lesson,
  LunchDay,
  Message,
} from "./domain/schemas.js";
export {
  CalendarEventSchema,
  ChildSchema,
  LocalDateSchema,
  DateTimeSchema,
} from "./domain/schemas.js";
export { DOMAIN_TIMEZONE, isoWeekDate } from "./domain/time.js";
export { weekOf, weekOfDate, isoWeekOfDate, type WeekRange } from "./operations/_week.js";
export { stockholmToday } from "./operations/_calendar-range.js";
export { toChild } from "./operations/list-children.js";
export { PortalBudget, portalHealth } from "./budget/budget.js";
export type {
  RequestBudget,
  OutboundCall,
  OutboundAnswer,
  BudgetSnapshot,
  BudgetTimer,
  BreakerState,
  PortalHealth,
  PortalBudgetOptions,
} from "./budget/budget.js";
export { BUDGET_BOUNDS, DEFAULT_BREAKER_POLICY } from "./budget/policy.js";
export type { BudgetLimits, BreakerPolicy } from "./budget/policy.js";
export { parseRetryAfter } from "./budget/retry-after.js";
export {
  verifyOperations,
  verifyExitCode,
  isVerifiable,
  VERIFY_EXCLUSIONS,
} from "./operations/verify.js";
export type {
  VerifyOperationsOptions,
  VerifyReport,
  VerifyResult,
  VerifyStatus,
  VerifySkipReason,
  VerifyDrift,
} from "./operations/verify.js";
export {
  MemorySessionHistoryStore,
  FileSessionHistoryStore,
  SessionHistoryRecorder,
  summarizeHistory,
  emptyHistory,
  HISTORY_FORMAT,
  accountHistoryStore,
  MAX_HISTORY_EVENTS,
  MAX_HISTORY_LOSSES,
} from "./session/history.js";
export type {
  SessionEvent,
  SessionListener,
  HistoryDocument,
  SessionHistory,
  SessionHistoryStore,
  SessionHistorySummary,
  SessionLoss,
  SessionSpan,
} from "./session/history.js";
export { MemoryReadCache, DEFAULT_CACHE_ENTRIES } from "./cache/read-cache.js";
export type { ReadCache } from "./cache/read-cache.js";
export { DEFAULT_CACHE_TTL_MS } from "./cache/policy.js";
export type { CacheTtls } from "./cache/policy.js";
export { withReadCache, cacheKey, normalizeArgs } from "./portal/cached.js";
export type { CacheScope, ReadCacheOptions } from "./portal/cached.js";
export { withWebSessionObserver } from "./portal/observed.js";
export {
  KeepaliveScheduler,
  inQuietHours,
  MIN_DELAY_MS,
  MAX_BACKOFF_MS,
} from "./keepalive/scheduler.js";
export type {
  KeepaliveTask,
  KeepaliveTimer,
  KeepaliveOptions,
  QuietHours,
} from "./keepalive/scheduler.js";
export {
  AgentError,
  NetworkError,
  UpstreamError,
  InputError,
  PortalPushbackError,
  RequestCancelledError,
  EXIT_CODE_BY_KIND,
  describeError,
  describeIssues,
  detectLang,
  guardNetwork,
  isTransient,
  MESSAGES,
  HINTS,
} from "./errors/index.js";
export type {
  ErrorKind,
  ErrorDescription,
  Lang,
  Surface,
  MessageKey,
  HintKey,
} from "./errors/index.js";
export { withSessionRecovery, isRecoverable } from "./portal/recovering.js";
export { ChildNotFoundError, ChildHasNoSchoolError } from "./portal/guardian.js";
export { CHARACTER_LIMIT, SCHOOLSOFT_USER_TYPES, type SchoolsoftUserType } from "./constants.js";
export { DEFAULT_CALLBACK_PORT, awaitCallbackCode } from "./auth/callback-server.js";
export { defaultOpenInBrowser, openerCommand } from "./auth/open-browser.js";
export type {
  SchoolProvider,
  ProviderSession,
  AuthDeps,
  BrowserAuthorization,
  ApiPortalContext,
  BrowserPortalContext,
  WebLoginSpec,
} from "./provider/types.js";
export { SessionManager, NotAuthenticatedError, RENEW_LEAD_MS } from "./session/session-manager.js";
export type {
  DocumentRepository,
  PersistedSession,
  SessionDocument,
  SessionStore,
} from "./session/store.js";
export { MemorySessionStore, SESSION_FORMAT, accountSessionStore } from "./session/store.js";
export {
  MemoryPendingLoginStore,
  FilePendingLoginStore,
  PENDING_LOGIN_TTL_MS,
} from "./session/pending-login.js";
export type { PendingLogin, PendingLoginStore } from "./session/pending-login.js";
export { FileSessionStore } from "./session/file-store.js";
export {
  appendPrivateFile,
  createPrivateFile,
  ensurePrivateDir,
  syncDirectory,
  writePrivateFile,
} from "./private-files.js";
export type { AuthStrategy, LoginInfo } from "./auth/strategy.js";
export { childOf, orgIdOf } from "./portal/guardian.js";
export type { GuardianContext } from "./portal/guardian.js";
export {
  CAPABILITIES,
  WRITE_CAPABILITIES,
  BROWSER_INSTALL_HINT,
  BrowserRequiredError,
  CapabilityNotSupportedError,
  PortalGatedError,
  SessionLostError,
  WebLoginRequiredError,
} from "./portal/types.js";
export type {
  Portal,
  Capability,
  CapabilityRouting,
  PortalProvider,
  GuardianChild,
  GuardianParent,
  GuardianChildSchool,
  ContactGroup,
  ContactPerson,
  SubjectRoom,
  ActivityEntry,
  Booking,
  PortalFile,
  TablePage,
  TableSection,
  AbsenceNotice,
  AbsenceReceipt,
} from "./portal/types.js";
export { createCompositePortal, providerOf } from "./portal/composite.js";
export type { ApiPortalPart, BrowserPortalPart } from "./portal/composite.js";
export { rankSchools, normalize } from "./school-directory.js";
export type { SchoolEntry, RankedSchool, SchoolDirectoryPort } from "./school-directory.js";
export { operations, getOperation } from "./operations/registry.js";
export { defineOperation, READ_ONLY } from "./operations/types.js";
export type { Operation, OperationAnnotations, OperationContext } from "./operations/types.js";
export { isoWeek, FreshSchema } from "./operations/_shared.js";
export type { PageSpec, PageMap, PageFingerprint } from "./portal/page-spec.js";
export { verifyPages } from "./portal/verify.js";
export type { PageReport, PageStatus, VerifyOptions } from "./portal/verify.js";
export { inspectPage } from "./portal/inspect.js";
export type { PageInspection } from "./portal/inspect.js";
export { PlaywrightSession } from "./browser/playwright.js";
export type { PlaywrightLike, PlaywrightLoader } from "./browser/playwright.js";
export { browserStatus, installChromium } from "./browser/install.js";
export type { BrowserStatus, StatusProbes, Spawner } from "./browser/install.js";
export type {
  BrowserSession,
  PortalPage,
  BrowserEngine,
  WithPageOptions,
} from "./browser/session.js";
export { webLogin } from "./browser/web-login.js";
export type { WebSession, WebCookie, WebLoginOptions } from "./browser/web-login.js";
