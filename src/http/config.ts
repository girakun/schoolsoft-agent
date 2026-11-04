/** Validate public deployment settings before opening a listener. */
import { InputError } from "../core/index.js";
import { OWNER_PASSWORD_MAX_BYTES } from "./owner-session.js";
export interface ConnectorConfig {
  publicUrl: string;
  /** Reverse proxies in front whose forwarding header is trusted; 0 trusts none. */
  proxyHops: number;
  /** Permit desktop MCP clients to receive OAuth codes on their loopback listener. */
  allowLoopbackClients?: boolean;
  loginMode?: "browser" | "qr";
  adminPassword: string;
  storageKey: Buffer;
  stateDir: string;
  port: number;
  school: string;
}
export function connectorConfig(env: Record<string, string | undefined>): ConnectorConfig {
  let url: URL;
  try {
    url = new URL(env.SCHOOLSOFT_PUBLIC_URL ?? "");
  } catch {
    throw new InputError("SCHOOLSOFT_PUBLIC_URL must be your HTTPS address");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new InputError("SCHOOLSOFT_PUBLIC_URL must be an HTTPS origin without a path");
  const adminPassword = env.SCHOOLSOFT_ADMIN_PASSWORD ?? "";
  if (adminPassword.length < 32)
    throw new InputError("SCHOOLSOFT_ADMIN_PASSWORD needs at least 32 characters");
  if (Buffer.byteLength(adminPassword) > OWNER_PASSWORD_MAX_BYTES)
    throw new InputError(
      `SCHOOLSOFT_ADMIN_PASSWORD can be at most ${OWNER_PASSWORD_MAX_BYTES} bytes`,
    );
  // The secret's unpredictability is the only guess protection (a correct password is
  // never throttled), so refuse the obviously typed-in kind. Generated values pass.
  if (new Set(adminPassword).size < 8)
    throw new InputError("SCHOOLSOFT_ADMIN_PASSWORD must be randomly generated");
  const raw = env.SCHOOLSOFT_STORAGE_KEY ?? "";
  const storageKey = /^[a-fA-F0-9]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (
    storageKey.length !== 32 ||
    (!/^[a-fA-F0-9]{64}$/.test(raw) && storageKey.toString("base64") !== raw)
  )
    throw new InputError("SCHOOLSOFT_STORAGE_KEY must be 32 bytes encoded as base64 or hex");
  const school = env.SCHOOLSOFT_SCHOOL ?? "";
  if (!/^[a-zA-Z0-9_-]+$/.test(school))
    throw new InputError("SCHOOLSOFT_SCHOOL must be a school address slug");
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new InputError("PORT must be a port number");
  // Safe default: trust no forwarding header. Each deployment recipe sets its own value.
  const proxyHops = Number(env.SCHOOLSOFT_PROXY_HOPS ?? 0);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 2)
    throw new InputError("SCHOOLSOFT_PROXY_HOPS must be 0, 1 or 2");
  const loopback = env.SCHOOLSOFT_ALLOW_LOOPBACK_CLIENTS ?? "0";
  if (loopback !== "0" && loopback !== "1")
    throw new InputError("SCHOOLSOFT_ALLOW_LOOPBACK_CLIENTS must be 0 or 1");
  const loginMode = env.SCHOOLSOFT_LOGIN_MODE ?? "browser";
  if (loginMode !== "browser" && loginMode !== "qr")
    throw new InputError("SCHOOLSOFT_LOGIN_MODE must be browser or qr");
  return {
    proxyHops,
    allowLoopbackClients: loopback === "1",
    loginMode,
    publicUrl: url.origin,
    adminPassword,
    storageKey,
    school,
    port,
    stateDir: env.SCHOOLSOFT_STATE_DIR ?? "/data",
  };
}
