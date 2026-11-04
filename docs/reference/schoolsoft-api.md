# SchoolSoft's unofficial API, as used by this project

SchoolSoft is a trademark of SchoolSoft AB; this document describes observed behaviour of their unofficial API for an independent project SchoolSoft AB is not involved in. Everything here was verified live against a Täby kommun guardian account on 2026-09-06. SchoolSoft can change any of it without notice; the live E2E suite is the canary.

Base URL for a tenant: `https://sms.schoolsoft.se/<slug>/`. The slug is the municipality or school-group tenant (`taby`), not the individual school; schools inside a tenant are `orgId`s.

## Is any of this official?

No. SchoolSoft publishes no API for guardians or students. Its only documented
integration is [SS12000](https://github.com/skolverket/dnp-ss12000-reference-api),
the Swedish standard for exchanging school data between organisations' systems;
SchoolSoft enables it per organisation on request (see e.g.
[Skolon's note](https://support.skolon.com/sv/kb/articles/schoolsoft)). It carries
provisioning data for administrators, not a parent's view of their child, so it
cannot serve this project.

Everything below is the private backend of SchoolSoft's own apps, learned by
observing them, exactly as every community client does
([ssp-node](https://github.com/elias4044/ssp-node),
[SchoolSoft+ Developer](https://developer.ssp.elias4044.com/),
[better-schoolsoft](https://github.com/sebdanielsson/better-schoolsoft)). It can
change without notice; the live E2E suite is the canary. One external
confirmation of the key finding: Google Play lists the guardian app as
`com.schoolsoft.vapp` ("SchoolSoft Vårdnadshavare"), matching the `vApp`
client id that mints guardian tokens.

## Discovery

| Endpoint                                                                        | Auth | Purpose                                                                                                                                      |
| ------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /internal/rest-api/login/schoollist`                                       | none | All ~3400 schools: `{ name, orgId, evaUrl }`. Slug is the first path segment of `evaUrl`. Cached 24 h by `find_school`.                      |
| `GET /<slug>/rest-api/login/methods/?client_id=<id>&usertype=<parent\|student>` | none | Enabled login methods: `3` SAML, `4` app username/password, `11` BankID direct. Täby: SAML + password only; BankID arrives via the SAML IdP. |
| `GET /<slug>/rest-api/login/discovery/document`                                 | none | Always points at the student login route; ignore it.                                                                                         |

## Login (OAuth 2 + PKCE)

| Step       | Request                                                                                                                                                                  | Notes                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorize  | `https://sms.schoolsoft.se/<slug>/react/#/login/<userType>?client_id=<vApp\|eApp>&code_challenge=…&code_challenge_method=S256&redirect_uri=…&state=…&response_type=code` | React SPA. Route must be `parent` for guardians. **`client_id` decides the token's `user_type`**: `vApp` → PARENT, `eApp` → STUDENT. A localhost `redirect_uri` is accepted. `orgid` is ignored for SAML/BankID. |
| SAML start | `GET /<slug>/rest-api/login/<userType>/saml?state&client_id&redirect_uri&lang…`                                                                                          | Redirects to the municipality IdP (Täby: `etjanst.taby.se/wa/auth/saml`), where BankID happens. Shibboleth state cookie records the return path.                                                                 |
| Token      | `POST /<slug>/rest-api/login/token?clientId=<id>&grantType=code&code=…&codeVerifier=…`                                                                                   | Returns `{ access_token (JWT), refresh_token }`. No `expires` field; use the JWT `exp` (15 min). Any `clientId` string is accepted here; only the authorize step's client id matters.                            |
| Refresh    | `POST /<slug>/rest-api/login/token?clientId=<id>&grantType=refresh_token&refreshToken=…`                                                                                 | Rotates the refresh token. Lifetime of the refresh token: unknown (tracked by the E2E snapshot). A wrong-typed token fails here with `Vi kunde inte hitta användaren`.                                           |

JWT claims: `sub` (UUID from `https://schoolsoft.se/core/login`, not a user id), `aud: https://schoolsoft.se/eva-backend`, `user_type`, `login_method` (`SAML`), `client_id`, `iat`, `exp`.

### Direct BankID callback validation

Observed on 2026-11-04: native BankID QR startup and the first pending poll
accept the guardian client with an HTTPS return address, but completion refuses
that address and localhost with `Ingen klient`. The registered
`com.schoolsoft.vapp://` return passes the completion endpoint's client check.
The connector's opt-in QR mode therefore retains this return and PKCE on the
server, displays the base64-encoded SVG from `/login/parent/bankid/secure`, checks
`/secure/collect`, and exchanges the result of `/secure/redirect` only after the
human's approval. The returned state and native URI are verified before a code
is accepted. No identification is automated. See [private network deployment](../deployment/traefik.md).

## Eva API (Bearer token)

The native app's backend. Header: `Authorization: Bearer <access_token>`.

| Endpoint                                                                                         | Returns                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /<slug>/eva/api/v1/parent`                                                                  | `{ guid, userId, firstName, lastName, children: [{ studentId, firstName, lastName, picture, guid, schools: [{ orgId, name, className }], username }] }` |
| `GET /<slug>/eva/api/v1/schools/<orgId>/lunchmenu/<week>`                                        | `[{ week, dayId (Mon=1…Fri=5), dishes: [{ mealType, description }] }]`                                                                                  |
| `GET /<slug>/eva/api/v2/parent/<userId>/schools/<orgId>/news?studentId=<sid>&langId=1`           | `[{ id, title, description, category, author, read, hasAttachment, creDate, toDate, newsConfirm }]`                                                     |
| `GET /<slug>/eva/api/v1/parent/<userId>/schools/<orgId>/messages/inbox`                          | `[{ id, subject, message (preview), isRead, sender{id, firstName, lastName}, date, hasFiles }]`                                                         |
| `GET /<slug>/eva/api/v1/parent/<userId>/schools/<orgId>/messages/<id>`                           | full message with recipients and attachments                                                                                                            |
| `GET /<slug>/eva/api/v1/parent/<userId>/schools/<orgId>/news/calendarevent/next?studentId=<sid>` | next calendar event or `null`                                                                                                                           |

Known 404s (do not exist for guardians): `/eva/api/v1/schools/<orgId>/student/<sid>/lessons`, `/eva/api/v1/schools/<orgId>/parents/<userId>/badge`.

More endpoints (holistic assessments, plannings, staff, profile updates) are catalogued in [sebdanielsson/better-schoolsoft](https://github.com/sebdanielsson/better-schoolsoft). That project is where the guardian header set and the Eva paths were first read before being verified here; no code from it is used.

## Webview REST (session cookies)

The React web app's backend. Needs `JSESSIONID`, `hash` and `usertype` cookies, obtained by the exchange below. The cookie session is bound to one child.

| Endpoint                                                                                                                                                                  | Notes                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /<slug>/eva-apps/auth/login/<userType>` with headers `token: <access_token>`, `userId`, `orgId`, `childInFocus`, `userOS: android`, `language: sw`, `redirecturl: …` | 303 with `Set-Cookie: JSESSIONID, hash, usertype, clientType`. Without `userId`/`orgId`/`childInFocus` it 303s to `…?error=other` with no cookies. |
| `GET /<slug>/rest-api/session`                                                                                                                                            | `{ app, organization{id,name}, userType{id: 2, name}, user{…}, language, theme, … }`. Used to verify a session.                                    |
| `GET /<slug>/rest-api/parent/calendar/lessons/week/<week>`                                                                                                                | `[{ eventId, name, description, startDate, endDate, room, teachingGroup, teacher, dayId, category: "lesson", … }]` for the child in focus          |
| `GET /<slug>/rest-api/parent/ps/assignments/start-page?week=<w>&year=<y>`                                                                                                 | `[{ id, activityId, title, subTitle, read, submissionStatus, resultReportStatus, sortDate }]`                                                      |
| `GET /<slug>/rest-api/parent/ps/assignments/<id>/view` and `/sections`                                                                                                    | assignment detail                                                                                                                                  |

## GUI coverage: what a guardian sees vs. what the APIs expose

Observed 2026-09-06 on Täby with an app-derived cookie session, read-only
(GET, redirects never followed, no forms submitted). The parent web GUI is
the legacy JSP application under `/jsp/student/` (the parent role shares
the student pages); several pages embed React views. Three tiers, plus a
GDPR gate:

| Menu item (sv)          | Page                                                                                                                                 | With our session                      | Tier / API                                                                                                               | Provider in this project                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Startsida               | `right_student_startpage.jsp`                                                                                                        | 200                                   | JSP (embeds React)                                                                                                       | —                                                        |
| Aktuellt / Nyheter      | `right_student_news.jsp`                                                                                                             | 200                                   | JSP; news also via Eva `news`                                                                                            | api (Eva news)                                           |
| Kalender                | `right_student_week_calendar.jsp`                                                                                                    | 200                                   | JSP + React `#/parent/calendar`; REST `/rest-api/parent/calendar/lessons/week/{w}`, `/calendar/settings`                 | api (REST calendar)                                      |
| Verksamhetslogg         | `right_student_blogpost.jsp`                                                                                                         | 200                                   | JSP only                                                                                                                 | api (`POST /rest/blogpost/getbyloggedinuser`, read-only) |
| Matsedel                | React `#/student/lunchmenu`                                                                                                          | —                                     | Eva `lunchmenu`                                                                                                          | api (Eva lunch)                                          |
| Bokningar               | `right_student_timebooking.jsp`                                                                                                      | 200                                   | JSP only (booking = form post)                                                                                           | browser (`get_bookings`)                                 |
| Meddelanden             | `right_student_message.jsp`                                                                                                          | 200, 2 POST forms                     | JSP; inbox also via Eva `messages`; **send = form post**                                                                 | api (Eva inbox); send: not yet                           |
| Scheman / Provschema    | `right_student_schedule.jsp`, `right_student_test_schedule.jsp`                                                                      | 200                                   | JSP; lessons also via REST calendar                                                                                      | api (REST calendar)                                      |
| Kontaktlistor           | `right_student_class.jsp`                                                                                                            | 200                                   | JSP only                                                                                                                 | browser (`get_contacts`)                                 |
| Ämne (subject rooms)    | `right_student_subject.jsp` (menu) · React `#/parent/subjectrooms` → `/rest-api/parent/ps/subjectroom/all`, `/{activityId}/teachers` | 200                                   | webview REST (app session); the JSP menu is only read for the criteria page's `requestid` (differs from `activityId`)    | api (`get_subject_rooms`)                                |
| Planeringar & uppgifter | `right_student_planning.jsp`                                                                                                         | 302 → React error                     | REST `/rest-api/parent/ps/planning_parts/start-page`, `/ps/assignments/start-page`                                       | api (REST ps)                                            |
| Uppgifter & resultat    | `right_student_test.jsp`                                                                                                             | 200                                   | JSP; assignments via REST `ps/assignments`                                                                               | api (REST ps assignments)                                |
| Forum                   | `right_student_forum_list.jsp`                                                                                                       | 302 → React error                     | unknown                                                                                                                  | —                                                        |
| Frånvaroanmälan         | `right_student_absence.jsp`                                                                                                          | 200, 4 POST forms                     | JSP form post; REST `POST /rest-api/parent/absence-notice` also exists (GET → 405)                                       | api (`report_absence`), unverified body; preview by default                                     |
| Ledighetsansökan        | `right_student_studentleave.jsp`                                                                                                     | 200, 1 POST form                      | JSP form post                                                                                                            | not yet (write spec)                                     |
| Mina tider (fritids)    | `right_parent_preschool_schedule_new.jsp`                                                                                            | 200, 1 POST form                      | JSP form post                                                                                                            | not yet                                                  |
| Alla filer & länkar     | `right_student_library.jsp`                                                                                                          | 200                                   | JSP only                                                                                                                 | browser (`get_files`)                                    |
| Betyg                   | `right_student_gradesubject.jsp`                                                                                                     | 302 → `right_student_app_blocked.jsp` | **GDPR gate** (see below); 200 with a web-login session                                                                  | browser + web session (`get_grades`)                     |
| Elevdokument            | `right_student_review.jsp`                                                                                                           | 302 → gate                            | GDPR gate; web session: `table.longlist` "Rubrik / Skapad av / Datum", rows link to `?action=view&archive=1&requestid=N` | browser + web session (`get_student_documents`)          |
| Oanmäld frånvaro        | `right_parent_absence_message.jsp`                                                                                                   | 302 → gate                            | GDPR gate; web session: alert message or a list                                                                          | browser + web session (`get_unreported_absence`)         |
| Rapport (närvaro)       | `right_student_absence_student.jsp`                                                                                                  | 302 → gate                            | GDPR gate; web session: summary table + a POST filter form (weekFROM/weekTO, never submitted)                            | browser + web session (`get_attendance_report`)          |
| Kriterier               | `right_student_ability.jsp?subject=ID&schooltype=7`                                                                                  | 302 → gate                            | GDPR gate; web session: ability matrix per subject (`subject` = `requestid` from Ämne)                                   | browser + web session (`get_assessment_criteria`)        |
| Avstämning              | `right_student_gradeprognosis.jsp` → React, fetches `/rest-api/parent/gradeprognosis/options/reconciliationdates`                    | 302 → gate                            | GDPR gate; the REST call answers with the web-session cookies                                                            | api + web session (`get_grade_prognosis`)                |
| Översikt                | `right_student_lesson_status.jsp`                                                                                                    | 302 → gate                            | GDPR gate                                                                                                                | not yet                                                  |

Also live: `/rest-api/parent/holistic_assessment/rows`, `/rest-api/parent/nationaltests`,
Eva `/eva/api/v1/parent/{uid}/profile` (contains the guardian's personal data).

Consequences:

- JSON where it exists (Eva, webview REST incl. the subject-room endpoints
  behind the React "Ämne" view, one legacy `/rest` read-only POST for the
  activity log). Contact lists, bookings and files are read through the
  headless browser provider (see the Provider column and
  `docs/development/architecture.md`, "Portal adapter").
- **Page structure is declared once** (`src/providers/schoolsoft/portal/pages.ts`: path,
  gate, anchors). `schoolsoft-agent browser verify` and the live structure
  suite check the anchors and compare each page's structural fingerprint
  (hash of its tag/id/class skeleton, recorded by `make fingerprints`), so a
  SchoolSoft redesign shows up as named drift, page by page.
- **Write operations** exist as JSP form posts (absence, leave, fritids
  times, messages, bookings) and, for absence, as a React REST endpoint.
  Mapping them means reading each form's fields; none were submitted here.
- **Grades, student documents, absence and criteria are behind the GDPR
  gate** ("requires a login to be shown, log in again"): SchoolSoft refuses
  them to any app-derived session. `schoolsoft-agent login --web` opens the
  normal web login in a headed browser (the user does BankID as usual) and
  keeps that browser's cookies as a second, encrypted session. Gated pages
  are then read through the browser provider with those cookies, and the
  Avstämning REST call with the same cookie header. The web session is
  independent of the API token session and expires on inactivity; the
  errors say when to run `login --web` again.
- **The web session has its own child in focus**, separate from the app
  session's `childInFocus`. `GET /rest-api/parent/header/parent` (web
  cookies) returns `{ children[], currentChildId, currentOrgId }`; the
  portal's child menu switches with
  `PUT /rest-api/parent/header/parent?childId=N&orgId=M` (no body). Gated
  reads align the web child with the requested `child_id` first; that PUT
  is the only non-GET the web session ever sends, and it changes session
  state only. Non-gated browser pages keep using the app cookies, whose
  child in focus the API session controls.
- Loading `Login.jsp` (e.g. via the tenant root) invalidates the cookie
  session; probes must never follow redirects.

## Data only reachable through the web pages

Everything below has no JSON endpoint SchoolSoft's apps use, so the browser
provider loads the legacy JSP page with the user's cookies and runs an
in-page extractor (`src/providers/schoolsoft/portal/extractors.ts`). Pages
are declared once in `portal/pages.ts` (path, whether the GDPR gate applies,
the anchors a healthy page must contain); `browser verify` and the live
structure suite check those anchors and a structural fingerprint per page.
Every visit is a GET; the session guard aborts any other verb.

### Reachable with the app session

| Page (menu item)         | Path                            | What is extracted                                                                                                                                                                                     | Result shape                                                               |
| ------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Kontaktlistor            | `right_student_class.jsp`       | `#contAll_content`: `.h3_bold` group headings, then table rows with `.display-info` blocks (`#name`, `#email a[href^=mailto]`, `#phone`, `#role`/`#type`)                                             | `ContactGroup[] = [{ title, people: [{ name, role, email?, phone? }] }]`   |
| Bokningar                | `right_student_timebooking.jsp` | `#timebook_con_content .accordion-group`: heading text, `.accordion-heading-date-wide`, `[id^=description]`, `.inner_right_info` label/value pairs; status inferred from words (bokad, stängd, ledig) | `Booking[] = [{ title, description?, slots: [{ start, status }], info? }]` |
| Alla filer & länkar      | `right_student_library.jsp`     | `#library_con_content`: `.h3_bold` category headings, `td > a[href]`; `file_download.jsp` or a document extension means `file`, else `link`                                                           | `PortalFile[] = [{ name, url, type: "file" \| "link", category? }]`        |
| Ämne (subject menu only) | `right_student_subject.jsp`     | `#subject_menu a[href*=requestid]`: subject name and its `requestid`. Only read to resolve the id the criteria page needs (see below); subject rooms themselves come from the REST                    | `{ subject, url, subjectId }[]`                                            |

### Behind the GDPR gate (web-login session required)

SchoolSoft answers these with `302 → right_student_app_blocked.jsp` ("requires a
login to be shown, log in again") for any app-derived session, and with 200
for a session created by the normal web login. All five are read with the
generic table extractor and return the same shape:

```
TablePage = { title, message?, sections: [{ heading?, headers: string[], rows: [{ cells: string[], url? }] }] }
```

The extractor takes `#content .h1` as the title, `.alert .message-text` as the
message, and every table outside `#top-box`, forms and `.h2_box` as a
section; header rows are `tr.longlistheader`, `th` rows or a single
`td.header` (which becomes the section heading, also when it sits in its own
one-row table right before the list); the first non-`javascript:` link in a
row becomes `url`.

| Page (menu item)  | Path                                                | Observed structure (Täby, 2026-09-06)                                                                                                                                                                                                                                  | Caveats                                                                                                                                     |
| ----------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Betyg             | `right_student_gradesubject.jsp`                    | Title "Betyg"; no tables until the school publishes grades (`sections: []`)                                                                                                                                                                                            | An empty result is normal for younger children; the session-warning table under `#top-box` is excluded on purpose.                          |
| Elevdokument      | `right_student_review.jsp`                          | `#review_cont` (current documents, empty here); a one-row table with `td.header` "Arkiverade elevdokument", then `table.longlist` with header "Rubrik / Skapad av / Datum" and `tr.value` rows linking to `right_student_review.jsp?action=view&archive=1&requestid=N` | The document body behind `?action=view` is not read yet.                                                                                    |
| Oanmäld frånvaro  | `right_parent_absence_message.jsp`                  | Either `.alert .message-text` "Det finns ingen oanmäld frånvaro att ta del av" or a list                                                                                                                                                                               | Only the empty state has been observed live.                                                                                                |
| Rapport (närvaro) | `right_student_absence_student.jsp`                 | A `form[name=select]` with `weekFROM`/`weekTO` selects (POST, never submitted) and one `table.table-striped.table-condensed.table-pointer` summary for the default range                                                                                               | The default range is what the page shows on load; choosing another range would need the POST, which is a write-shaped request and not done. |
| Kriterier         | `right_student_ability.jsp?subject=ID&schooltype=7` | Without `subject` the page renders nothing. With it: `.alert` publication message, an options form, `table.table-condensed` with `tr.longlistheader` and one `tr` per ability with a cell per level                                                                    | `ID` is the JSP `requestid` (see structural facts). `schooltype=7` is grundskola; other codes were not probed.                              |
| Avstämning        | `right_student_gradeprognosis.jsp` → React          | The page is a React root that fetches `GET /rest-api/parent/gradeprognosis/options/reconciliationdates`; that call answers the web cookies directly, so no page load is needed                                                                                         | Response observed as an empty array for these children; the item shape is unknown.                                                          |
| Översikt          | `right_student_lesson_status.jsp`                   | Gated; not mapped                                                                                                                                                                                                                                                      | Candidate for a later capability; `make capture` records a redacted copy for its fixture.                                                 |

### Structural facts that shape the code

- **Two child selections.** The app session's child is set by the cookie
  exchange (`childInFocus`); the web session has its own, changed by the
  portal's child menu: `GET /rest-api/parent/header/parent` (web cookies)
  returns `{ children: [{ id, firstName, lastName, schools: [{ orgId, className, schoolName, parentAllowedAccess, studentActive }] }], currentChildId, currentOrgId, logoutURL }`;
  `PUT /rest-api/parent/header/parent?childId=N&orgId=M` (no body) switches
  it. Gated reads align the web child with the requested `child_id` first.
  That PUT is the only non-GET the web session sends; it changes session
  state, never school data.
- **Keepalive touch.** The opt-in keepalive (`SCHOOLSOFT_KEEPALIVE=all`) touches
  the web session with that same header GET and nothing else, because the
  portal's own pages request it on every view. A 401/403, or a 200 whose body
  is not the header JSON, is treated as a lost web session (the 401 was seen
  once, see the log below; the rest is an assumption). Whether the GET resets
  SchoolSoft's inactivity timer is **not measured**; the session history in
  `auth_status` exists to find out.
- **Two subject ids.** The REST subject rooms
  (`/rest-api/parent/ps/subjectroom/all`) carry `activityId`; the criteria
  page takes the JSP subject menu's `requestid`. They are different numbers
  (disjoint sets on the same child). `get_assessment_criteria` therefore
  takes a subject name and resolves the `requestid` from the menu.
- **The subject menu only renders under the app session.** Under the web
  session the same JSP page shows SchoolSoft's React sidebar instead and
  `#subject_menu` is empty. The criteria flow reads the menu with the app
  cookies and loads the criteria page with the web cookies, in that order.
- **Web sessions expire on inactivity.** SchoolSoft's web UI has an
  inactivity logout; a gated call then redirects to `Login.jsp`, which the
  guard turns into a `SessionLostError` that names `login --web`. The app
  session is unaffected. Loading `Login.jsp` with the app cookies would
  invalidate them, which is why the guard never follows that redirect.
- **Selectors are ids, not classes,** for contacts, bookings and files
  (`#contAll_content`, `#timebook_con_content`, `#library_con_content`); the
  gated pages are read by table semantics only. A SchoolSoft redesign would
  therefore break the three id-keyed extractors first, and `browser verify`
  names which.

## Response shapes not listed above

Observed live on Täby, 2026-09-06, field names only; values redacted.

| Call                                                              | Shape                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /rest-api/parent/ps/subjectroom/all` (app cookies)           | `[{ activityId, subject, groupNames: string[], color, isPreSchool, access, isSubjectRoom, hiddenForStudents }]`                                                                                                                                                                                                                                                                                       |
| `GET /rest-api/parent/ps/subjectroom/<activityId>/teachers`       | `[{ id, firstName, lastName, role }]`                                                                                                                                                                                                                                                                                                                                                                 |
| `GET /rest-api/parent/ps/subjectroom/<activityId>/entities`       | `[]` here; the React view lists plannings and assignments in it                                                                                                                                                                                                                                                                                                                                       |
| `GET /rest-api/parent/ps/subjectroom/unread_entities`             | `{ assignments, plannings, results, sum }` (numbers)                                                                                                                                                                                                                                                                                                                                                  |
| `GET /rest-api/parent/holistic_assessment/rows` (app cookies)     | `[{ title, subTitle, color, subjectWarning, updatedAt, friendlyUpdatedAt, publishedAt, friendlyPublishedAt, holisticAssessmentId, published, read }]`; `…/overview` gives `{ isActionPlan, actionPlanTitle, actionPlanText }`. Not used yet (candidate capability).                                                                                                                                   |
| `POST /rest/blogpost/getbyloggedinuser` (app cookies, read-only)  | Body `{ userId: -1, userType: -1, week: -1, subjects: [], archives: [], tags: [], freeText: "", goalIds: [], groupOrStudent: "", offset, row_count }`; rows `[{ blogPost: { id, creDate (epoch ms), name, description (HTML) }, author, recipientsNamesString, numberOfComments, content: [{ contentBlockDTOList: [{ blockType: "text" \| "image" \| …, contentBlocks: [{ content (HTML) }] }] }] }]` |
| `GET /rest-api/parent/gradeprognosis/options/reconciliationdates` | Array; empty for these children, item shape unknown                                                                                                                                                                                                                                                                                                                                                   |
| `GET /eva/api/v1/parent/<userId>/schools/<orgId>/messages/<id>`   | Full message: the inbox fields plus `recipients` and `attachments`; exact field list not recorded                                                                                                                                                                                                                                                                                                     |
| `GET …/news/calendarevent/next?studentId=<sid>`                   | One event or `null`; field list not recorded                                                                                                                                                                                                                                                                                                                                                          |
| `GET /rest-api/parent/ps/assignments/<id>/view` and `/sections`   | `view`: the assignment; `sections`: its parts (may 404 → returned as `null`); field lists not recorded                                                                                                                                                                                                                                                                                                |

The three "not recorded" rows are the next things to capture, redacted, the
next time the live suite runs with a discovery probe.

## Observation log

Dated, so the provenance of every claim above is clear. Add a line whenever
something is learned live; never paste data, only shapes and behaviour.

| Date       | Observation                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-06 | Guardian login needs route `parent` and client id `vApp`; `eApp` mints STUDENT tokens ("Vi kunde inte hitta användaren").                            |
| 2026-09-06 | Cookie exchange needs `userId`, `orgId`, `childInFocus` headers; cookies bound to one child. Access token 15 min; refresh rotates.                   |
| 2026-09-06 | SchoolSoft accepts `http://127.0.0.1:43117/callback` as `redirect_uri`.                                                                              |
| 2026-09-06 | GUI inventory: three tiers (Eva, webview REST, JSP) plus the GDPR gate; write actions are JSP form posts (not mapped).                               |
| 2026-09-06 | Web-login cookies (3, incl. `JSESSIONID`) pass the gate on all gated pages; the IdP may continue in a popup, so all tabs are watched.                |
| 2026-09-06 | The web session has its own child in focus (`header/parent` GET + PUT); under web cookies the JSP subject menu is empty (React sidebar instead).     |
| 2026-09-06 | Subject rooms are served by `/rest-api/parent/ps/subjectroom/*` to the app session; `activityId` ≠ JSP `requestid`.                                  |
| 2026-09-06 | Web session returned 401 on `header/parent` hours after capture: consistent with an inactivity logout (not re-verified before the session was lost). |

## What ssp-node gets wrong for guardians

`@elias4044/ssp-node` is a student client. It hardcodes the `student` login route, the `eApp` client id, the student cookie-exchange path, and sends none of the guardian headers. Its HTTP helper also follows 301, 302, 307 and 308 by sending the same method again, with the same cookies, to any host. This project used it only for its HTTP helpers and as the in-memory token/cookie holder, and dropped it in E6.3 ([spec](../planning/specs/2026-09-26-drop-ssp-node.md)); the provider's `net.ts` and `tokens.ts` do that work now.

## Error strings worth recognising

| Text                                                            | Meaning                                                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Vi kunde inte hitta användaren … inte aktiv på den här skolan` | The identity resolved as the wrong user type (student route or `eApp` client id), or the account is not active at that tenant. |
| `Ingen aktiv inloggnings-session` (token endpoint, 404)         | The code is invalid or already used.                                                                                           |
| 303 to `…?error=other` from the exchange                        | Missing or wrong `userId`/`orgId`/`childInFocus` headers, or a dead token.                                                     |

## Full calendar agendas

`get_calendar` reads both cookie-authenticated endpoints for the selected child:

| Method and path | Response |
| --- | --- |
| `GET /<slug>/rest-api/parent/calendar/lessons/agenda?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` | Bare array of lessons, including scheduled lunch slots |
| `GET /<slug>/rest-api/parent/calendar/event/agenda?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` | Bare array of school events |

Protocol evidence: [upstream SchoolSoft adapter implementation](https://github.com/kolplattformen/skolplattformen/blob/0c2db8ff154c26d26d001a8f84e660dc0ecf9f94/libs/api-schoolsoft/lib/api.ts).
Its recorded event agenda was empty. Our nonempty event fixtures are synthetic,
not evidence of live compatibility for every school.

Entries require `eventId`, `name`, `startDate`, `endDate` and `allDay`;
`description`, `room`, `teachingGroup`, `teacher` and `category` are optional
text. The provider maps each entry to a `CalendarEvent` (`kind: "lesson" |
"event"` by source; equal IDs across sources are not deduplicated). Date-only
values stay dates; local timestamps get the offset Stockholm had at that time.
Other fields are not passed on. An entry that does not fit this shape is
`response_drift`, never a partial calendar (see the
[typed domain model](../planning/specs/2026-09-26-typed-domain-model.md)).

The assistant-facing range is inclusive, accepts at most 366 days and defaults
to Monday–Sunday in Stockholm. Both dates must be supplied together. Dates are
sent unchanged to the agenda endpoints. End-date inclusivity and a nonempty
school-event response remain live acceptance checks; no claim of verified
completeness is made before those checks.

The provider reads the sources sequentially and validates each response.
Either failure fails the whole operation. Session recovery restarts the complete
read, avoiding mixed results from before and after recovery. Connector
authorization is checked before each request and before releasing the result.

### Live calendar acceptance

After logging in manually, choose a range with a visible school event and
entries on its final day. Run:

```sh
schoolsoft-agent get-calendar --start-date 2026-09-07 --end-date 2026-09-13 --pretty
```

Replace the dates with that range. Compare lesson and school-event counts,
times, all-day entries and the final day's entries with SchoolSoft's calendar.
Also check a one-day range and an event spanning the boundary. Keep payloads
private; record only whether each comparison passed.

An optional automated probe uses an existing session and prints counts only:

```sh
SCHOOLSOFT_E2E=1 SCHOOLSOFT_CALENDAR_START=2026-09-07 SCHOOLSOFT_CALENDAR_END=2026-09-13 ./node_modules/.bin/tsx --test test/e2e/08-calendar.e2e.test.ts
```

This probe checks response shape, not visual agreement with SchoolSoft. It never
starts or completes BankID. Run it only against your own guardian account.
