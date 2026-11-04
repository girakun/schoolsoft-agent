import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  AgentError,
  InputError,
  NetworkError,
  UpstreamError,
  NotAuthenticatedError,
  CapabilityNotSupportedError,
  NewerFormatError,
  SessionLostError,
  WebLoginRequiredError,
  NotConfiguredError,
  defineOperation,
  getOperation,
  operations,
  READ_ONLY,
  type Operation,
} from "../../src/core/index.js";
import { ResponseDriftError } from "../../src/core/errors/index.js";
import { ConnectorRefusedError } from "../../src/http/runtime.js";
import {
  API_BASE,
  REST_OPERATIONS,
  parseChildId,
  parseQuery,
  restRoutes,
  slug,
} from "../../src/http/routes.js";
import {
  PROBLEMS,
  PROBLEM_TYPE_PREFIX,
  classify,
  negotiateLang,
  problemBody,
  refusals,
  type ProblemName,
} from "../../src/http/problem.js";

const route = (name: string) => restRoutes().find((r) => r.operation.name === name)!;

test("routes are generated from the registry: one per connector operation, in registry order", () => {
  const routes = restRoutes();
  assert.deepEqual(
    routes.map((r) => r.operation.name),
    operations.map((o) => o.name).filter((n) => REST_OPERATIONS.some((c) => c === n)),
  );
  assert.deepEqual(
    routes.map((r) => r.path),
    [
      "/api/v1/children",
      "/api/v1/children/{childId}/schedule",
      "/api/v1/children/{childId}/calendar",
      "/api/v1/children/{childId}/lunch-menu",
    ],
  );
  for (const r of routes) {
    assert.equal(r.operation, getOperation(r.operation.name));
    assert.ok(r.operation.annotations.readOnly && r.operation.output, r.path);
    assert.equal(r.childScoped, "child_id" in r.operation.input);
    assert.equal(API_BASE + r.pattern.replace(":childId", "{childId}"), r.path);
    // Query parameters are the input minus child_id, never anything else.
    assert.deepEqual(
      r.query.map((q) => q.name),
      Object.keys(r.operation.input).filter((k) => k !== "child_id"),
    );
  }
  assert.deepEqual(route("get_calendar").query, [
    { name: "start_date", kind: "string", description: route("get_calendar").query[0].description },
    { name: "end_date", kind: "string", description: route("get_calendar").query[1].description },
    { name: "fresh", kind: "boolean", description: route("get_calendar").query[2].description },
  ]);
  assert.equal(route("get_schedule").query[0].kind, "number");
  assert.match(route("get_schedule").query[0].description, /ISO week/);
  assert.equal(slug("get_lunch_menu"), "lunch-menu");
  assert.equal(slug("list_children"), "children");
});

test("the table refuses writes, untyped operations and inputs a query string cannot carry", () => {
  const typed = defineOperation({
    name: "get_things",
    title: "t",
    description: "Use when: t",
    input: { child_id: z.number().int().optional(), kinds: z.array(z.string()) },
    output: z.object({}),
    portal: [],
    annotations: READ_ONLY,
    run: async () => ({}),
  }) as unknown as Operation;
  assert.throws(() => restRoutes([typed], ["get_things"]), /unsupported input schema for "kinds"/);
  const untyped = { ...typed, output: undefined, input: {} };
  assert.throws(() => restRoutes([untyped], ["get_things"]), /read-only and typed/);
  const writing = { ...typed, input: {}, annotations: { ...READ_ONLY, readOnly: false } };
  assert.throws(() => restRoutes([writing], ["get_things"]), /read-only and typed/);
  const describedInner = { ...typed, input: { word: z.string().describe("inner") } };
  assert.deepEqual(restRoutes([describedInner], ["get_things"])[0].query, [
    { name: "word", kind: "string", description: "inner" },
  ]);
  const bare = { ...typed, input: { word: z.string() } };
  assert.equal(restRoutes([bare], ["get_things"])[0].query[0].description, "");
  assert.equal(restRoutes([bare], ["get_things"])[0].path, "/api/v1/things");
  const shadowing = { ...typed, name: "get_overview", input: { child_id: typed.input.child_id } };
  assert.throws(() => restRoutes([shadowing], ["get_overview"]), /shadow a composite route/);
});

test("query strings convert by kind, once each, and are checked by the operation's schema", () => {
  const schedule = route("get_schedule");
  assert.deepEqual(parseQuery(schedule, {}), {});
  assert.deepEqual(parseQuery(schedule, { week: "37", fresh: "true" }), { week: 37, fresh: true });
  assert.deepEqual(parseQuery(schedule, { fresh: "false" }), { fresh: false });
  assert.deepEqual(
    parseQuery(route("get_calendar"), { start_date: "2026-09-01", end_date: "2026-09-02" }),
    { start_date: "2026-09-01", end_date: "2026-09-02" },
  );
  for (const [query, message] of [
    [{ child_id: "1" }, /unknown query parameter "child_id"/],
    [{ other: "1" }, /unknown query parameter "other"/],
    [{ week: ["1", "2"] }, /"week" may be given once/],
    [{ week: "abc" }, /week must be a number/],
    [{ week: "" }, /week must be a number/],
    [{ fresh: "yes" }, /fresh must be true or false/],
    [{ week: "99" }, /week too_big/],
    [{ week: "1.5" }, /week invalid_type/],
  ] as const)
    assert.throws(
      () => parseQuery(schedule, query),
      (e: unknown) => {
        assert.ok(e instanceof InputError);
        assert.match(e.message, message);
        return true;
      },
    );
});

