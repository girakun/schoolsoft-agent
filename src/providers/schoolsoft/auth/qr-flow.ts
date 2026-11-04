/** Direct BankID for an owner-controlled QR page. Identification always requires the human. */
import type { BrowserAuthorization } from "../../../core/provider/types.js";
import { AgentError, UpstreamError, guardNetwork } from "../../../core/errors/index.js";
import { buildAuthUrl, type TokenFetch } from "./oauth.js";
import { portalUrl } from "../web-login.js";

const APP_REDIRECT = "com.schoolsoft.vapp://";
const failure = (detail: string) =>
  new AgentError({
    kind: "not_authenticated",
    key: "token_exchange_failed",
    params: { what: "BankID", detail },
    hint: "login",
  });
function decodeQr(value: string): string {
  const svg = Buffer.from(value, "base64").toString("utf8");
  if (value.length > 256_000 || !/<svg[\s/>]/i.test(svg))
    throw failure("SchoolSoft returned an invalid QR image");
  return svg;
}

export async function runQrLogin(options: {
  school: string;
  userType: string;
  clientId: string;
  fetchImpl: TokenFetch;
  authorize: NonNullable<BrowserAuthorization["qr"]>;
}): Promise<{ code: string; verifier: string }> {
  if (options.userType !== "parent" || options.clientId !== "vApp")
    throw failure("QR login requires the guardian app client");
  const flow = buildAuthUrl({
    school: options.school,
    userType: "parent",
    clientId: options.clientId,
    redirectUri: APP_REDIRECT,
  });
  const params = new URLSearchParams(flow.authUrl.split("?")[1]);
  const endpoint = portalUrl(options.school, "/rest-api/login/parent/bankid/secure");
  async function get(path: string, query: URLSearchParams): Promise<Record<string, unknown>> {
    const response = await guardNetwork(() =>
      options.fetchImpl(
        endpoint + path + "?" + query,
        options.school,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          responseType: "json",
          redirect: "manual",
        },
        "SchoolSoftPlus-Mobile/1.0",
      ),
    );
    if (response.status >= 500) throw new UpstreamError(response.status, "BankID");
    if (response.status !== 200 || !response.data || typeof response.data !== "object")
      throw failure("SchoolSoft refused the QR sign-in step");
    return response.data as Record<string, unknown>;
  }
  const started = await get("", params);
  if (
    typeof started.sessionId !== "string" ||
    !started.sessionId ||
    typeof started.QRCode !== "string" ||
    !started.QRCode
  )
    throw failure("SchoolSoft did not return a QR challenge");
  const sessionId = started.sessionId;
  const code = await options.authorize({
    state: flow.state,
    qrSvg: decodeQr(started.QRCode),
    poll: async () => {
      const query = new URLSearchParams(params);
      query.set("grandidsession", sessionId);
      const collected = await get("/collect", query);
      const bankid = collected.grandidObject as
        { QRCode?: unknown; message?: { status?: string } } | undefined;
      if (bankid?.message?.status === "failed") throw failure("BankID sign-in ended");
      if (!collected.username)
        return typeof bankid?.QRCode === "string" ? { qrSvg: decodeQr(bankid.QRCode) } : {};
      const completed = await get("/redirect", query);
      if (typeof completed.redirect_uri !== "string")
        throw failure("SchoolSoft did not return a code");
      let target: URL;
      try {
        target = new URL(completed.redirect_uri);
      } catch {
        throw failure("Invalid sign-in result");
      }
      if (
        target.href.split("?")[0] !== APP_REDIRECT ||
        target.hash ||
        target.searchParams.get("state") !== flow.state ||
        !target.searchParams.get("code")
      )
        throw failure("The sign-in result does not match this request");
      return { code: target.searchParams.get("code")! };
    },
  });
  return { code, verifier: flow.verifier };
}
