# Role-Based Menus + Command Guards (Design)

## Goal

- Trainees must not see staff-only menu items (especially scheduling/report/admin links).
- Specialists must not see super-admin features.
- Server must enforce access (not only UI hiding).

## Roles

Determine a user’s role in this order:

1) `super_admin` — only exists in the Admin Panel after elevation with `SUPER_ADMIN_KEY` (no Telegram “super admin” UI).
2) `specialist` — user exists in Firestore `specialists/{telegram_id}`.
3) `trainee_verified` — user has at least one `group_verifications` doc with `verified: true` and `removed: false`.
4) `trainee_unverified` — otherwise.

## Telegram UX

### `/start` (and main menu)

- `specialist`:
  - Show staff dashboard buttons (schedule, class list, reports)
  - Show web menu link (staff-only)
- `trainee_verified`:
  - Show trainee buttons only:
    - Attendance help (how to use `/attended` and `/missed`)
    - Help
  - No web menu link
- `trainee_unverified`:
  - Show verify/help only
  - No web menu link

### Hard server-side guards

Specialist-only commands must reject trainees even if typed manually:
- `/claim`
- `/setclass`, `/cancelclass`, `/rescheduleclass`
- reports and course progress commands intended for staff

Guard behavior:
- If not specialist: reply “Staff only”.

## Admin Panel

- Super-admin functionality remains only accessible via:
  - Specialist OTP login, then
  - `/admin/auth/elevate` with `SUPER_ADMIN_KEY`
- Specialist sessions must not see super-admin actions:
  - UI already hides controls (`can_manage` false)
  - APIs already enforce role (`requireSuperAdmin`)

## Success Criteria

- Trainees never see staff web menu links in Telegram messages.
- Trainees cannot execute staff commands.
- Specialists cannot access super-admin APIs without elevation.

