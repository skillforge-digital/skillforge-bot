# WebApp Menu + Polling Mode Rebuild (Design)

## Problem

- Telegram Web App menu links (`<a href="https://t.me/...">`) are unreliable inside Telegram’s in-app browser and may not open or may degrade to a generic `/start`.
- Webhook mode on Render is brittle and hard to debug; when webhook fails, the bot can still send cron messages but will not respond to user commands.

## Goal

- Make `/start` reliably respond.
- Make the HTML menu buttons reliably trigger the correct bot actions.
- Keep staff menu hidden until the user is verified as staff (registered specialist).

## Decisions

### Bot update delivery

- Switch production to **polling mode**:
  - Always delete webhook on startup
  - Start long-polling with `bot.launch()`
- Keep `SERVER_URL` for building website links only (menu/admin).

### Web App menu behavior (Option A)

- Use `Telegram.WebApp.sendData()` from the menu page:
  - Each button sends JSON, e.g. `{ "action": "schedule" }`
  - Bot receives it as `web_app_data` update and replies accordingly.

### Role-based menu visibility

- Menu page determines role by calling an API endpoint with Telegram WebApp `initData`.
- Server verifies the `initData` signature using the bot token (Telegram official algorithm).
- Server returns role:
  - `specialist` if Firestore `specialists/{telegram_id}` exists
  - otherwise `public`
- Client shows:
  - Public: Register + Help + Verify
  - Specialist: full staff menu (Claim, Schedule, Reports, Progress, Settings).

## API Additions

- `POST /api/webapp/role`
  - Request: `{ initData: string }`
  - Response: `{ ok: true, role: "specialist"|"public", user_id: string }`

## Bot Additions

- Handle WebApp messages:
  - `bot.on('message', ctx => ctx.message.web_app_data)`
  - Parse JSON and route to the same logic as `/start` payloads:
    - `register`, `claim`, `schedule`, `classes`, `report`, `progress`, `weekly`, `settings`, `help`
  - Enforce role guards (staff-only remains staff-only).

## Success Criteria

- Clicking any menu button triggers a bot reply within seconds.
- `/start` responds even if the website is open in Telegram.
- Staff menu does not display for non-staff accounts.

