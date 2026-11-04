# Private network MCP behind Traefik

This fork runs the existing Streamable HTTP connector at `/mcp`. One process
owns the SchoolSoft session, OAuth grants and opt-in background token renewal.
The local stdio MCP entrypoint remains available for existing installations.

## Deployment

Use an existing private Traefik installation with HTTPS and a backend Docker
network. Copy `.env.traefik.example` to `.env`, choose the SchoolSoft tenant slug
from the official school URL, and generate the owner password and encryption key
independently. Protect `.env` with mode 0600 and keep it outside Git.

Start `docker compose -f compose.traefik.yaml up -d --build`. This recipe explicitly
enables app keepalive and desktop OAuth callbacks. It publishes no host ports,
mounts no Docker socket or home directory, and stores encrypted state in the
named volume `schoolsoft-state`. Keep both this volume and the storage key across
updates. `docker compose down` retains the volume; `down --volumes` deletes it.

Add a Traefik file-provider route for the chosen hostname with backend
`http://schoolsoft-connector:3000`. Reuse your existing certificate and set the
private DNS record to Traefik's address. The connector trusts one proxy hop. Keep
the service reachable only through your LAN/VPN; public ingress is unnecessary.

## BankID from another computer

Open the connector's HTTPS address from the computer connected to your VPN and
sign in to its owner dashboard. Start SchoolSoft login, follow the official
SchoolSoft link and complete BankID yourself. The official page displays the QR
code. The browser returns to `<SCHOOLSOFT_PUBLIC_URL>/schoolsoft/callback` over
the VPN; no browser or localhost listener on the Docker host is involved.

SchoolSoft must accept this redirect URI. Upstream has only verified its local
callback with a real account; the external HTTPS callback remains an acceptance
test. Do not claim successful live authentication until the parent completes it.
There is no BankID automation or QR-code relay.

## Local MCP clients

Connect a Streamable HTTP client to `<SCHOOLSOFT_PUBLIC_URL>/mcp` with OAuth and
PKCE. Set `SCHOOLSOFT_ALLOW_LOOPBACK_CLIENTS=1` only when desktop clients need it.
It permits HTTP callbacks on `127.0.0.1`, `localhost` or `[::1]` with an explicit
port and no credentials, query or fragment. The exact registered redirect URI,
including its port, is still bound to each authorization code. The callback is
on the **client computer**, independently of the SchoolSoft callback above.
This flag defaults to off; existing vendor and reference-page callbacks remain
unchanged. Approve each app's children and read scopes in the owner dashboard.

The connector offers children, schedule, calendar and lunch. Messages,
assignments and browser-only tools are still local MCP/CLI capabilities.
Use `/reference/` to test the HTTP API in a browser with separately approved
access. `/mcp` and `/api/v1` require bearer tokens; the owner cookie does not
authorize them. Revoke an app on the dashboard to withdraw its grant.

## Dependencies and verification

The SDK is pinned to stable `1.32.2`; the lockfile also updates vulnerable
transitive runtime dependencies. Scoped overrides move `test-exclude`'s glob and
minimatch dependencies to patched major versions because its declared ranges
still resolve to vulnerable releases. Run the coverage gate when changing these
overrides. The container's Node 24.22.2 base is pinned by digest.

Check `npm audit`, `make check`, `make check-ci`, `make check-package`,
`make e2e-artifact` and `make connector-smoke`. Offline and fake-portal checks
cannot prove real BankID, the SchoolSoft refresh-token lifetime, VPN access from
a remote device or the contents of a real child's calendar.
