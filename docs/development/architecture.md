# Architecture

This document goes from the big picture down to the mechanics. If you only read one section, read [The shape of it](#the-shape-of-it). Diagrams are pre-rendered SVGs; click one to open its Mermaid source under [diagrams/src](../diagrams/src) (`make diagrams` re-renders them; see [diagrams/](../diagrams/README.md)).

## The shape of it

One core, local MCP/CLI surfaces and a parent-hosted HTTP connector, many hosts. The core knows SchoolSoft; the surfaces know how agents talk; the hosts are somebody else's software.

[![System overview](../diagrams/dist/system-overview.svg)](../diagrams/src/system-overview.mmd)

One vendor-neutral core, multiple surfaces, many hosts. Everything SchoolSoft-specific sits behind the `SchoolProvider` seam in `src/providers/schoolsoft`; a second vendor is a new directory there. Three rules keep this honest, and a script enforces them (`make boundaries`):

1. `src/core` never imports from an adapter and never reads `process.env`. It receives a `Config` object.
2. Adapters (`src/mcp`, `src/cli`, `src/shared`) import core only through `src/core/index.ts`.
3. Adapters never import each other. Common adapter code lives in `src/shared`.

## One definition per capability

Every capability is an **operation**: a name, a description with "Use when:" guidance, a Zod input schema, safety annotations, and a `run` function that returns plain data.

[![One definition per capability](../diagrams/dist/operation-registry.svg)](../diagrams/src/operation-registry.mmd)

Adding an operation is one new file plus one line in the registry. The MCP tool, the CLI command and three reference documents appear without further work, and a boundary test refuses operations that lack annotations or a "Use when:" line.

## Login, step by step

SchoolSoft's guardian app uses OAuth 2 with PKCE. We use the same flow, with a local callback instead of the app's deep link. The one thing that took real effort to discover: SchoolSoft stamps the **user type** into the token from the OAuth **client id** (`vApp` = guardian app, `eApp` = student app), and resolves the actual user at request time. A guardian with a student-typed token fails every call with "Vi kunde inte hitta användaren".

[![Login, step by step](../diagrams/dist/login-flow.svg)](../diagrams/src/login-flow.mmd)

Two backends serve the data afterwards. The **Eva API** takes the Bearer token and serves profile, lunch, news and messages. The **webview REST** API takes the cookies, which are bound to one child (`childInFocus`), and serves schedule and assignments. Switching child means one more cookie exchange; the operations do that when `child_id` changes.

## Parent-hosted connector

`src/http/` implements a separate Streamable HTTP MCP adapter for a server operated
by one guardian. It imports core through `core/index.ts`; it does not wrap the local
MCP server or CLI. The initial allowlist contains `list_children`, `get_schedule`
and `get_lunch_menu`. Tool definitions come from the operation registry; the runtime
serializes each complete authorization, child-focus and read sequence.

A parent signs into the owner page using their deployment secret and starts
SchoolSoft login there. The provider accepts an injected browser-authorization
callback and an HTTPS redirect URI. PKCE material stays inside the provider; the
HTTP runtime validates one-use state and enforces a deadline. The browser completes
BankID itself. The ordinary local flow retains its localhost callback. **Acceptance
of the public callback by SchoolSoft remains a live-test requirement.**

The runtime pins provider, school and guardian identity. A different guardian is
rejected and the attempted session removed; logout preserves the identity pin.
Each AI app gets OAuth authorization for selected read operations and children.
Unknown or unapproved children are rejected before focusing or fetching, including
an unapproved default child. Listing children returns only the approved subset.
Owner login, CSRF protection, OAuth grants and encrypted persistent state belong to
the HTTP adapter. Per-caller limits key on the socket address unless the deployment declares its
proxy hops (`SCHOOLSOFT_PROXY_HOPS`, default 0), with IPv6 callers grouped by /64; the
correct owner password is never rate limited, so its randomness is the guess protection. The
pending-consent table shares its cap by caller in the same way, but `oauth.enc` stores only a
keyed pseudonym of the caller's network, whose key is random per process and never written, so
nothing on disk leads back to an address. Per-app revocation is separate from SchoolSoft logout.

The private-network deployment can opt into desktop OAuth callbacks with
`SCHOOLSOFT_ALLOW_LOOPBACK_CLIENTS=1`. Only HTTP loopback URLs with an explicit
port and no credentials, query or fragment are added to the callback allowlist;
the registered URI is still matched exactly during authorization and exchange.
This is separate from SchoolSoft's HTTPS callback to the connector. See the
[Traefik deployment](../deployment/traefik.md).

For direct BankID tenants that refuse external redirect URIs, the connector can
opt into `SCHOOLSOFT_LOGIN_MODE=qr`. Core's `BrowserAuthorization` has an optional
QR presentation port (initial SVG and a provider-owned progress check). The
SchoolSoft provider owns its BankID endpoints, registered app return URI, PKCE
and validation; the HTTP adapter owns the password-protected display, bounded
polling, expiry and cancellation. Only the human identifies in BankID. The normal
browser callback remains the default, and completed sessions use the same store
and refresh path. Pending challenges are memory-only.

**REST surface.** `/api/v1` is a third adapter inside the connector, for custom UIs
([reference](../reference/rest-api.md), [spec](../planning/specs/2026-09-26-rest-surface.md)).
`src/http/routes.ts` generates one GET route per connector operation from the
registry (`/children`, `/children/{childId}/<slug>`), with query parameters from
the operation's Zod input minus `child_id`; `rest.ts` mounts them behind the
connector's per-caller limiter and the SDK's bearer middleware with the same OAuth
provider, tokens and scopes as `/mcp`, and calls `ConnectorRuntime.execute`, so the
child from the path goes through the same grant check, serialized focus, cache,
`runOperation` validation, recovery and revocation checks. Responses are the
validated domain output; failures are `application/problem+json` (`problem.ts`)
with the core's localized message and a hint for the `http` surface. `401` is
always the app's token and `409` always the connector's SchoolSoft session, whose
owner dashboard URL the body carries. `GET /api/v1/session` reports sign-in state,
the granted children and routes without starting a login. The runtime marks its
refusals with a reason (`ConnectorRefusedError`) so the adapter can answer `403` or
`503` without parsing prose.

**Reference page.** `/reference/` is the smallest UI over that surface
([spec](../planning/specs/2026-09-26-reference-page.md)). It is one public, data-free
HTML document. Its logic (`src/http/reference/app.ts`) runs in the browser, never
in the connector. It is an ordinary OAuth client: it discovers the sign-in from
the API's `401` challenge, registers, and uses PKCE through the owner consent
page, with its callback `<publicUrl>/reference/` (the only same-origin callback
`ConnectorOAuthProvider` accepts, passed as `ownCallbacks`). Then it reads
`/api/v1/session` and the routes the session lists. The access token stays in
memory; the refresh token stays in `sessionStorage`. `page.ts` inlines the module
under a policy for that path alone: `script-src` and `style-src` by hash,
`connect-src 'self'`. The module is tsc's output in the built connector and
type-stripped `app.ts` when running from source, so it uses erasable syntax only
and imports nothing but types. It never uses the owner cookie.

**Composite overview.** `GET /api/v1/children/{childId}/overview` (`src/http/overview.ts`,
[spec](../planning/specs/2026-09-26-composite-overview.md)) answers a dashboard's first
paint: the week's `get_schedule` and `get_lunch_menu` outputs and the next school event
from `get_calendar`. It is not an operation and has no scope: each section needs its
operation's scope and is `not-granted` otherwise. `ConnectorRuntime.executeForChild` runs
the sections in one turn of the queue (one grant check, at most one child switch, no
interleaving from other requests) and in order, so after push-back the budget refuses the
rest unsent; a failure that concerns one read (drift, upstream, network, push-back, not
offered, a bug) stays in its section as the problem body, anything about the request as a
whole (token, child, SchoolSoft session, busy connector, input) fails it. Weeks are named
by `weekOf`/`weekOfDate` (`core/operations/_week.ts`): the ISO week-year in which the week
starts nearest today and its Monday and Sunday in Europe/Stockholm, the rule
`get_schedule` and `get_lunch_menu` share.

**OpenAPI and the typed client.** `src/http/openapi.ts` builds an OpenAPI 3.1 document
from the route table, the operations' input and output schemas, the overview, the
session schema (`api-schemas.ts`, which the router also validates its answer with) and
`PROBLEMS`, with `z.toJSONSchema`; `make docs` writes it to
`docs/reference/openapi.json` and the generated-docs test keeps it current, and a unit
test compares it with the paths the Express router actually serves
([spec](../planning/specs/2026-09-26-openapi-client.md)). The typed client
(`src/client/`, the package export `schoolsoft-agent/client`) is for apps, not for the
connector: `make boundaries` lets it import only `zod` and its own files, and nothing in
`src` imports it. Its generated half (`api.gen.ts`, also written by `make docs`) holds
the document's response schemas and TypeScript types emitted from them
(`scripts/json-schema-ts.ts`); at run time it turns each schema back into a Zod
validator (`z.fromJSONSchema`). It owns the token refresh with single-flight (refresh
tokens rotate and a reused one revokes the grant) and reports failures as
`ConnectorError` with the core's error kinds. The OAuth resource stays
`https://<connector>/mcp` for REST clients; an `/api/v1` alias would be a second
resource and token audience (RFC 9728), so it is documented rather than added.

The deployment is one process per private state volume. The storage key comes from
the parent's deployment environment; the project author operates no central service.
Hosting administrators may access plaintext during use, and requested results enter
the AI provider's conversation. See [parent setup and trust boundaries](../deployment/connector.md).

The connector is a release candidate with offline security, lifecycle and protocol
tests. HTTP modules are included in the 100% coverage gate. One scripted scenario
(`test/packaging/connector-smoke/flow.mjs`) walks the whole parent journey over HTTP
with the portal replaced at the injected fetch seam: the functional suite runs it
against the in-process composition, and `make connector-smoke` replays it inside the
Docker image with `--network none`. This does not establish
real SchoolSoft callback compatibility, BankID on the same phone, or acceptance by
actual Claude/ChatGPT accounts. Those checks remain explicit before calling the
parent deployment supported.

## Provider seam: one vendor today, room for the next

The capability vocabulary (Portal), the operations and everything generated from them, the session lifecycle, the browser session guard and the two "BankID in the user's own browser" mechanics (localhost callback server, headed-browser cookie capture) are vendor-neutral and live in core. Everything SchoolSoft-specific lives under `src/providers/schoolsoft/` behind the `SchoolProvider` interface (`src/core/provider/types.ts`): which capabilities it serves and how (`routing`), its auth strategies, its API and browser portals, the pages it reads and their fingerprints, and how to recognise its own login pages (`webLogin`). A provider owns its session object (credentials holder) and the persisted `data` blob; core never names a field of it.

The registry in `src/providers/index.ts` maps ids to providers; `config.provider` (env `SCHOOLSOFT_PROVIDER`) selects one and defaults to `schoolsoft`, so nothing changes for current users. `src/core/wiring.ts` is the only core module that may import providers (the boundary checker enforces it); providers import core modules directly, never `core/index.ts`, so there is no import cycle; adapters never see a provider. A capability a provider does not route fails with `CapabilityNotSupportedError` naming the provider.

`test/contract/provider.contract.test.ts` runs the same assertions against every registered provider with no network: routing refers to real capabilities, pages declare anchors, the session serialises to JSON, every strategy implements the whole contract, and the portals cover the routing. A new vendor passes it before it gets a PR. Deliberately deferred until a second vendor exists: renaming the `SCHOOLSOFT_*` env vars, the `schoolsoft_` tool prefix and the SchoolSoft-specific config keys (`userType`, `clientId`).

## Typed outputs and drift

Five operations (`list_children`, `get_schedule`, `get_calendar`, `get_lunch_menu`, `get_messages`) return a vendor-neutral domain model instead of the portal's JSON, specified in [typed domain model](../planning/specs/2026-09-26-typed-domain-model.md). The types (`Child`, `Lesson`, `CalendarEvent`, `LunchDay`, `Message`) are Zod schemas in `src/core/domain/`; dates are `YYYY-MM-DD` and times ISO-8601 with the offset Europe/Stockholm had at that instant. Each of these operations declares `output` next to `input`; `runOperation` validates the result for every surface and returns the parsed value, so undeclared keys never leave. MCP publishes the schema as the tool's `outputSchema`, and the generated references show an Output table.

The mapping lives in the provider: `src/providers/schoolsoft/portal/domain/` holds one module per upstream shape, a Zod schema of the raw answer plus a function to the domain type, called by the API backends. The `Portal` methods therefore return domain types, and the guardian profile reaches the session without fields core never uses. Because the cache decorator wraps the portal, it stores mapped, validated values; a drifted answer throws before it could be stored. An answer that does not map, or a result that fails its schema, is a `ResponseDriftError` (kind `upstream`, exit 7, not retryable) naming the operation, with field paths and issue codes but no values. It never clears a saved session. The other operations still return raw JSON until E4.5.

**Checking for drift on purpose.** Live tests cannot run in CI, so `doctor --verify` is the early warning ([spec](../planning/specs/2026-09-26-doctor-verify.md)). The engine is core's `verifyOperations` (`operations/verify.ts`): it selects every registry operation that declares `output`, only reads and needs a login, and runs each once through `runOperation` with `{}` plus `fresh: true` where declared, sequentially, through the normal portal chain (so it inherits recovery, the network guard and any transport request budget). An operation over a web-session capability is skipped without a saved web session, one over a browser-routed capability without the browser; `VERIFY_EXCLUSIONS` names operations that need an input the check cannot choose, and the registry test fails for a typed read that neither accepts `{}` nor is excluded. The report says `ok`, `drift` (the `ResponseDriftError` path and issue codes), `skipped` or `error` (kind and message key, never the rendered message) per operation and names children by position; successful results are discarded unread. `verifyExitCode` maps it to 7 on any drift, otherwise the first error's kind. The CLI (`src/cli/commands/verify.ts`, an option of `doctor`) is the only caller; it is deliberately not an MCP tool or a connector route, since it is maintenance a person runs on purpose and on the connector it would read beyond the operations a parent granted.

**Text views in the CLI.** The CLI prints JSON by default, byte for byte as the operation returned it. `--format text` renders a typed result for people ([CLI output for humans](../planning/specs/2026-09-26-cli-text-output.md)). The views live in the CLI adapter, never in core: `src/cli/text/renderers/` has one pure function per operation (result → lines), registered by operation name in `src/cli/text/registry.ts`, and a boundary test requires a view for every operation that declares `output`. Words come from one English/Swedish table (`labels.ts`) chosen by `detectLang`; times are formatted for Europe/Stockholm from the ISO values, never the machine's zone; width (`COLUMNS`, else the TTY's) and colour (TTY, no `NO_COLOR`) come from injected `CliDeps` (`isTTY`, `columns`). Truncation is grapheme-aware and portal text is stripped of control characters. Untyped operations and the other commands print pretty JSON with a one-line note on stderr; errors are the same two lines in every format.

