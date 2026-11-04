/**
 * The API backends' transport says how each request treats a redirect: reads
 * (and the web session's child-focus PUT) follow, as they always did; the one
 * write never does and is marked for the budget.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SchoolsoftHttp,
  type ApiFetch,
} from "../../src/providers/schoolsoft/portal/api/transport.js";

test("redirect is explicit on every request: reads follow, the write does not", async () => {
  const seen: { method?: string; redirect: string; write?: boolean; url: string }[] = [];
  const fetchImpl: ApiFetch = async (url, _school, o) => {
    seen.push({ url, method: o.method, redirect: o.redirect, write: o.write });
    return { status: 200, data: {} };
  };
  const http = new SchoolsoftHttp("taby", fetchImpl);
  await http.get("/rest-api/a", {});
  await http.postJson("/rest/b", "c", {});
  await http.put("/rest-api/c", "c");
  await http.postWrite("/rest-api/d", "c", {});
  assert.deepEqual(seen, [
    {
      url: "https://sms.schoolsoft.se/taby/rest-api/a",
      method: undefined,
      redirect: "follow",
      write: undefined,
    },
    {
      url: "https://sms.schoolsoft.se/taby/rest/b",
      method: "POST",
      redirect: "follow",
      write: undefined,
    },
    {
      url: "https://sms.schoolsoft.se/taby/rest-api/c",
      method: "PUT",
      redirect: "follow",
      write: undefined,
    },
    {
      url: "https://sms.schoolsoft.se/taby/rest-api/d",
      method: "POST",
      redirect: "manual",
      write: true,
    },
  ]);
});

test("read query POST and web child focus recheck host consent before sending", async () => {
  let sent = 0;
  let allowed = true;
  const http = new SchoolsoftHttp(
    "taby",
    async () => {
      sent++;
      return { status: 200, data: [] };
    },
    () => {
      if (!allowed) throw new Error("revoked");
    },
  );
  await http.postJson("/rest/list", "cookie", {});
  await http.put("/rest-api/focus", "cookie");
  allowed = false;
  await assert.rejects(http.postJson("/rest/list", "cookie", {}), /revoked/);
  await assert.rejects(http.put("/rest-api/focus", "cookie"), /revoked/);
  assert.equal(sent, 2);
});
