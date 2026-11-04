# Connect Claude or ChatGPT using your own server

This option is for a parent who wants to use their existing AI app without
installing OpenClaw, Hermes, Pi or another agent. You rent a small computer on the
internet, called a **server**, and run your own copy of this project there. Claude
or ChatGPT connects to that computer using a private, revocable permission.

**Release candidate:** the connector and deployment files are implemented, but a
real SchoolSoft login using an external HTTPS callback still needs a parent-led
acceptance test. Automated tests cannot establish whether SchoolSoft accepts that
callback. Claude/ChatGPT account eligibility and mobile availability also need
checking with real accounts. Do not buy hosting expecting a proven phone setup
yet. The [support matrix](../integrations/support-matrix.md) lists the existing local alternatives.

One server is for **one guardian account**, with that guardian's selected children.
Use separate servers for different guardians. This project is independent of
SchoolSoft AB and BankID; neither endorses or operates it.

## Before you start

You need your usual SchoolSoft guardian login and BankID, a Claude or ChatGPT
account that allows custom remote connectors, and your own hosting account. Check
that your AI app offers **Add custom connector/app** before paying for anything.
Your workplace's account administrator may disable this feature.

Start with [choose a hosting provider](README.md) for a plain-language comparison,
including detailed [Hostinger VPS](hostinger.md) and [Cloudflare Tunnel](cloudflare.md) walkthroughs.
The two foundational routes below are:

| Route           | What you arrange                                     | Effort                                                         |
| --------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| Render          | Your own Render account and paid service with a disk | Fewer server administration steps; guided below                |
| Your own server | Docker, a domain name, DNS and ports 80/443          | For you or a trusted person comfortable administering a server |

You still complete BankID yourself. Never give an AI assistant your BankID code,
admin password, storage key or hosting login.

## What is private, and from whom?

The project author receives no account, session or school data from this deployment.
Your server stores the SchoolSoft login state encrypted on its disk. The encryption
key is stored separately in your hosting account's environment settings.

