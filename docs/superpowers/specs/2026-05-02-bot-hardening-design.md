# Bot Hardening (Roles, Verification, Menu)

## Summary

This change hardens the bot so it can correctly handle trainees who may be present in multiple classroom groups, keeps menu links reliably pointing to the configured bot username, improves cron reliability, and removes use of the bot token from webhook paths.

## Key Changes

### Verification model

- Introduce `group_verifications` collection with per-(group,user) documents using `${groupId}_${userId}` as the document id.
- On group join (`new_chat_members`), create/update `group_verifications` for each user.
- Verification links now include the group id (`/start verify_<groupId>`) so the bot knows which group to verify for.
- `/verify` and `/start verify`:
  - If the group id is provided, verify for that group.
  - If not provided and there are multiple pending verifications, present a selection list.
- Legacy support: if `pending_verifications/{userId}` exists and is not verified, it is copied into `group_verifications` on-demand.

### Attendance correctness

- `/attended` and `/missed` look up all verified group memberships for the user and find candidate active classes for today.
- If multiple candidate classes exist, the user selects the correct one from buttons.

### Claim protection

- Prevent `/claim` from overwriting an already-claimed classroom owned by another specialist.

### Menu hardening

- The bot menu HTML is always served dynamically from `/menu` (and `/`) with runtime replacement of the bot username.
- Static serving is moved under `/public` so users can’t accidentally open the raw hardcoded `menu.html` at the root.

### Webhook security

- Webhook path is now derived from `WEBHOOK_SECRET` (required when `SERVER_URL` is set) instead of using the bot token in the URL.

## Operational Notes

- New env var required for webhook deployments:
  - `WEBHOOK_SECRET` (a random secret string)
- Firestore indexes may be needed as group sizes scale, especially for multi-field queries on `group_verifications`.