test("child ids in the path are positive safe integers", () => {
  assert.equal(parseChildId("201"), 201);
  for (const bad of ["0", "-1", "1.0", "01", "abc", "", "99999999999999999"])
    assert.throws(() => parseChildId(bad), /childId must be a positive integer/, bad);
});

test("every error kind maps to one problem and status; token vs SchoolSoft session never share one", () => {
  const cases: [unknown, ProblemName, number][] = [
    [new InputError("x"), "invalid-input", 400],
    [new InvalidTokenError("revoked"), "oauth-token", 401],
    [new ConnectorRefusedError("child", "x"), "child-not-permitted", 403],
    [new NotAuthenticatedError("no saved session"), "schoolsoft-session", 409],
    [new UpstreamError(401, "schedule"), "schoolsoft-session", 409],
    [new SessionLostError("schedule"), "schoolsoft-session", 409],
    [new SessionLostError("page", true), "web-session", 409],
    [new WebLoginRequiredError("grades"), "web-session", 409],
    [new Error("boom with a secret"), "internal", 500],
    ["thrown string", "internal", 500],
    [
      new AgentError({ kind: "internal", key: "internal", params: { detail: "x" } }),
      "internal",
      500,
    ],
    [new CapabilityNotSupportedError("getGrades", "schoolsoft"), "not-implemented", 501],
    [
      new ResponseDriftError("get_schedule", "0.start invalid_type", "get_schedule"),
      "response-drift",
      502,
    ],
    [new UpstreamError(500, "schedule"), "upstream", 502],
    [new ConnectorRefusedError("unavailable", "busy"), "connector-busy", 503],
    [new ConnectorRefusedError("child_changed", "moved"), "connector-busy", 503],
    [new NewerFormatError("session.enc", 9, 1), "not-available", 503],
    [new NotConfiguredError("no school"), "not-available", 503],
    [new NetworkError("ENOTFOUND"), "network", 504],
  ];
  for (const [error, name, status] of cases) {
    const classified = classify(error);
    assert.equal(classified.name, name, String(error));
    assert.equal(PROBLEMS[classified.name].status, status);
  }
  assert.equal(PROBLEMS["oauth-token"].status, 401);
  assert.equal(PROBLEMS["schoolsoft-session"].status, 409);
});

test("problem bodies carry the localized message and http hint, and nothing internal", () => {
  const url = "https://connector.example";
  const gone = problemBody(classify(new NotAuthenticatedError("session expired")), "sv", url);
  assert.deepEqual(gone, {
    type: PROBLEM_TYPE_PREFIX + "schoolsoft-session",
    title: "SchoolSoft session required",
    status: 409,
    detail: "Inte inloggad på SchoolSoft (session expired).",
    hint: "Be föräldern öppna anslutningens ägarsida och logga in på SchoolSoft igen med BankID; den här appen förblir ansluten.",
    kind: "not_authenticated",
    retryable: false,
    ownerDashboard: url + "/owner",
  });
  const internal = problemBody(classify(new Error("secret-detail")), "en", url);
  assert.doesNotMatch(JSON.stringify(internal), /secret-detail/);
  assert.equal(
    internal.detail,
    "The connector could not complete this request; nothing was returned.",
  );
  const token = problemBody(classify(new InvalidTokenError("x")), "en", url);
  assert.equal(token.error, "invalid_token");
  assert.equal(token.ownerDashboard, undefined);
  const scope = problemBody(refusals.scope("get_calendar"), "en", url);
  assert.equal(scope.error, "insufficient_scope");
  assert.match(scope.detail, /not approved for get_calendar/);
  const busy = problemBody(classify(new ConnectorRefusedError("unavailable", "x")), "en", url);
  assert.equal(busy.retryable, true);
  const child = problemBody(classify(new ConnectorRefusedError("child", "x")), "en", url);
  assert.equal(child.retryable, false);
  assert.match(child.hint!, /connect this app again/);
  const origin = problemBody(refusals.origin(), "en", url);
  assert.equal(origin.hint, undefined);
  assert.equal(problemBody(refusals.notFound(), "en", url).status, 404);
  assert.equal(problemBody(refusals.rateLimited(), "sv", url).status, 429);
  const web = problemBody(classify(new WebLoginRequiredError("grades")), "en", url);
  assert.equal(web.ownerDashboard, url + "/owner");
});

test("Accept-Language picks Swedish or English by quality, else the connector default", () => {
  assert.equal(negotiateLang(undefined, "en"), "en");
  assert.equal(negotiateLang(undefined, "sv"), "sv");
  assert.equal(negotiateLang("sv-SE,sv;q=0.9,en;q=0.8", "en"), "sv");
  assert.equal(negotiateLang("en-GB, sv;q=0.5", "sv"), "en");
  assert.equal(negotiateLang("de-DE,sv;q=0.4,en;q=0.7", "sv"), "en");
  assert.equal(negotiateLang("sv;q=0.5,en;q=0.5", "en"), "sv");
  assert.equal(negotiateLang("fr,de", "sv"), "sv");
  assert.equal(negotiateLang("sv;q=0, en;q=0", "sv"), "sv");
  assert.equal(negotiateLang("*", "en"), "en");
  assert.equal(negotiateLang("sv;level=1;q=0.2,en;q=0.1", "en"), "sv");
  assert.equal(negotiateLang("sv;q=1.2.3", "en"), "en");
});
