import assert from "node:assert/strict";
import { test } from "node:test";
import { QrLoginSession } from "../../src/http/qr-session.js";
test("QR checks are throttled, share in-flight work and discard results after cancellation", async () => {
  let now = 0,
    active = true,
    calls = 0,
    complete = "",
    failures = 0;
  let resolve!: (v: { qrSvg?: string; code?: string }) => void;
  const session = new QrLoginSession(
    {
      state: "test",
      qrSvg: "initial",
      poll: () => {
        calls++;
        return new Promise((r) => {
          resolve = r;
        });
      },
    },
    () => now,
    () => active,
    (code) => {
      complete = code;
    },
    () => {
      failures++;
    },
  );
  assert.equal(session.image(), "initial");
  const first = session.poll();
  await session.poll();
  assert.equal(calls, 1);
  now = 4000;
  const concurrent = session.poll();
  assert.equal(calls, 1);
  resolve({ qrSvg: "next" });
  await Promise.all([first, concurrent]);
  assert.equal(session.image(), "next");
  const empty = session.poll();
  resolve({});
  await empty;
  now = 8000;
  const finishing = session.poll();
  resolve({ code: "code" });
  await finishing;
  assert.equal(complete, "code");
  now = 12000;
  const cancelled = session.poll();
  active = false;
  resolve({ code: "late" });
  await cancelled;
  assert.equal(complete, "code");
  assert.equal(session.image(), undefined);
  await session.poll();
  assert.equal(calls, 4);
  assert.equal(failures, 0);
});
test("QR upstream failures fail only the challenge still active", async () => {
  let active = true,
    failures = 0;
  let reject!: (reason: Error) => void;
  const session = new QrLoginSession(
    {
      state: "test",
      qrSvg: "initial",
      poll: () =>
        new Promise((_r, j) => {
          reject = j;
        }),
    },
    () => 0,
    () => active,
    () => {},
    () => {
      failures++;
    },
  );
  let waiting = session.poll();
  reject(new Error("synthetic"));
  await waiting;
  assert.equal(failures, 1);
  const old = new QrLoginSession(
    {
      state: "old",
      qrSvg: "old",
      poll: () =>
        new Promise((_r, j) => {
          reject = j;
        }),
    },
    () => 0,
    () => active,
    () => {},
    () => {
      failures++;
    },
  );
  waiting = old.poll();
  active = false;
  reject(new Error("late"));
  await waiting;
  assert.equal(failures, 1);
});
