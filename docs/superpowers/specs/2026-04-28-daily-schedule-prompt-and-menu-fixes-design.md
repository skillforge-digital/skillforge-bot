# Daily Schedule Prompt + Menu Fixes (Design)

## Goals

- At 08:00 Africa/Lagos daily, the bot messages each classroom’s specialist asking whether there will be class today.
- The message includes Yes/No buttons.
- If the specialist taps Yes, the bot enters a DM flow for that classroom:
  - Ask for one class time in HH:MM (24-hour) and optional topic.
  - Schedule the class using the same behavior as `/setclass` (announce in group, pin, DM reminders).
- Fix the web menu so it always opens the correct bot DM for the configured bot username (e.g., `@SkillforgeHQ_Bot`), not the hardcoded `skillforge_bot`.
- Make `t.me/<bot>?start=...` links from the web menu actually do something useful in the bot (start payload routing).
- Provide a real `/verify` command because it is listed in Telegram’s command menu but missing in code.

## Non-Goals

- Multiple class scheduling in the 8am flow (this design schedules one class per Yes tap).
- Major refactor into multiple files; keep changes minimal and consistent with existing style.
- Adding new external libraries.

## Current State (Observed)

- A daily 08:00 Lagos cron exists and sends a text-only prompt to each specialist ([index.js](file:///workspace/skillforge-bot/index.js#L1288-L1303)).
- The web menu HTML hardcodes `https://t.me/skillforge_bot?...` ([menu.html](file:///workspace/skillforge-bot/public/menu.html#L187-L245)).
- There is an Express `/menu` handler that attempts to replace `skillforge_bot` dynamically, but a later duplicate `/menu` route overrides it, preventing replacement ([index.js](file:///workspace/skillforge-bot/index.js#L16-L29) and [index.js](file:///workspace/skillforge-bot/index.js#L1942-L1945)).
- Verification is implemented only via `/start verify` payload; `/verify` command is not implemented but is advertised.

## Proposed Behavior

### 1) 08:00 Lagos prompt with Yes/No buttons

- For each classroom in Firestore `classrooms`, send the specialist a DM:
  - Text: “Will there be a live session for <group> today?”
  - Buttons:
    - “Yes ✅” callback data: `daily_prompt_yes_<groupId>_<date>`
    - “No ❌” callback data: `daily_prompt_no_<groupId>_<date>`
- Date uses Lagos date string (existing helper).

### 2) DM scheduling flow (Yes → ask time)

- On `daily_prompt_yes_*`, bot:
  - Creates a Firestore record in `schedule_sessions`:
    - `specialist_id`, `group_id`, `date` (Lagos date), `status: "awaiting_time"`, `created_at`, `expires_at`
  - Sends DM: “Send time in HH:MM format and optional topic. Example: `14:00 Arrays in JS`.”
- When specialist sends a DM text message:
  - Before treating it as generic feedback/review answer, check if there is an active `schedule_sessions` record:
    - `specialist_id == ctx.from.id`, `status == "awaiting_time"`, `expires_at > now`, most recent first.
  - Parse message:
    - First token must match `CLASS_TIME_REGEX`.
    - Remaining text is the topic (optional).
  - Schedule by calling a shared function that encapsulates `/setclass` logic (see “Shared scheduling function”).
  - Update session to `status: "completed"` with `scheduled_time`, `topic`, `completed_at`.

### 3) Shared scheduling function

- Extract scheduling logic currently inside `/setclass` into a function, e.g.:
  - Inputs: `{ groupId, specialistId, time, topic, ctxTelegram }`
  - Performs:
    - Validate classroom ownership.
    - Create Firestore `classes` document id `getClassDocId(groupId, todayStr, time)`.
    - Announce + pin in the group.
    - DM reminders to specialist and verified trainees.
- `/setclass` command and the new 8am flow both call this function to guarantee identical behavior.

### 4) Web menu fixes

- Make `/menu` always serve `public/menu.html` after replacing occurrences of `skillforge_bot` with the sanitized env bot username.
- Remove/rename the later duplicate `/menu` route so it cannot override the dynamic behavior.
- Sanitize `BOT_USERNAME`:
  - If env includes `@SkillforgeHQ_Bot`, strip leading `@`.
  - Use sanitized name for:
    - BOT_LINK
    - web menu replacement

### 5) Start payload routing for web menu

- Extend `bot.start(...)` to handle these payloads:
  - `register` → reply with “Use /register <password> …”
  - `claim` → reply with “Use /claim inside the group …”
  - `schedule` → show scheduling help and/or inline buttons for the user’s classrooms (reuse existing “Schedule Class” flow).
  - `classes` → call the `/classlist` behavior for specialists.
  - `report` → show reports options (reuse inline keyboard).
  - `progress` → instruct `/courseprogress <group_id>` and list group IDs.
  - `weekly` → instruct weekly report flow (Saturday-only).
  - `help` → show help.
  - `verify` remains supported.

### 6) Implement `/verify`

- Add `bot.command('verify', ...)` in DM:
  - If user has a `pending_verifications` doc and not verified: mark verified and restore chat permissions.
  - If already verified: confirm.
  - If no record: explain they must join a classroom group first.

## Data Model

### New collection: `schedule_sessions`

- Document fields:
  - `specialist_id: string`
  - `group_id: string`
  - `date: string` (Lagos YYYY-MM-DD)
  - `status: "awaiting_time" | "completed" | "canceled" | "expired"`
  - `created_at: serverTimestamp`
  - `expires_at: Timestamp` (e.g., created_at + 2 hours)
  - `scheduled_time?: string`
  - `topic?: string`
  - `completed_at?: serverTimestamp`

## Error Handling

- If specialist taps Yes but they are not the linked specialist: show callback error.
- If a schedule session exists but the user sends invalid time:
  - Reply with correct format and keep session awaiting.
- If session is expired:
  - Mark as expired and ask them to tap Yes again.
- If scheduling fails (Firestore/Telegram API):
  - Report via `reportError`, keep session awaiting or mark as failed based on error type.

## Verification / Testing

- Local checks:
  - `npm install`
  - `node index.js` with required env vars set (BOT_TOKEN, BOT_USERNAME, STAFF_PASSWORD, FIREBASE_JSON).
- Manual behavior checks (Telegram):
  - At 8am Lagos: DM contains Yes/No buttons.
  - Yes starts DM flow and schedules class after time is provided.
  - Web menu opens `@SkillforgeHQ_Bot` (or configured username).
  - Web menu start payloads return appropriate guidance.
  - `/verify` works in DM and matches `/start verify` behavior.

