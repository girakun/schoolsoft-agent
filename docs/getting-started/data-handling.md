# How your family's data is handled

This page explains, in plain language, what schoolsoft-agent saves, where it saves it, how long it keeps it, and who receives your children's school information. Read it before you connect an account.

It describes version 0.3.0 and the fork's read-only network tools update of 4 November 2026. It covers all three ways to use the project:

- **On your own computer:** the command line (`schoolsoft-agent`), the MCP server that assistants such as Claude Desktop, Claude Code or OpenCode start (`schoolsoft-agent-mcp`), and the Claude Desktop extension, which runs that MCP server.
- **On your own server:** the [parent-hosted connector](../deployment/connector.md) (`schoolsoft-agent-http`) that Claude or ChatGPT reaches over the internet.

> This is an independent project. It is not made, approved or run by SchoolSoft AB or BankID. This page describes the software, not your legal duties. It does not replace the terms of your school, SchoolSoft or your AI provider.

## In short

- **Your AI assistant receives the school information you ask for.** Your assistant's company (for example Anthropic for Claude or OpenAI for ChatGPT) handles it under its own terms, and it may keep your conversations.
- **Your SchoolSoft login is saved encrypted** on the computer or server that runs the project. Nobody else runs a copy for you.
- **Schedules, menus and other answers are not saved to disk.** Some are kept in memory for a short time and are gone when the program stops.
- **The project author receives nothing.** There is no telemetry, no crash reporting, no analytics and no central server. The program itself contacts only SchoolSoft.
- **Nothing changes at SchoolSoft unless you turn it on.** Reporting an absence is the only action that changes your school data there. It is off until you enable it, and it shows a preview first.
- **You can delete everything.** `logout` removes the saved login. Deleting one folder removes everything else. See [delete everything](#how-to-delete-everything).

## Who is involved

| Who                        | What they see                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **You**                    | Everything. You log in with BankID yourself.                                                                                                                             |
| **The computer or server** | The saved login and, while it works, the answers from SchoolSoft. If you use the connector, the server is rented from a hosting company.                                 |
| **SchoolSoft**             | Your login and the requests you make, as when you use the SchoolSoft app. See [what reaches SchoolSoft](#what-reaches-schoolsoft).                                       |
| **Your AI provider**       | The answers the assistant fetches for you, and what you type in the chat. See [what your AI assistant receives](#what-your-ai-assistant-receives).                       |
| **Your hosting provider**  | Connector only. The company that runs your server, and anyone who administers it, can reach the data while the server uses it. Encryption on disk does not prevent that. |
| **The project author**     | Nothing. The author does not run your copy and has no account, key or password for it.                                                                                   |

## What is saved on your computer

This applies to the command line, the MCP server and the Claude Desktop extension. They share the same files.

### Where the folder is

| Computer | Folder                                                                                   |
| -------- | ---------------------------------------------------------------------------------------- |
| Mac      | `~/Library/Application Support/schoolsoft-agent`                                         |
| Windows  | `%APPDATA%\schoolsoft-agent` (usually `C:\Users\<you>\AppData\Roaming\schoolsoft-agent`) |
| Linux    | `~/.config/schoolsoft-agent` (or `$XDG_CONFIG_HOME/schoolsoft-agent`)                    |

The login files are in a `state` folder inside it. Two settings can move them: `SCHOOLSOFT_CONFIG_DIR` moves the whole folder, and `SCHOOLSOFT_STATE_DIR` moves only the `state` folder. The Claude Desktop extension uses the folder chosen as **Config directory** in its settings. Run `npx -y schoolsoft-agent doctor` to see which folder your setup uses.

Very early versions used `~/.schoolsoft-mcp`. `doctor --fix` moves an old login from there.

### The files

| File                        | What is in it                                                                                                                                                                                                                                                                                                          | Protection                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `config.json`               | Your settings: the school's short name from its SchoolSoft address, SchoolSoft's number for the school, and which school you used last. Also any settings you added yourself, such as the cache or keepalive.                                                                                                          | Not encrypted. Says which school you use; nothing else about you.                          |
| `schools.json`              | A copy of SchoolSoft's public list of schools, used to find your school by name. Fetched again when it is older than 24 hours.                                                                                                                                                                                         | Not encrypted. Public information.                                                         |
| `state/session.enc`         | Your SchoolSoft login: the access and refresh tokens (digital keys that let the program read on your behalf) and when they expire. Also your SchoolSoft user number and name, and each child's first and last name, student number, school and class. If you used `login --web`, also the cookies from that web login. | Encrypted (AES-256-GCM) with the key in `key.bin`.                                         |
| `state/key.bin`             | The random encryption key for the three `.enc` files. Created on first use.                                                                                                                                                                                                                                            | Readable only by your user account (on Mac and Linux).                                     |
| `state/session-history.enc` | Sign-in history: when a login started, was renewed, was used and ended, and how many times. Timestamps and counts only. No tokens, no cookies, no names, no child numbers. At most 300 events and 50 ended sessions.                                                                                                   | Encrypted with the key in `key.bin`. Names the school, nothing about you or your children. |
| `state/login-pending.enc`   | A short note while a login is running: when it started, the program's process number, the SchoolSoft login address, and why it failed if it did. It is removed when a login succeeds and ignored after six minutes.                                                                                                    | Encrypted with the key in `key.bin`. Contains no password or token.                        |

On Mac and Linux, the program creates every one of these files, and the folders they are in, so that only your own user account can read them. On Windows, they rely on the normal protection of your user folder.

Versions up to 0.3.0 kept the sign-in history and the login note unencrypted, as `session-history.json` and `login-pending.json`. A newer version encrypts the history the next time it records something and then deletes the old file. It deletes an old login note the next time a login starts or ends.

**About the encryption.** The key file sits in the same folder as the files it protects. That protects them if an `.enc` file alone is copied somewhere. It does not protect them from someone, or some program, that can read your whole user folder. Treat the folder like your browser's saved passwords.

**If you use several schools.** When your children are in schools with different SchoolSoft addresses, each school is a separate account. `config.json`, `session.enc` and `session-history.enc` keep one entry per school, side by side. `logout` removes only the current school's login. The encryption key, the login note and the school list are shared.

**The hidden browser.** Contact lists, bookings, shared files, grades, student documents and absence pages need an optional browser (`browser install`). The program starts a fresh, private browser for each question and closes it afterwards. It keeps nothing from it, and it blocks every request from that browser that could change something at SchoolSoft. For `login --web`, it opens a visible browser window. You log in there yourself. The program waits for the SchoolSoft page to appear, then copies only SchoolSoft's cookies into `session.enc` and closes the window.

## What is saved on your connector server

The connector keeps its files in its data folder (`/data` unless `SCHOOLSOFT_STATE_DIR` says otherwise), on the disk or volume you set up.

| File           | What is in it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.enc`  | Your SchoolSoft login, with the same contents as on a computer (tokens, your name and user number, your children's names, student numbers, schools and classes). The connector never makes a web login, so it holds no web cookies.                                                                                                                                                                                                                                                                                                                                            |
| `history.enc`  | Sign-in history, as on a computer: timestamps and counts only. The owner page shows it under "Sign-in history".                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `oauth.enc`    | The AI apps you connected: each app's name and return address, the children and tools you approved, and when each approval ends. Access tokens and one-time codes are stored only as fingerprints (hashes), not as the tokens themselves. While a connection request waits for your approval, it also stores a scrambled code for the network it came from (for fairness limits). The code cannot be turned back into the network address, because the key that makes it exists only in the running program's memory. The request is removed once you answer it or it expires. |
| `identity.enc` | Which guardian owns this connector: the school's short name and your SchoolSoft user number. It stops someone else's login from taking over your server.                                                                                                                                                                                                                                                                                                                                                                                                                       |

The `.enc` files are encrypted with AES-256-GCM using your **storage key** (`SCHOOLSOFT_STORAGE_KEY`). The key is kept in your hosting account's settings, not on the disk. A copy of the disk without the key cannot be read. The connector serves one guardian and one school. Its session and history files use the same per-school layout as on a computer.

The connector does not use `config.json`, `key.bin` or a login note: it keeps a SchoolSoft login that is running in memory. Calling `find_school` caches the public school directory in `schools.json` on the connector's disk, under the same private file permissions. It contains school names and identifiers, not your family's data.

## What is only kept in memory

These things are never written to disk. They disappear when the program stops or restarts.

- **Recent answers (the read cache).** To avoid asking SchoolSoft the same thing twice in one conversation, some answers are kept for a short time:

  | Information                                           | Kept for   |
  | ----------------------------------------------------- | ---------- |
  | Lunch menu, subjects and teachers, class contact list | 6 hours    |
  | Shared files and links                                | 1 hour     |
  | Schedule and calendar                                 | 30 minutes |
  | News, assignments, activity log                       | 10 minutes |

  Messages, bookings, grades, student documents, absence and attendance are **never** kept. Each copy belongs to one school, one guardian and one child. All copies are thrown away when you log in, log out, switch child or lose the SchoolSoft session. At most 200 answers are kept. Ask for "the latest" to skip it, or set `SCHOOLSOFT_CACHE=off` to turn it off. The command line runs one command and exits, so in practice it only helps the MCP server and the connector.

- **SchoolSoft's app cookies.** SchoolSoft needs cookies tied to one child for most reads. The program gets them with the saved token when it first needs them and when you switch child. It does not save them.
- **The request budget.** Counters of how many requests went to SchoolSoft recently, and whether SchoolSoft asked the program to slow down. See [what reaches SchoolSoft](#what-reaches-schoolsoft).
- **Keepalive timers**, if you turned keepalive on.
- **Connector only:** your sign-in to the owner page (a random cookie, valid 30 minutes; a restart signs you out), counters that limit how often each network address may try things, and a login that is waiting for BankID.

## How long things last

| What                                          | How long                                                                                                                                                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your SchoolSoft login                         | Until SchoolSoft ends it, or you log out. SchoolSoft decides. Its access token lasts about 15 minutes and is renewed automatically with the refresh token. How long the refresh token lasts is not known yet. The sign-in history exists to find out. |
| The web login (`login --web`)                 | Until SchoolSoft ends it after a period without use. The exact time is not known yet.                                                                                                                                                                 |
| A login you started                           | You have 5 minutes to finish BankID. The login note is ignored after 6 minutes.                                                                                                                                                                       |
| The public school list                        | Fetched again after 24 hours.                                                                                                                                                                                                                         |
| Recent answers in memory                      | 10 minutes to 6 hours, see above.                                                                                                                                                                                                                     |
| Sign-in history                               | Kept after logout, on purpose: a login's lifetime is only known once it has ended. The last 300 events and 50 ended sessions are kept. Delete the folder to remove it.                                                                                |
| Connector: an AI app's approval               | 30 days from when you approved it. Then the app must connect again and you approve again.                                                                                                                                                             |
| Connector: an AI app's access token           | 5 minutes. The app renews it with a refresh token that changes every time. If an old refresh token is used again, that app's approval is cancelled.                                                                                                   |
| Connector: approval request and one-time code | 10 minutes to answer an approval request. A one-time code is valid 1 minute.                                                                                                                                                                          |
| Connector: owner page sign-in                 | 30 minutes, in memory.                                                                                                                                                                                                                                |

**Keepalive is off unless you turn it on.** With `SCHOOLSOFT_KEEPALIVE=app`, a long-running MCP server or connector renews the SchoolSoft token a few minutes before it expires (about every 12 minutes) even when nobody asks anything. With `all`, a computer also keeps the web login alive with one small request every 10 minutes (you can choose 5 to 120). Keepalive never logs in for you and never touches BankID. It stops as soon as SchoolSoft ends the session. `SCHOOLSOFT_KEEPALIVE_QUIET_HOURS` pauses it at night. The command line never runs it.

## What your AI assistant receives

When the assistant uses one of the tools, the answer goes to the assistant app. For Claude, ChatGPT and most other assistants, that means the company's servers. They process it under their own terms and your account's data settings, and they may keep your conversations. This project cannot delete anything there. Manage that in your AI account.

The assistant also sees what you write in the chat, such as your child's name or the reason for an absence.

### On your computer

Each tool returns one kind of information. The assistant only fetches what it needs for your question.

| Kind of information    | Tools                                                                                      | What the answer contains                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who you are            | `login`, `list_children`, `auth_status`                                                    | Your name, your children's first names and student numbers, their school and class. `auth_status` also shows the sign-in history (times and counts). |
| Schedule and calendar  | `get_schedule`, `get_calendar`                                                             | Lessons with subject, time, room, group, teacher and notes. School events.                                                                           |
| Lunch                  | `get_lunch_menu`                                                                           | The school's menu.                                                                                                                                   |
| School work            | `get_assignments`, `get_assignment_detail`, `get_subject_rooms`, `get_assessment_criteria` | Homework, tests and projects. Subjects, groups and teachers. Assessment criteria, which need `login --web`.                                          |
| News and posts         | `get_news`, `get_activity_log`                                                             | School news. Teachers' posts, with their recipients and comments.                                                                                    |
| Messages               | `get_messages`, `get_message`                                                              | Your SchoolSoft inbox: subject, start of the text, sender. `get_message` returns the full text and the recipients.                                   |
| Other families         | `get_contacts`                                                                             | The class contact list: classmates and, where the school publishes them, other guardians, with e-mail and phone.                                     |
| Meetings and files     | `get_bookings`, `get_files`                                                                | Bookable meetings such as development talks. Names and links of files the school shares.                                                             |
| Grades and documents   | `get_grades`, `get_grade_prognosis`, `get_student_documents`                               | Published grades, grade check dates, the list of student documents. These need `login --web`.                                                        |
| Absence and attendance | `get_unreported_absence`, `get_attendance_report`, `report_absence`                        | Absence the school recorded, attendance summaries. `report_absence` returns the report it would send, or sent. The first two need `login --web`.     |
| Finding a school       | `find_school`                                                                              | Names from SchoolSoft's public school list.                                                                                                          |

Some of this is about other people: teachers, classmates, and other parents in contact lists, message recipients and comments. Ask only for what you need.

With the command line, the same answers are printed as text. They reach an AI provider only if an assistant runs the command.

### Through the connector

The connector offers all 22 read-only tools, including school news, message summaries and full message text, assignments, class contacts, shared files, and the reads that require a separate web login. The full list and prerequisites are in the [connector guide](../deployment/connector.md). It never offers `login`, `logout` or `report_absence` as network tools.

When you connect an AI app, the approval page on your own server asks which children and which tools that app may use. The app can read only those. Existing approvals do not gain new permissions after an update; reconnect and explicitly select the additional reads. `list_children` shows the app each approved child's first name and student number, nothing more. Network `auth_status` also filters its child list to the approval. Removing one app's approval does not affect another app.

Message access is to the guardian's inbox at the selected child's school. It can include messages about siblings at that school. Class contacts can include other families' personal details. Those permissions are separate choices on the approval page. Grades, student documents, assessment and attendance remain behind SchoolSoft's separate web-session gate; the connector does not automate or bypass that login.

The connector also has a read-only JSON interface (`/api/v1`) for your own dashboard. It keeps the four typed child, schedule, calendar and lunch routes, using the same OAuth tokens and approvals. The additional read tools are available through MCP. Desktop clients can use explicitly enabled loopback callbacks as described in the deployment guide.

### What never reaches the assistant

- **BankID.** You complete it on SchoolSoft's and BankID's own pages. The program never sees or stores your BankID, password or personal identity number.
- **Your SchoolSoft tokens and cookies.** They are sent only to SchoolSoft. `auth_status` tells the assistant how many web cookies are saved, never what they are.
- **The encryption key**, the connector's storage key and admin password, and the connector's own SchoolSoft login.

Never type a BankID code, password, storage key or admin password into a chat.

## What reaches SchoolSoft

The program talks only to SchoolSoft (`sms.schoolsoft.se`), and only for things you asked for:

- **Logging in:** your own browser opens SchoolSoft's login page. After BankID, SchoolSoft sends a one-time code back to your computer (`127.0.0.1`, which never leaves the machine) or to your connector. The program exchanges it for tokens and fetches your guardian profile and children.
- **Each question:** the requests needed to answer it. Switching child asks SchoolSoft for new cookies for that child.
- **Finding a school:** SchoolSoft's public school list, without logging in.
- **`doctor`:** one check that SchoolSoft can be reached.
- **`setup` (the guided first run):** the school list and the login as above, then one read each of your children, the schedule, the calendar, the lunch menu and the inbox to check that they work (nothing of it is shown or kept), and this week's schedule, which it shows.
- **Keepalive,** only if you turned it on (see above).

These are the same kinds of requests the SchoolSoft app and website make for you. SchoolSoft sees your login and which pages and data were requested, as usual. The hidden browser opens SchoolSoft's pages as your own browser would, including anything those pages load themselves. Opening a message through the assistant may mark it as read in SchoolSoft, just as opening it in the app does. We have not checked this.

**The program limits itself.** Each running copy sends on average at most 20 requests a minute, up to 10 in a quick burst and never more than 2 at the same time. You can change this (`SCHOOLSOFT_REQUESTS_PER_MINUTE`, at most 60). If SchoolSoft says it is busy or keeps failing, the program slows down and then stops sending anything for a while (5 minutes, up to an hour). It does not repeat refused requests on its own.

## What this project collects

**None.** The program has no telemetry, no usage statistics, no crash reporting and no analytics. It does not contact the project author or any server other than SchoolSoft.

Other programs do connect to the internet around it. `npx` downloads the package from the npm registry. `browser install` downloads the Chromium browser from Playwright's servers. Your AI app talks to its own company. If you open a GitHub issue, what you write there is public, so never paste school data, login addresses or settings.

## Logs and messages on screen

The program writes no log files.

It prints a few lines to the error output (stderr). Some assistant apps save these lines in their own log files:

- one line after each SchoolSoft login, with technical facts about the token SchoolSoft issued (user type, app id, login method, expiry time). It contains no name or school data. A later version plans to make it quieter;
- "Web login: complete BankID/SAML in the browser window" with your school's SchoolSoft address;
- a note if the browser could not be opened automatically;
- "schoolsoft-agent-mcp running on stdio" when the MCP server starts;
- keepalive notes, such as "keepalive: app stopped" with a short reason code;
- connector only: start-up problems, and a one-time notice about the proxy setting, without addresses.

None of these lines contain names, messages, grades or other school content. On the connector, an unexpected error returns a fixed page and nothing is logged.

The guided first run (`setup`, or `schoolsoft-agent` on its own in a terminal) is the exception, on purpose: it is written for you at the terminal, so it prints your name after the login, the login address, the folders it uses and this week's schedule for your child on the error output. Run it yourself, not through an assistant, if you do not want that to reach the assistant.

If the command line or the MCP server stops because of a bug, it prints the error. That text is technical, but it can include file paths, which contain your computer's user name.

Error messages are shown to you and to the assistant, and are not logged. A few of them list your children's first names and student numbers, for example when the assistant asked for a child that does not exist.

## Changing data at SchoolSoft

Reporting an absence (`report_absence`) is the only tool that changes anything at SchoolSoft. It works only on a computer, never through the connector, and only after you turn it on with `SCHOOLSOFT_ALLOW_WRITES=1` (or `"allowWrites": true` in `config.json`). Even then, the first call only shows a preview and sends nothing. The assistant should show you the preview and send the report only after you say yes.

Every other tool only reads, and the hidden browser blocks every request that could change something. Some requests still change your session, not your school data: logging in, renewing the login, and switching child. For grades and documents, the program also tells SchoolSoft's website which of your children you are looking at, as the website does when you switch child there.

A general framework for actions that change data (such as sending messages) is being designed ([proposal](https://github.com/grimen/schoolsoft-agent/pull/59)). This page will be updated if it is added.

## If you run the connector, you are the operator

With the connector, you rent the server and control it. There is no one else running it for you. In practice:

- **Your hosting provider can reach your data** while the server uses it. Choose a provider you trust, and protect your hosting account with a strong password and two-step login.
- **Keep the storage key and admin password safe**, for example in a password manager. Without the storage key, the saved data cannot be read. Anyone with both the key and the disk can read it.
- **Backups are your choice.** Your hosting provider may make disk backups. They contain the encrypted files. Check how long it keeps them.
- **After restoring a backup, disconnect everything.** A backup brings back every app approval that existed when it was made, including ones you removed later. Before you use a restored server, open the owner page, choose **Disconnect everything**, then log in to SchoolSoft and connect each AI app again. Starting with an empty disk is simpler. See the [connector recovery steps](../deployment/connector.md#everyday-use-and-recovery).
- **Updates are yours to apply.** Follow the connector guide when a new version is released.

## How to delete everything

**On your computer:**

1. Ask the assistant to log out, or run `npx -y schoolsoft-agent logout`. This deletes the current school's saved login. Repeat for each school you configured: `npx -y schoolsoft-agent logout --school <short name>`.
2. To remove everything else (settings, the key, the sign-in history, the school list), close the assistant app and delete the folder listed under [where the folder is](#where-the-folder-is), and any folder you set with `SCHOOLSOFT_STATE_DIR`. The old `~/.schoolsoft-mcp` folder too, if you have one.
3. Uninstall the Claude Desktop extension or remove the add-on from your assistant's settings.
4. Optional: the browser from `browser install` sits in Playwright's download folder (`ms-playwright`). It contains no school data.

**On the connector:**

1. On the owner page, choose **Disconnect everything**. This cancels every AI app's approval and deletes the saved SchoolSoft login. It keeps the sign-in history, the guardian pin in `identity.enc` and the list of app registrations.
2. Remove the connector in each AI app.
3. To remove everything, delete the service and its disk or volume in your hosting account, remove the saved settings (storage key and admin password), and check the provider's backups.

**At your AI provider:** delete conversations in your AI account if you do not want them kept. This project cannot do it for you.

## What would change this page

This page must be updated when the project changes what it stores, sends or logs. Known plans that would change it:

- **A diagnostics report** that you can attach to an issue (planned). It is meant to contain no names or school content.
- **A family app and more of the JSON interface** (planned): a web page served by the connector, other apps that can be approved, and absence reporting from the app.
- **Actions that change data**, such as sending messages (see above).
- **Quieter diagnostics** on the error output.
- **Other school platforms** than SchoolSoft.

Found something here that does not match what the program does? Please [open an issue](https://github.com/grimen/schoolsoft-agent/issues), without personal data.
