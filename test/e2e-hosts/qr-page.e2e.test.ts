/** Real browser: manual QR presentation and token establishment against a synthetic portal only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeConnector } from "../../src/http/start.js";
import { browserStatus } from "../../src/core/browser/install.js";
import { fakeUpstream } from "../packaging/connector-smoke/fake-upstream.mjs";

const ready = await browserStatus({ kind: "chromium" });
test(
  "owner completes the QR page in Chromium without an external callback",
  { skip: ready.ready ? false : "Chromium not installed", timeout: 60000 },
  async () => {
    const { chromium } = await import("playwright");
    const probe = createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const stateDir = mkdtempSync(join(tmpdir(), "qr-page-e2e-"));
    const config = {
      publicUrl: `http://localhost:${port}`,
      proxyHops: 0,
      adminPassword: "synthetic-qr-owner-password-0123456789",
      storageKey: Buffer.alloc(32, 9),
      stateDir,
      port,
      school: "synthetic-fixture",
      loginMode: "qr" as const,
    };
    const upstream = fakeUpstream();
    const { app, runtime } = composeConnector(config, {
      fetchImpl: async (
        url: string,
        ...rest: Parameters<typeof upstream.fetchImpl> extends [string, ...infer R] ? R : never
      ) => {
        const u = new URL(url);
        if (u.pathname.includes("/bankid/secure"))
          return {
            status: 200,
            headers: {},
            setCookies: [],
            data: u.pathname.endsWith("/collect")
              ? { username: "Synthetic" }
              : u.pathname.endsWith("/redirect")
                ? {
                    redirect_uri:
                      "com.schoolsoft.vapp://?" +
                      new URLSearchParams({
                        state: u.searchParams.get("state")!,
                        code: "synthetic-upstream-code",
                      }),
                  }
                : {
                    sessionId: "synthetic",
                    QRCode: Buffer.from(
                      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>',
                    ).toString("base64"),
                  },
          };
        return upstream.fetchImpl(url, ...rest);
      },
    });
    const server = app.listen(port, "127.0.0.1");
    await once(server, "listening");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(config.publicUrl + "/owner/login");
      await page.fill('input[name="password"]', config.adminPassword);
      await page.click('button[type="submit"]');
      await page.waitForURL(/\/owner$/);
      await page.click("text=Sign in with BankID");
      await page.waitForURL(/\/owner\/schoolsoft\/qr$/);
      assert.ok(
        await page
          .locator("#qr")
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      );
      await page.waitForURL(/\/owner$/);
      assert.match(await page.content(), /SchoolSoft: connected/);
    } finally {
      await browser.close();
      await runtime.close();
      server.close();
      server.closeAllConnections();
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
);