**The guided first run.** `schoolsoft-agent setup`, and a bare `schoolsoft-agent` on an interactive terminal with no school configured, walk a parent through the school lookup, the settings, the BankID login, a check and this week's schedule ([spec](../planning/specs/2026-09-26-guided-first-run.md)). It lives in the CLI adapter (`src/cli/guide/`, registered by `src/cli/commands/setup.ts`) and adds no capability: it composes `configure`'s lookup and write, `runOperation` for `login` and `get_schedule`, `verifyOperations` and the schedule's text view. Its words are one English/Swedish table (`words.ts`); what a person reads goes to stderr, `setup` adds one JSON result on stdout. It asks only when stdin is a terminal and no answer flag (`--query`, `--no-login`, `--school`, `--org-id`) is given, so scripts and CI never wait on it.

Swedish portals all end their login in BankID; the two capture paths above cover an OAuth-style redirect (SchoolSoft) and a plain SAML/e-tjänst web login (everyone else), so a new provider chooses one and writes no browser code.

## Errors and recovery

Every condition a user can meet is an `AgentError` (`src/core/errors`): a **kind** (fixes the exit code and whether a retry can help), a **message key with parameters** (rendered in English or Swedish), and a **hint key** (rendered as a shell command for the CLI, a tool name for MCP, or what a custom UI should tell the parent for the connector's REST surface). Surfaces call `describeError` and print two lines, the problem and "Next: …"; MCP also returns `error.kind` and `retryable` as structured content. Anything that is not an `AgentError` is a bug and is rendered as one, with a report hint. Exit codes: 2 not authenticated, 3 not configured, 4 network, 5 not available, 6 input, 7 upstream, 1 bug.

Three mitigations remove the common dead ends:

- **Session loss mid-conversation.** `withSessionRecovery` wraps the portal: a 401/403 from the API or a redirect to the login page re-establishes the app session once (refresh + cookie exchange, no user interaction) and repeats the call; a second rejection names `login`. Web-session losses are not retried, because only the user can fix those.
- **Network failures.** `guardNetwork` wraps every HTTP call and turns DNS, TCP, TLS and timeout failures into a `NetworkError` (exit 4, retryable) instead of a raw `ENOTFOUND`.
- **Long logins in hosts that time out.** `login --background` (MCP: `background: true`) returns as soon as the login URL is known. The CLI hands the blocking login to a detached copy of itself so the callback server outlives the command; a pending-login marker in the state directory (`login-pending.enc`, sealed with `key.bin`, no credentials) carries the URL, the process id and the outcome, `auth-status` reports it as `loginInProgress`, and a second `login` refuses to open another window while one is running. Markers of dead processes or older than six minutes are ignored.

## Design principles

The layout is SOLID by construction, and the boundary tests make it stay that way:

| Principle             | Where it shows                                                                                                                                                                                                                                                 | What enforces it                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Single responsibility | one vendor per `src/providers/<id>/`; one backend class per JSON API under its `portal/api/`, `api-portal.ts` only composes; `config.ts` is a pure model, `wiring.ts` builds the object graph; extractors, page specs and the session guard are separate files | review; file headers state the one job                                             |
| Open/closed           | a capability is one operation file + one registry line; a page is one `pages.ts` entry; an auth method is one `AuthStrategy`; tools, commands, docs and skills are generated                                                                                   | drift tests on generated docs and skills                                           |
| Liskov                | fakes implement the same ports as production; `AuthStrategy` has no optional methods                                                                                                                                                                           | type checker (fakes are typed against the port)                                    |
| Interface segregation | each operation declares `portal: [...]` and receives `Pick<Portal, C>`; `ApiPortalPart` / `BrowserPortalPart` split the producer side                                                                                                                          | `test/boundary/registry.test.ts` compares declarations with source                 |
| Dependency inversion  | core sees ports only; store, fetch, request budget, browser, spawn, web login and clock are injected with defaults in `wiring.ts`                                                                                                                              | `make boundaries`, `test/boundary/imports.test.ts`, the 100% offline coverage gate |

## Portal adapter: API first, browser where no API exists

Not everything a guardian sees has a JSON endpoint. Contact lists, subject rooms, bookings and shared files exist only as legacy web pages. Operations therefore talk to a **Portal**, one method per capability, and a static table (`PROVIDERS` in `src/core/portal/types.ts`) says which provider serves each one: the JSON APIs wherever they exist, a headless browser only where they don't. The routing is deterministic and documented; the browser is never used for something the API serves.

[![Portal adapter: API first, browser where no API exists](../diagrams/dist/portal-adapter.svg)](../diagrams/src/portal-adapter.mmd)

The browser provider loads a page with the user's session cookies and runs a self-contained extractor inside it. Its session is read-only by construction: every non-GET request is aborted at the browser (an explicit allowlist exists for the rare read-only POST), and a navigation that lands on the login page or SchoolSoft's "log in again" gate throws a typed error instead of being followed. Playwright is an optional dependency, installed once with `schoolsoft-agent browser install`; the engine is bundled Chromium or, via `SCHOOLSOFT_BROWSER_ENGINE=cdp` and `SCHOOLSOFT_BROWSER_CDP`, any Chrome DevTools Protocol endpoint such as [Obscura](https://github.com/h4ckf0r0day/obscura). Write operations, when they come, use the same seam with writes explicitly allowed per call.

**Coupling to SchoolSoft's HTML is contained.** Every browser-read page is declared once in `src/core/portal/pages.ts` (path, whether it is gated, the anchor selectors a healthy page must contain, and how to obtain an example query when the page needs one). Extractors in `extractors.ts` are the only code that knows the DOM; they run inside the page and are exercised against synthetic fixtures in real Chromium. Two guards catch upstream changes: `schoolsoft-agent browser verify` (also the live suite `07-structure`) loads each page and reports `ok`, `drift`, `broken` or `skipped` per page, comparing anchors and a structural fingerprint (a hash of the page's tag/id/class skeleton, never text) against the values recorded by `make fingerprints` in `fingerprints.ts`. When SchoolSoft ships a redesign the repair is: run `browser verify`, fix the named extractor, refresh its fixture, re-record fingerprints. Everything with a JSON endpoint (including subject rooms, which the React "Ämne" view fetches from the webview REST) is not affected. Ids never cross the tool contract: assessment criteria are requested by subject name and resolved from the subject menu inside the same session.

**Two sessions.** The API session (OAuth tokens + the app cookie exchange) serves everything with a JSON endpoint. SchoolSoft's GDPR gate (grades, student documents, unreported absence, attendance report, assessment criteria, Avstämning) refuses that session outright, so `login --web` captures a second one: a headed browser opens the ordinary web login, the user completes BankID there, and the resulting cookies are stored encrypted next to the tokens. The browser provider carries the web cookies only for gated pages (the two sessions have separate "child in focus" state, so the app cookies stay in charge of contacts, bookings and files), aligns the web session's child with the requested one first (one header GET, and the same PUT the portal's child menu sends when they differ), and refuses gated capabilities without a web session (`WebLoginRequiredError`, before any navigation); the Avstämning REST call sends the same cookie header from the API provider. The web session is never refreshed automatically: it expires on inactivity and the resulting `SessionLostError` names `login --web`.

## Cold start, refresh and the one retry

Access tokens live 15 minutes. Every process start (an MCP server launching, a CLI command) goes through `ensureSession`:

[![Cold start, refresh and the one retry](../diagrams/dist/cold-start-refresh.svg)](../diagrams/src/cold-start-refresh.mmd)

The retry exists because the alternative is a BankID round for the user. Refreshing when the expiry is _unknown_ protects sessions written by older versions.

## Between logins: history, read cache, keepalive

Every forced BankID login is friction for a parent, and the real limits of SchoolSoft's sessions are unknown (refresh-token lifetime; the web session's idle and absolute timeouts). Three vendor-neutral mechanisms in core work on that, specified in [session longevity](../planning/specs/2026-09-21-session-longevity.md); what remains to be measured live is listed there.

**Session history** (`session/history.ts`). `SessionManager` reports lifecycle events (login, refresh, child switch, web login, web-session use, session loss, logout) to a `SessionHistoryRecorder` and to subscribers. The recorder keeps, per session, when it started, its last activity, the activity count and the longest gap it survived; a loss stores the age and idle time. `auth_status` (`sessionHistory`) and `doctor` summarise it. The record holds timestamps and counters only, is bounded (300 events, 50 losses), survives logout on purpose, and is written best effort: a read-only state directory never breaks a login. Web-session uses and losses are observed by a portal decorator (`portal/observed.ts`) over `SchoolProvider.webSessionCapabilities`; a loss is rethrown saying how long the login had been idle.

**Durable refresh.** A provider reports every credential rotation through `AuthDeps.onRefresh`, and the manager persists it at once, before the profile lookup and cookie exchange that can still fail. Transient failures (`isTransient`: network, HTTP 5xx, including a 5xx from the token endpoint) never clear the saved session and are never recorded as a loss. Restore and renewal run one at a time inside the manager, so two callers cannot spend the same refresh token.

**Read cache** (`cache/`, `portal/cached.ts`). `ReadCache` is a port with an in-memory default wired in `wiring.ts`, one per session manager. A Portal method does not name the child it reads, so the key is built from the scope at call time: provider, school, guardian, child in focus, capability, normalised arguments. TTLs per capability live in `cache/policy.ts` (lunch, subject rooms and contacts 6 h; files 1 h; schedule and calendar 30 min; news, assignments and the activity log 10 min); an absent capability is never cached, and web-session capabilities are refused in code whatever the table says. A result is stored only if scope and cache epoch are unchanged after the read, so a read that overlapped a child switch is returned but never kept. Session events empty the cache (login, logout, child switch, session loss). It is bounded (200 entries, LRU), copies values in and out, and is never persisted. Operations stay unaware: those that can be answered from the cache declare `fresh` in their input, and `runOperation` (the one way a surface runs an operation) swaps in the portal that bypasses and refreshes the cache. The decorator order is cache → session recovery → web-session observer → composite. On the connector, `beforeRead` is also the cache's guard: consent and child focus are rechecked before a cached value is served, not only before an HTTP GET.

**Keepalive** (`keepalive/scheduler.ts`, `createKeepalive` in wiring). Opt-in through `Config.keepalive` (`off` by default, `app`, `all`). Timer, clock and randomness are injected. The app task calls `SessionManager.renew`, which works from the store (adopting tokens another process rotated) and asks the strategy's `renew` to refresh only inside the lead time (3 minutes before expiry). The web task calls the provider's `touchWebSession()`: for SchoolSoft one GET of `/rest-api/parent/header/parent`, never the child PUT. Runs happen up to 10 % early, never late; transient failures double the pause up to 60 minutes; any other failure stops that task until a `login` or `web_login` event resumes it, so it cannot loop against a dead session and never leads to BankID. Quiet hours skip the request. Only long-lived hosts start it: the stdio MCP server (`src/mcp/keepalive.ts`) and the connector, whose ticks run through its serialised queue and stop with `close()`. The CLI never creates a scheduler. Known limit: two processes sharing a state directory can still race on one refresh token; the marker-file coordination from issue #8 is not built. SchoolSoft AB is not involved in this project and has not approved background requests, which is why this stays off unless the user turns it on.

## One request budget

This is an unofficial client of SchoolSoft's app API and web pages, and keepalive, the read cache, a connector serving several AI apps and the REST API all multiply what one parent sends. If SchoolSoft blocks the client, it ends for everyone. So every request to the school portal passes one limiter per process, specified in [request budget](../planning/specs/2026-09-26-request-budget.md).

**Where it sits.** `RequestBudget` (`src/core/budget/`) is a core port with one production implementation, `PortalBudget`: a token bucket with a cap on requests in flight (`limiter.ts`) behind a circuit breaker with backoff (`breaker.ts`). Pure: clock, timers and "is this background work?" are injected. The provider's `net.ts` is the only module that calls `fetch`; its helpers read the status and `Retry-After` of the provider's own answer shapes and send through the budget. Its one-request sender is not exported and never follows a redirect itself: every request says `redirect: "follow"` or `"manual"`, a write is never followed, and a followed redirect goes to the same origin only, at most five hops, each hop its own request through the budget (see `docs/planning/specs/2026-09-26-drop-ssp-node.md`). The provider's entry points (`createSession`, `createAuthStrategies`, `createApiPortal`, `createSchoolDirectory`, `probeReachability`) receive the budget through the port and wrap whatever fetch they are given, test fakes included; `PlaywrightSession` counts each navigation as one request. `wiring.ts` builds one budget per session manager, which is one per process in every host, with the provider's defaults (`SchoolProvider.requestBudget`) and the config's overrides. `make boundaries` refuses a global `fetch` anywhere else, any import of `@elias4044/ssp-node` (the student client this project once used for its HTTP helpers, whose own requests went around the budget), and network modules outside the inbound servers. What is not budgeted, on purpose: the parent's own browser during BankID, and `browser install`.

**Behaviour.** Defaults for SchoolSoft: 20 requests a minute, bursts of 10, 2 in flight; configurable within 1 to 60, 20 and 4. A 429, a 5xx or a network failure pauses everything for `Retry-After` (1 s to 60 min) or 2 s doubling to 60 s; a request waits out a pause of up to 10 s and otherwise fails at once. Three push-backs within two minutes with no success in between open the breaker for 5 minutes (or a longer `Retry-After`): requests fail fast with `PortalPushbackError` (`portal_paused`, kind `upstream`, retryable, transient so a saved session is kept), and everything queued is failed unsent. After the cool-down the first user read is the probe; writes, background work and other callers fail fast meanwhile. An answer closes it; push-back reopens it with the cool-down doubled up to an hour. Nothing is ever retried by the budget: the absence report is sent once or not at all, never while the breaker is not closed, and a 429 to it is "outcome unknown". A request whose `AbortSignal` fires while queued leaves without spending a token (the connector passes each request's signal via `PortalDeps.signal`).

**Around it.** Keepalive ticks run as background work (`asBackground`): the scheduler skips a tick while the budget reports anything but "requests flow" (`pausedUntil`) and never probes, so a breaker that opens overnight keeps keepalive quiet until the parent's next request. The read cache serves hits while the breaker is open (they send nothing) but never past their TTL. `auth_status` (`portal`), the connector's owner dashboard and `GET /api/v1/session` (`schoolsoft.portal`) report `ok`, `backing_off`, `paused` or `probing` with `retryAt`; REST answers `503` `portal-pushback` with `Retry-After`; `doctor` shows the configured numbers.

**Per process.** The CLI (one process per command), each stdio MCP server and the connector each have their own budget; two processes on one machine can together send twice the budget. That is documented rather than solved with cross-process locking. The connector, which serves several apps, is one process, so its budget is the deployment's. SchoolSoft's real limits and how it signals them are unknown and need live observation.

## Session states

[![Session states](../diagrams/dist/session-states.svg)](../diagrams/src/session-states.mmd)

## Repository layout

```
src/core/         vendor-neutral: budget/ (RequestBudget port: token bucket, breaker, backoff), cache/ (ReadCache port, TTL policy), keepalive/ (scheduler), provider/ (SchoolProvider seam), auth/ (strategy port, callback server, opener), portal/ (Portal types, guardian, page-spec, inspect, verify, composite), browser/ (session guard, playwright, optional-playwright, install, web-login), session/, operations/, school-directory.ts, config.ts (model), wiring.ts (composition root; the one core file that imports providers), constants.ts, index.ts
src/providers/    one directory per school portal vendor implementing SchoolProvider + index.ts registry
src/providers/schoolsoft/  net.ts (the one budgeted transport), tokens.ts (the session's tokens and cookies), auth/ (BankID via SchoolSoft OAuth, token/cookie exchange), portal/ (api-portal facade + api/{transport,eva,webview,legacy,web-session}, browser-portal, pages, extractors, fingerprints), routing.ts, session.ts, web-login.ts, schools.ts
src/mcp/          server.ts (registry → tools), respond.ts, index.ts (bin)
src/cli/          flags.ts, program.ts, exit-codes.ts, commands/{configure,doctor,verify,browser}.ts, text/ (--format text views), index.ts (bin)
src/shared/       bootstrap.ts (env + config file → context), version.ts
src/http/         parent-hosted HTTPS adapter: OAuth, owner pages, scoped runtime, REST routes (routes, rest, problem), encrypted storage and startup
skills/schoolsoft SKILL.md, scripts/schoolsoft.sh, references/commands.md (generated)
plugins/          claude/ (marketplace + two plugins), mcpb/, opencode/, openclaw/, hermes/, pi/
docs/             README.md (index), getting-started/, integrations/ (AI clients), deployment/ (parent hosting), development/, reference/, planning/, diagrams/, assets/
scripts/          check-boundaries, gen-docs, gen-skills, validate-plugins, e2e-login
test/             unit/, boundary/, functional/, packaging/, e2e/, helpers/
```

## Configuration

Precedence: CLI flags → `SCHOOLSOFT_*` environment → `config.json` → defaults.

`config.json` also holds `"version"`, the file's format version, written by `configure`; it is not a setting (see [What lives where at runtime](#what-lives-where-at-runtime)).

**Accounts.** An account is one login to one school portal tenant, keyed `<provider>:<school>` (`schoolsoft:taby`); one login sees every child of that tenant. `school`, `orgId`, `userType`, `clientId` and `provider` are the account's settings, the rest belong to the machine. `configure` stores them under `accounts.<key>` and points `account` at the current one; other schools configured before are kept. The top-level spelling (`"school": "taby"`) stays valid and is folded in on every read. A school chosen with `--school` or `SCHOOLSOFT_SCHOOL` takes that school's stored settings, never the configured school's; without one, the file's current account applies. `src/core/accounts.ts` holds the key and the keyed-document helpers; `accountKeyOf(config)` is the account `wiring.ts` opens the session and history stores for. Every surface works with one account; choosing among them is E3.4. See `docs/planning/specs/2026-09-26-accounts-by-school.md`.

| Key                     | Env                                  | Default                                                           |
| ----------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `school`                | `SCHOOLSOFT_SCHOOL`                  | required; `configure` finds it by name                            |
| `orgId`                 | `SCHOOLSOFT_ORGID`                   | from the child's profile                                          |
| `userType`              | `SCHOOLSOFT_USER_TYPE`               | `parent`                                                          |
| `clientId`              | `SCHOOLSOFT_CLIENT_ID`               | `vApp` for parent, `eApp` otherwise                               |
| `callbackPort`          | `SCHOOLSOFT_CALLBACK_PORT`           | `43117`                                                           |
| `configDir`             | `SCHOOLSOFT_CONFIG_DIR`              | platform config dir (`doctor` prints it)                          |
| `stateDir`              | `SCHOOLSOFT_STATE_DIR`               | `<configDir>/state`                                               |
| `cache`                 | `SCHOOLSOFT_CACHE`                   | `on` (in-memory read cache; `off` disables)                       |
| `keepalive`             | `SCHOOLSOFT_KEEPALIVE`               | `off`; `app` renews the token, `all` also touches the web session |
| `keepaliveWebMinutes`   | `SCHOOLSOFT_KEEPALIVE_WEB_MINUTES`   | `10` (5 to 120)                                                   |
| `keepaliveQuietHours`   | `SCHOOLSOFT_KEEPALIVE_QUIET_HOURS`   | none; `22-6` sends nothing between those local hours              |
| `allowWrites`           | `SCHOOLSOFT_ALLOW_WRITES`            | off; `1` lets write operations run                                |
| `requestsPerMinute`     | `SCHOOLSOFT_REQUESTS_PER_MINUTE`     | provider default (SchoolSoft `20`); 1 to 60, per process          |
| `requestBurst`          | `SCHOOLSOFT_REQUEST_BURST`           | provider default (SchoolSoft `10`); 1 to 20                       |
| `maxConcurrentRequests` | `SCHOOLSOFT_MAX_CONCURRENT_REQUESTS` | provider default (SchoolSoft `2`); 1 to 4                         |

## Testing

| Layer      | Where              | What it proves                                                                                                          | Network               |
| ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Unit       | `test/unit`        | OAuth, cookie exchange, guardian API paths, school ranking, session manager, strategy sequence, config, flag derivation | none (injected fetch) |
| Boundary   | `test/boundary`    | import rules, registry invariants, generated docs equal committed, doc links and diagrams                               | none                  |
| Functional | `test/functional`  | real MCP client over in-memory transport; CLI program in-process; one spawn of the built bin                            | none                  |
| Packaging  | `test/packaging`   | every host manifest validates; skill follows the Agent Skills spec; per-host skill builds                               | none                  |
| E2E        | `test/e2e` (gated) | the real thing: BankID once, then silent restore, forced refresh, every operation over stdio and CLI, child switching   | SchoolSoft            |

`make check` runs everything but E2E with a 100% coverage gate (lines, branches, functions, statements) over the offline suites. What the gate deliberately leaves out, each named in `.c8rc.json` or an inline `c8 ignore` with its reason: the core export barrel, CLI/MCP process entrypoints (covered by `make e2e-artifact`), the HTTP process entrypoint (covered by `test/packaging/connector.test.ts` against the built binary), types-only modules, the in-page extractors (run only inside Chromium, covered by `make e2e-artifact`), the single optional `playwright` import (presence covered by `make e2e-artifact`, absence by the pack smoke), and the live-network defaults for token exchange and the real browser opener (covered by `make e2e`). Environment defaults such as the OS browser opener and the Chromium installer take an injectable spawn so the unit tests cover their branches. `make e2e` runs the live suite; findings accumulate in a gitignored report. The offline suites preload `test/helpers/offline.mjs`, which makes any request to the real school portal (through `node:http(s)` or `fetch`) fail at once, so a test that forgets its fake `fetchImpl` fails loudly (the guard adds itself to `NODE_OPTIONS`, so child processes a test spawns with the inherited environment are guarded as well) instead of reaching SchoolSoft.

`make verify-live` runs the built CLI's `doctor --verify` against the live portal with the saved session (see [Typed outputs and drift](#typed-outputs-and-drift)); like `make capture` it is local only and never logs in. `make capture` is the live pass's recorder (spec: [capture probe](../planning/specs/2026-09-26-capture-probe.md)). With the sessions already saved it records the structure of the absence, leave and message forms, the gated Översikt page and a school-event agenda, redacted fail-closed by `src/providers/schoolsoft/capture/`, into the gitignored `.captures/`. It never logs in, submits or calls a write endpoint, and stops before navigating when no session is saved. `make capture-promote` moves reviewed files into `test/fixtures/` only when a personal-data check finds nothing; the maintainer reads the diff before committing. The flow, redactor and check are unit-tested on synthetic samples; the in-page part runs in Chromium in `make e2e-artifact`.

## What lives where at runtime

| Path                             | Contents                                                            | Sensitivity   |
| -------------------------------- | ------------------------------------------------------------------- | ------------- |
| `<configDir>/config.json`        | each account's school slug and orgId, the current account           | low           |
| `<configDir>/schools.json`       | cached public school list                                           | none          |
| `<stateDir>/key.bin`             | AES key for the three sealed files below                            | secret        |
| `<stateDir>/session.enc`         | per account: tokens, cookies, children's names/ids/class            | personal data |
| `<stateDir>/session-history.enc` | per account: timestamps and counters of logins, refreshes, losses   | low           |
| `<stateDir>/login-pending.enc`   | while a login runs: start time, process id, login URL, failure text | low           |

Every file and directory above is created through `src/core/private-files.ts`: directories 0700, files 0600, written to a temporary file and renamed into place (`key.bin` is created exclusively, so two processes agree on one key). `make boundaries` refuses a file-creating `node:fs` import anywhere else in `src`. The three `.enc` files in the state directory are AES-256-GCM with `key.bin` (`src/core/session/sealed.ts`); the history and the marker are bound to their file name. Builds up to 0.3.0 wrote `session-history.json` and `login-pending.json` in plaintext: the history is read from there until the sealed file is written, and the old file is deleted after that; an old marker is removed with the next one. See `docs/planning/specs/2026-09-26-privacy-small-fixes.md`.

`schoolsoft-agent logout` removes the current account's session and leaves other accounts' logins alone; the file goes with the last one (the history of timestamps stays, since a lifetime is only known once a session is gone); deleting the state directory removes everything. Saving re-reads the file and replaces only its own account's entry. The connector's `session.enc` and `history.enc` use the same per-account formats for its one account; `oauth.enc`, `identity.enc`, `login-pending.enc` (one BankID login at a time: the callback port and the browser are shared), `schools.json` and `key.bin` are not per account. The connector writes no pending-login marker: it is one process and keeps its login in progress in memory.

**Versioned files.** `config.json`, `session.enc`, the session history (`session-history.enc`) and the connector's `session.enc`, `history.enc`, `oauth.enc` and `identity.enc` each carry a whole-number `version` in their JSON (for the encrypted files, inside the encrypted payload, where the authentication tag covers it). A file without one is v0, the format written before versions existed; it loads through the migrations and is stored with the current version on its next write. `config.json`, `session.enc` and the session history are at v2 (keyed by account): v1 → v2 moves the settings and the session under the account they belong to, and keeps a v1 history as `legacy` until the first account records an event (a v1 history does not say which school it was for). A file with a version newer than the build knows is refused with `NewerFormatError` (kind `not_available`, exit 5, "update schoolsoft-agent") and is never overwritten or deleted; the local session store also checks before `save` and `clear`, because a CLI and an MCP server of different builds can share one state directory. A malformed version is treated like any other corrupt copy of that file. The helper is `src/core/versioned.ts` (pure); each format is declared next to its type (`CONFIG_FORMAT`, `SESSION_FORMAT`, `HISTORY_FORMAT`, `OAUTH_STATE_FORMAT`, `IDENTITY_FORMAT`), and a format change is one migration function added to that list. `login-pending.enc` (a marker that lives minutes), `schools.json` (a re-fetchable cache) and `key.bin` (raw key bytes) are not versioned. `doctor` prints the version of each file it inspects. See `docs/planning/specs/2026-09-26-versioned-state.md`.

**Calendar reads.** `get_calendar` validates a date range, then calls one
API-only portal capability. SchoolSoft's provider reads the lessons and event
agendas sequentially and maps both to `CalendarEvent`s (date-only entries stay
dates; `kind` says which source). It returns no partial success. The generic
`beforeRead` host guard travels through API portal wiring to each HTTP GET, so
connector consent and child focus are rechecked between requests and on retries.

**The first write.** `report_absence` is off until `allowWrites` is set, returns a
preview unless called with `confirm: true`, and is not offered by the parent-hosted
connector. A write reaches the network at most once: `withSessionRecovery` renews a
rejected session but does not repeat capabilities listed in `WRITE_CAPABILITIES`,
`net.ts` never follows a redirect for a write, and a transport failure or 5xx
is reported as "outcome unknown" rather than retryable. The request body of
`POST /rest-api/parent/absence-notice` is **unverified**; the guess lives in one
mapper (`portal/api/absence-notice-body.ts`) until the live pass corrects it. The
general write framework (confirmation tokens, idempotency keys, audit log, remote
write scope) is specified in the [write framework spec](../planning/specs/2026-09-26-write-framework.md)
(E7.1) and built in E7.2; until then see `docs/planning/specs/2026-09-21-absence-report.md`.
