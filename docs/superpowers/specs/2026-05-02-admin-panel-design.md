# Admin Panel (Phase 1) Design

## Goal

Add an authenticated Admin Panel to manage the bot operationally:
- Specialists can view only their own classrooms.
- A super-admin can view all classrooms and perform operational actions.

## Access Model

### Specialist access

- Specialist identifies as a Telegram user who exists in Firestore `specialists/{telegram_id}`.
- Admin Panel specialist login uses a one-time code delivered in Telegram DM:
  - Panel displays a “Login” screen and asks for Telegram ID.
  - Panel calls `POST /admin/auth/request` with `{ telegram_id }`.
  - Server generates a short-lived code and sends it via `bot.telegram.sendMessage(telegram_id, ...)`.
  - Specialist enters code in the panel; panel calls `POST /admin/auth/verify`.
  - Server issues a session cookie.

### Super-admin access

- Super-admin enters a shared secret stored in environment variable:
  - `SUPER_ADMIN_KEY`
- Super-admin can either:
  - sign in using the same OTP flow, then elevate with `SUPER_ADMIN_KEY`, or
  - use `SUPER_ADMIN_KEY` directly to open the super-admin view.
- Super-admin must always be authenticated (no public endpoints).

## Server Architecture

### New routes (Express)

#### Admin UI pages
- `GET /admin`  
  - Serves the Admin Panel HTML (specialist view by default).

#### Auth APIs
- `POST /admin/auth/request`  
  - Body: `{ telegram_id: string }`
  - Behavior:
    - Verify `specialists/{telegram_id}` exists.
    - Generate code and store `admin_sessions_pending/{telegram_id}` with TTL metadata.
    - Send DM containing the code.
- `POST /admin/auth/verify`  
  - Body: `{ telegram_id: string, code: string }`
  - Behavior:
    - Verify code + expiry.
    - Create server-side session `admin_sessions/{session_id}` and set secure cookie.
- `POST /admin/auth/logout`

#### Data APIs (specialist-scoped by default)
- `GET /admin/api/classrooms`
  - Specialist: returns classrooms where `specialist_id == telegram_id`
  - Super-admin: returns all classrooms
- `GET /admin/api/classrooms/:groupId/verifications`
  - Returns counts derived from `group_verifications` (verified/unverified/removed)
- `GET /admin/api/classes?groupId=&date=`
  - Returns scheduled classes for a date and group (or all groups for super-admin)
- `GET /admin/api/attendance/export?groupId=&from=&to=`
  - Returns CSV export for attendance records.

#### Admin actions (super-admin only)
- `POST /admin/api/classrooms/:groupId/campaign/start`
- `POST /admin/api/classrooms/:groupId/campaign/stop`
- `POST /admin/api/classrooms/:groupId/announce-verify`

## Data Model

### Existing collections used
- `specialists` (role)
- `classrooms` (ownership / grouping)
- `classes` (schedule)
- `group_verifications` (verified/unverified)
- `group_settings` (verify campaign state)
- `attendance`, `feedback` (exports)

### New collections
- `admin_sessions_pending`
  - doc id: `telegram_id`
  - fields: `code_hash`, `expires_at`, `created_at`, `attempts`
- `admin_sessions`
  - doc id: random session id
  - fields: `telegram_id`, `role: specialist|super_admin`, `created_at`, `expires_at`

## UI (Minimal, No Framework)

Phase 1 Admin Panel is a single HTML page with:
- Login screen (telegram id + code)
- Header showing user role (specialist/super-admin)
- Tabs:
  - Classrooms
  - Verification
  - Classes (today)
  - Exports

The UI calls JSON APIs using `fetch` and renders tables.

## Security Requirements

- Never log admin codes or `SUPER_ADMIN_KEY`.
- Cookies:
  - `HttpOnly`, `Secure` when deployed behind HTTPS, `SameSite=Lax`.
- Rate limit OTP requests:
  - per telegram id cooldown and max attempts.
- Super-admin operations require both:
  - authenticated session, and
  - super-admin role.

## Phase 2–4 (Planned)

### Phase 2: Better reports
- PDF weekly report generation + CSV exports improvements.

### Phase 3: Reliability
- Backoff/retry queue for Telegram API 429s, idempotent cron sends.

### Phase 4: Analytics
- KPIs per group/specialist, alerts to head-of-units.