Your hosting provider, anyone with administrator access to that account or server,
and software running on the server could access the data while it is being used.
Encryption does not remove that trust. Claude or ChatGPT receives the school data
returned by the tools you use, and may retain it under your account's data settings.
The connector therefore does not mean that only you can ever see the information.
What the server saves, for how long, and what each AI app can read is listed in
[how your family's data is handled](../getting-started/data-handling.md#what-is-saved-on-your-connector-server).

The network MCP exposes all 22 read-only operations from the operation registry:

| Area                               | Operations (each has the `schoolsoft_` tool prefix)                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| School and sign-in status          | `find_school`, `auth_status`, `list_children`                                                                                              |
| School day                         | `get_schedule`, `get_calendar`, `get_lunch_menu`                                                                                           |
| School communications              | `get_news`, `get_messages`, `get_message`, `get_activity_log`                                                                              |
| Learning                           | `get_assignments`, `get_assignment_detail`, `get_subject_rooms`                                                                            |
| Class resources (headless browser) | `get_contacts`, `get_bookings`, `get_files`                                                                                                |
| Separate web login required        | `get_grades`, `get_student_documents`, `get_unreported_absence`, `get_attendance_report`, `get_assessment_criteria`, `get_grade_prognosis` |

`login`, `logout` and `report_absence` are never offered as network tools or OAuth
scopes, even if the server's local write setting is enabled. The owner console
continues to manage sign-in and disconnection. Read operations may maintain the
session, select a child, or use SchoolSoft's list-query POST; they do not submit,
send or delete school data. The browser blocks mutating page requests.

Each tool is a separate OAuth scope. After updating, reconnect the MCP client and
approve the additional reads and children you want. Existing grants and refresh
tokens retain their original scopes; an update never grants additional access.
The guardian's message inbox is scoped to the school, not an individual child,
and can contain messages about siblings at that school. Contact lists can include
other families' details. Select these permissions accordingly.

The connector image includes Playwright and Chromium for browser-backed reads.
GDPR-gated reads still require a valid separate web-login session in the same
account store. This release does not add remote web login or session import;
without that session these tools return the existing web-login-required error
before navigating. App BankID alone does not unlock them. `auth_status` reports
only approved children, and never starts a login. The four existing typed REST
routes and reference-page contract remain unchanged; the additional operations
are exposed through MCP.

Calendar access is a separate permission named `get_calendar`. After updating
an existing connector, disconnect and reconnect it in your AI app, then approve
calendar access for the children you choose. Existing connections keep their
previous permissions until you do this.

Try: **“What is happening at school next week, including lessons and school
events?”** You can also ask **“Show both children's calendars for September.”**
The assistant reads each permitted child's calendar separately. Dates default
to this week in Sweden; you can request up to 366 days at a time.

Calendar entries include lessons, scheduled lunch slots and events published by
the school. For the food itself, ask for the lunch menu. An empty result means
both calendar sources responded with no entries. An error means the full
calendar could not be read; it does not mean there is nothing planned.

The agenda protocol is implemented and tested offline. A nonempty school-event
response and the last day's inclusion still need live verification; see the
[calendar protocol notes](../reference/schoolsoft-api.md#full-calendar-agendas).
There is no remote BankID automation, web-session import, absence reporting or
message sending. A permission can be removed without disconnecting another AI app.
This guide describes the technical boundaries; it is not a guarantee of legal
compliance for every use of children's data.

## Route 1: your Render account

A **disk** keeps your login state when the server restarts. Render's persistent disks
require a paid service, and this template uses one server in Frankfurt with a 1 GB
disk. Review the price shown by Render before creating it. Disk-backed deployments
can have brief downtime during updates. [Render disk documentation](https://render.com/docs/disks)

1. Make your own GitHub fork of this repository, using the reviewed connector
   release you intend to run. In Render, choose **New → Blueprint**, connect your
   fork and select its `render.yaml`. A Blueprint is a saved setup recipe. At the
   release-candidate stage, the recipe must come from the branch containing these
   connector files; the default branch may not contain them yet.
2. Review the service name, region, paid plan and disk. The recipe turns automatic
   code deployments off. Enter `SCHOOLSOFT_SCHOOL`: the school identifier from your
   SchoolSoft website address, not your child's name. For an address like
   `https://sms.schoolsoft.se/example-school/...`, enter `example-school`.
3. Enter `SCHOOLSOFT_PUBLIC_URL`, the complete HTTPS address for this service, such
   as `https://your-unique-service.onrender.com`. Include no path after the hostname.
   If Render has not assigned the address yet, use `https://pending.invalid`
   temporarily. Create the service, copy its actual address from the dashboard,
   replace this setting, and deploy again **before logging in**.
4. Render generates `SCHOOLSOFT_ADMIN_PASSWORD` and `SCHOOLSOFT_STORAGE_KEY`
   automatically. Open the service's **Environment** page and save both in your
   password manager. The admin password opens your connector's management page.
   The storage key protects its saved state; do not replace it during an ordinary
   update. Render generates a random 256-bit value for each secret.
   [Render environment variable documentation](https://render.com/docs/blueprint-spec#generating-random-secrets)
5. The blueprint sets `SCHOOLSOFT_PROXY_HOPS` to `1`, because Render's own proxy
   sits in front of your service. How many forwarding entries Render's network adds
   has not been confirmed in a live deployment; after signing in, use the
   **Address check** described under
   [If you change the network setup](#if-you-change-the-network-setup).
6. Wait for the service to become healthy. Open its HTTPS address. You should see
   the connector's owner sign-in page. Enter the admin password there. **Checkpoint:**
   this page is on your own service address, and it accepts the password saved in
   step 4. If the service fails to start, check the environment names and the disk
   mount `/data`; do not post environment values or login URLs in an issue.

Continue with **Connect your school and AI app** below.

## Connect your school and AI app

1. Open your server's address and sign in to the owner page. Start SchoolSoft login
   from that page. It opens the school's login address. Complete BankID yourself in
   the usual way, then return to the owner page.
2. Confirm that login succeeded. You will select children on the consent page
   when connecting each AI app.
   **Checkpoint:** if SchoolSoft rejects the callback address or login remains
   pending, stop here. Repeating an automated test will not fix SchoolSoft's
   redirect policy. Use a supported local option until this is resolved.
3. Copy your connector address: your HTTPS server address followed by `/mcp`, for
   example `https://your-unique-service.onrender.com/mcp`.
4. In the AI app's custom connector/app settings, add that address and choose OAuth
   authentication if asked. Follow the app's current instructions:
   [Claude](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
   or [ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt).
   Do not paste your admin password into a chat or a connector URL.
5. The app sends you to **your server's consent page**. Sign in if needed, check the
   app and requested permissions, select only the children and tools you want
   that app to use, then approve. Approve only a request you started yourself a
   moment ago: the app name on that page is chosen by the app, so a consent link
   that someone sends you should be cancelled. Connect Claude and ChatGPT
   separately if you use both. Return to the AI app and enable the connector in a
   conversation.
6. Ask: **“What is for lunch at school this week?”** Then ask for one selected
   child's next school day. **Checkpoint:** the answer should agree with what you
   see in SchoolSoft. Check that an unselected child cannot be retrieved.

Complete setup in a desktop browser first. After a successful real test, check
whether the same connector appears in your phone app. A missing connector option
usually concerns the AI account or client, not SchoolSoft. Account settings and
availability can differ between desktop, web and mobile.

## Route 2: Docker on your own server

This route assumes a server already runs Docker with Compose and that you can point
a domain name at it. Ask a trusted administrator to help if those steps are new to
you. They will have access to your server, so choose them accordingly. Caddy, included
in this recipe, obtains and renews the HTTPS certificate. Your domain must point to
the server, and inbound ports 80 and 443 must reach it.

1. Download or clone the reviewed release on the server and open a terminal in its
   project folder. For terminal basics, see [computer basics](../getting-started/computer-basics.md).
2. Create a file named `.env` in that folder with these four settings. Replace the
   example domain and school identifier. Generate **two different** random secrets
   with a password manager: the admin password needs at least 32 characters; the
   storage key needs 64 hexadecimal characters or a base64-encoded 32-byte value.
   `openssl rand -hex 32` can generate either value; run it separately for each.
   Do not invent the admin password yourself: the connector never slows down or
   refuses the correct password, so its randomness is what stops guessing, and a
   repetitive value is refused at startup.

   ```dotenv
   CONNECTOR_DOMAIN=school.example.com
   SCHOOLSOFT_SCHOOL=example-school
   SCHOOLSOFT_ADMIN_PASSWORD=replace-with-your-first-random-secret
   SCHOOLSOFT_STORAGE_KEY=replace-with-your-second-random-secret
   ```

   Save both secrets in your password manager. Protect the file with `chmod 600 .env`.
   The repository ignores `.env`, and the Docker build excludes it. Never commit or
   send it. The sample strings above are placeholders and will not make a working
   deployment.

3. Start your copy:

   ```sh
   docker compose -f compose.connector.yaml up -d --build
   ```

4. Open `https://school.example.com`, replacing the domain with yours. You should
   see the owner sign-in page. Then follow **Connect your school and AI app** above.

Only Caddy publishes ports to the internet; the connector's port 3000 stays inside
the Docker network. The Compose file sets `SCHOOLSOFT_PROXY_HOPS` to `1` because
Caddy is the one proxy in front of the connector, and Caddy replaces any forwarding
header a visitor sends with the address it actually saw. A named volume stores state at `/data`, and the connector runs
as an unprivileged user. At startup, a small initialization step fixes ownership
of the `/data` directory and then permanently drops administrator privileges
before loading the connector. It never changes ownership recursively. Keep one connector process per state volume. Do not add
replicas or let another container share this volume.

## Everyday use and recovery

- **The AI says to sign in again:** open your server's owner page and repeat the
  SchoolSoft login. BankID sessions can expire; this does not require reinstalling
  the connector.
- **You have to sign in often:** the owner page lists, under "Sign-in history",
  when SchoolSoft ended earlier sign-ins and how old each one was. Times only; no
  school data. If you want the server to renew the sign-in in the background
  while it runs, add `SCHOOLSOFT_KEEPALIVE=app` to the environment settings and
  restart. It is off by default: with it on, your server contacts SchoolSoft about
  every 12 minutes even when nobody asks anything. It never signs in for you,
  never touches BankID, and stops when SchoolSoft ends the sign-in. SchoolSoft AB
  is not involved in this project and has not approved background requests; see
  [troubleshooting](../getting-started/troubleshooting.md#i-have-to-log-in-with-bankid-too-often).
  `SCHOOLSOFT_KEEPALIVE_QUIET_HOURS=22-6` pauses it at night (server clock, usually UTC).
- **An answer looks out of date:** schedules are remembered in the server's memory
  for 30 minutes and lunch menus for 6 hours, separately for each child, and never
  on disk. Ask the AI for "the latest", or set `SCHOOLSOFT_CACHE=off`. A
  disconnected app, or an app without permission for a child, is refused before
  anything remembered is looked at.
- **"SchoolSoft is pushing back" on the owner page:** SchoolSoft asked for fewer
  requests or kept failing, so the connector sends it nothing until the time shown
  (UTC), then lets one request through to test. Your sign-in is kept; signing in
  again does not help. AI apps and your own app get the same message, and a
  custom app gets `503` with `Retry-After`. All apps share one pace: by default
  at most 20 requests a minute to SchoolSoft (`SCHOOLSOFT_REQUESTS_PER_MINUTE`,
  1 to 60), 10 at once (`SCHOOLSOFT_REQUEST_BURST`, 1 to 20) and 2 at the same
  time (`SCHOOLSOFT_MAX_CONCURRENT_REQUESTS`, 1 to 4). See
  [troubleshooting](../getting-started/troubleshooting.md#schoolsoft-is-asking-for-fewer-requests-or-schoolsoft-has-pushed-back-several-times-in-a-row).
- **Remove one AI app:** revoke its permission on the owner page, then remove the
  connector in that app. Verify that it can no longer retrieve school data. The
  other app should retain its own permission.
- **Restart or update:** preserve the disk and storage key. On Render, manually
  deploy the reviewed revision. With Docker, update your checkout and rerun the
  `up -d --build` command above. Check owner status and ask for lunch again.
- **Lost admin password:** retrieve it from your password manager or your hosting
  account's environment settings. If it may have been exposed, stop the service,
  replace it with a new random value, restart, and revoke existing app permissions.
- **Lost storage key:** saved state cannot be decrypted without it. Restore the
  original key from your password manager. If it is gone, start with a new empty
  state volume and a new key, then reconnect SchoolSoft and each AI app.
- **Restore an old disk backup:** keep the service unavailable while recovering.
  The saved state is encrypted but carries no record of what happened after the
  backup was made, so restoring it brings back every app permission that existed
  then, including ones you revoked later. Prefer starting with empty connector
  state and reconnecting. If you do restore a backup, open the owner page first and
  use **Disconnect everything**, then sign in to SchoolSoft and connect each AI app
  again.
- **Stop using the connector:** revoke app permissions and log out of SchoolSoft
  on the owner page. Delete the service and disk in your hosting account when you
  no longer need them, and review the provider's backup retention settings. With
  Docker, `docker compose -f compose.connector.yaml down` stops the service and
  keeps volumes; add `--volumes` only when you intend to erase its saved state and
  Caddy certificates. Remove saved environment secrets too.

Logging out here cannot delete answers already retained by Claude or ChatGPT, or
backups kept by a hosting provider. Manage those separately in the relevant account.
What **Disconnect everything** keeps, and how to remove the rest, is in
[delete everything](../getting-started/data-handling.md#how-to-delete-everything).

## Your own app or dashboard (REST API)

The connector also answers plain JSON requests under `/api/v1`, for a family
dashboard or a wall display. It is the same data as the AI tools, read-only, and
it uses the **same connection approval**: an app connects like an AI app (it
registers, you approve it on the owner page with the children and tools it may
use, and it receives an access token), then sends that token with each request.
There is no separate password, key or cookie, and nothing is open to anyone
without an approval. Revoking the app on the owner page stops its API access
immediately.

The approval page returns only to Claude's and ChatGPT's addresses and to the
connector's own reference page, so that page is the first app that can connect.
Open `https://<your connector>/reference/` (the owner page links it) and choose
**Connect this page**. You then approve it like an AI app: sign in with the
administrator password, pick the children and untick what it should not read. It
shows one child's week at a time: lessons, lunch and school events, with a child
picker when you approved several. It keeps its connection only while the browser
tab is open. It is a minimal proof that the API is enough for an app, not a
finished app. **Disconnect this page** withdraws its approval, and so does
**Disconnect this app** on the owner page.

`GET /api/v1/session` tells the app whether the connector is signed in to
SchoolSoft, which children it may show and whether SchoolSoft is currently pushing
back (`schoolsoft.portal`, with the time requests resume). When the SchoolSoft
sign-in has expired, every data request answers `409` with a link to your owner
page, so the app can ask you to sign in again rather than showing an error it
cannot explain. While SchoolSoft is pushing back, data requests answer `503` with
`Retry-After` instead; the app should wait, not send you to sign in.
Requests from other websites are refused (the API only serves pages on the
connector's own address for now), and each visitor may make 60 requests a minute.
Error messages come in Swedish or English, following the app's language, or
`SCHOOLSOFT_LANG` (`sv` or `en`) in the environment settings.

A dashboard's first screen for one child is one request:
`GET /api/v1/children/{childId}/overview` answers the week's lessons, the week's
lunch and the next school event together, with the week named by its dates. Each
part says on its own whether it worked, so a hiccup reading the lunch menu does not
blank the timetable, and a part you did not approve for that app says so instead
of being read. Asking again within the next half hour usually sends nothing to
SchoolSoft, because the connector remembers recent answers for a while.

The routes, fields and error types are in the [REST API reference](../reference/rest-api.md),
also as an [OpenAPI document](../reference/openapi.json) for app developers, who can
use the typed client `schoolsoft-agent/client` from this package instead of writing
their own. Apps ask for their access with the resource name
`https://<your connector>/mcp`, the same as the AI apps, even though they only use the
REST API.
Like the rest of the connector, this is tested offline against a synthetic portal;
a real app against a real SchoolSoft sign-in is part of the acceptance test below.

## What still needs a real acceptance test?

Before calling this a supported parent-facing deployment, verify one complete
BankID login with the HTTPS callback, child selection, both AI clients' consent and
tool calls, restart/refresh, separate revocation, deletion, and phone availability.
These require the parent's own accounts and explicit BankID action. Packaging and
mock-provider tests exercise the implementation without exposing school data; they
do not stand in for these checks.

Maintainers run these checks as part of one live pass that starts with `make capture`
(redacted fixtures, reviewed before commit); the order and the checklist are in the
[live session runbook](../development/live-session.md).

### Sign out of the dashboard

Use **Sign out of this dashboard** after managing access, especially on a shared
computer. This signs out that browser only. Your approved AI connections keep
working. Each connected-app entry shows its approved children and expiry date;
use **Disconnect this app** to remove that connection instead.

### If you change the network setup

The connector limits repeated requests per visitor address. Behind a proxy it only
sees the proxy's address, unless it is told how many proxies in front of it may be
believed when they report the visitor's address (the `X-Forwarded-For` header).
That number is `SCHOOLSOFT_PROXY_HOPS`: 0, 1 or 2.

The default is **0**: believe no forwarding header and use the address of whoever
connected. This is the only safe value when nothing you control sits in front, since
otherwise any visitor could claim a new address on every request and sidestep the
limits. Every supplied recipe sets its own value:

| Setup                                         | Value | Why                                                                                                     |
| --------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------- |
| `compose.connector.yaml` (Caddy), Hostinger   | 1     | Caddy is the only proxy and discards forwarding headers sent by visitors                                |
| `compose.cloudflare.yaml` (Cloudflare Tunnel) | 1     | Cloudflare's edge appends the visitor's address last; `cloudflared` is expected to pass it on unchanged |
| `render.yaml`                                 | 1     | Render's proxy is in front; the exact number of entries it adds is unconfirmed                          |
| The image run directly, no proxy              | 0     | nothing in front can be believed                                                                        |

The Cloudflare and Render values follow those providers' documentation and have not
been confirmed in a live deployment of this connector. Check yours: the owner page
shows an **Address check** line with the address your visit appears to come from.
Compare it with your own public address (search the web for "what is my IP"). If
it shows your address, the value is right. If it shows some other address, a proxy
is being counted as the visitor: visitors then share one allowance, which is safe
but coarse, and raising the value by one may fix it. Never raise it beyond the
point where the check shows your own address, because every extra hop is one more
header entry a visitor can forge. Keep the connector's internal port private.

If the value is 0 and a request arrives with a forwarding header, the connector
writes one notice to its log saying so. The notice contains no addresses. The
correct administrator password is never rate limited, so a wrong value cannot lock
you out; it only changes how wrong-password and sign-in floods are counted.

### Repeat the container checks

Developers can run the automated deployment smoke tests without a SchoolSoft
account:

```sh
make connector-smoke
```

It builds `Dockerfile.connector`, starts the image twice with `--network none`,
and removes the containers, volume and image afterwards. Without a running Docker
daemon it prints a skip notice and exits successfully; set
`CONNECTOR_SMOKE_REQUIRE_DOCKER=1` to make a missing daemon an error (CI does).

1. `test/packaging/connector-container.mjs` starts the production entrypoint and
   checks disk ownership, dropped privileges, encrypted persistence, restart and
   shutdown.
2. `test/packaging/connector-flow-container.mjs` replays a parent's whole journey
   inside the image: OAuth discovery, client registration, S256-only PKCE, owner
   login and consent for chosen children and tools, code exchange, MCP
   `tools/list` and tool calls, the REST API (session, children, a schedule, the
   overview, and a refused child, scope and token), the reference page (served with
   its own policy, its callback registering exactly), refresh-token rotation and replay rejection, the
   calendar scope limit, per-child denial, revoking an app from the dashboard and
   the owner-login rate limit. The school portal is a synthetic stand-in
   (`test/packaging/connector-smoke/fake-upstream.mjs`) mounted read-only beside a
   test-only entry script. It is not part of the image, and the BankID link the
   connector shows is parsed, never opened.

The same scenario runs in-process in `make check`
(`test/functional/http-connector-flow.test.ts`). Neither replaces the live
acceptance test above: a synthetic portal proves that the connector's own rules
hold together, not that SchoolSoft accepts the public callback.
