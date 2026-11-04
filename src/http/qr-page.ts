/* oxlint-disable oxc/no-async-endpoint-handlers -- Express 5 forwards rejected handlers. */
/** Owner-only QR display. No provider session id, code or verifier reaches the page. */
import { createHash } from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { page, form } from "./pages.js";
import { clientKey } from "./client-key.js";

// Runs in the owner's browser; only same-origin connector calls. Portal HTTP stays in the provider.
const script = `const image=document.getElementById('qr');
const status=document.getElementById('status');
async function tick(){
try{
const response=await window.fetch('/owner/schoolsoft/qr/status',{cache:'no-store'});
if(!response.ok){throw new Error();}
const result=await response.json();
if(result.state==='complete'){location.replace('/owner');return;}
if(result.state==='failed'){image.hidden=true;status.textContent='Inloggningen avslutades. Gå tillbaka och starta ett nytt försök.';return;}
image.src='/owner/schoolsoft/qr/image?v='+Date.now();
setTimeout(tick,3000);
}catch{image.hidden=true;status.textContent='Kontakten bröts. Gå tillbaka och starta ett nytt försök.';}
}
setTimeout(tick,3000);`;
export const QR_SCRIPT_HASH = createHash("sha256").update(script).digest("base64");
export interface QrPageRuntime {
  qrImage?(): string | undefined;
  qrStatus?(): Promise<"pending" | "complete" | "failed">;
  cancelQrLogin?(): void;
}
export function qrPage(runtime: QrPageRuntime) {
  const router = Router();
  router.use(
    "/qr",
    rateLimit({
      windowMs: 60_000,
      limit: 60,
      keyGenerator: (req) => clientKey(req.ip),
      validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
    }),
  );
  router.get("/qr", (_req, res) => {
    res.set(
      "Content-Security-Policy",
      `default-src 'none'; img-src 'self'; connect-src 'self'; script-src 'sha256-${QR_SCRIPT_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
    res.send(
      page(
        "Logga in med BankID",
        '<p>Öppna BankID på din telefon och skanna koden. Kontrollera i BankID-appen att identifieringen gäller SchoolSoft.</p><img id="qr" src="/owner/schoolsoft/qr/image" width="300" height="300" alt="QR-kod för BankID"><p id="status">Väntar på att du identifierar dig i BankID…</p><p><a href="/owner">Tillbaka till administrationssidan</a></p>' +
          form("/owner/schoolsoft/qr/cancel", res.locals.csrf, "", "Avbryt inloggning") +
          `<script>${script}</script>`,
      ),
    );
  });
  router.get("/qr/image", (_req, res) => {
    const svg = runtime.qrImage?.();
    if (!svg) {
      res.status(404).end();
      return;
    }
    res
      .type("image/svg+xml")
      .set("Content-Security-Policy", "sandbox; default-src 'none'")
      .send(svg);
  });
  router.get("/qr/status", async (_req, res) => {
    res.json({ state: runtime.qrStatus ? await runtime.qrStatus() : "failed" });
  });
  router.post("/qr/cancel", (_req, res) => {
    runtime.cancelQrLogin?.();
    res.redirect("/owner");
  });
  return router;
}
