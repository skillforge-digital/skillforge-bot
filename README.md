# Skillforge Principal Bot

A comprehensive Telegram bot for managing Skillforge Digital Academy's classroom scheduling, trainee verification, attendance tracking, feedback collection, and weekly reporting.

## Features

### For Specialists
- **Registration & Classroom Linking**: Register as a specialist and link Telegram groups as classrooms.
- **Class Scheduling**: Schedule, reschedule, and cancel live sessions with reminders.
- **Attendance & Feedback**: Track trainee attendance and collect feedback after sessions.
- **Weekly Reports**: Generate detailed weekly performance reports with PDF output.
- **Interactive Menu**: Easy navigation with reply keyboard menus.
- **Course Progress Tracking**: Monitor program progress against targets.

### For Trainees
- **Verification System**: Secure verification process to join groups.
- **Attendance Reporting**: Mark attendance for sessions.
- **Feedback Submission**: Provide feedback on sessions.

### Automated Features
- **Reminders**: Automatic reminders for classes and reports.
- **Verification Enforcement**: Timeout and removal of unverified users.
- **Daily Summaries**: Morning summaries for specialists.
- **Weekly Report Reminders**: Saturday reminders for weekly reports.

## Setup

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd skillforge-bot
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   Create a `.env` file with:
   ```
   BOT_TOKEN=your_telegram_bot_token
   BOT_USERNAME=your_bot_username
   STAFF_PASSWORD=your_staff_password
   REPORT_LOGO_PATH=./logo.jpg
   REPORT_LOGOTAG=Skillforge Digital Academy Principal Bot
   SERVER_URL=http://localhost:3000
   FIREBASE_JSON=your_firebase_service_account_json
   REPORT_CHAT_ID=optional_chat_id_for_error_reports
   ```

4. **Firebase Setup**:
   - Create a Firebase project.
   - Enable Firestore.
   - Generate a service account key and set `FIREBASE_JSON` or use the local file.

5. **Run the bot**:
   ```bash
   npm start
   ```

## Commands

The bot features a built-in commands menu in Telegram. When you type "/" in a chat with the bot, you'll see a dropdown list of available commands with descriptions.

### Specialist Commands
- `/register <password>` - Register as a specialist.
- `/claim` - Link a group as a classroom.
- `/setclass <group_id> <time> [topic]` - Schedule a class.
- `/cancelclass <group_id> [time]` - Cancel classes.
- `/rescheduleclass <group_id> <old_time> <new_time>` - Reschedule a class.
- `/questionnaire [group_id]` - Start weekly questionnaire.
- `/weeklyreport` - Generate weekly report.
- `/courseprogress <group_id>` - View course progress.
- `/status` - View daily status.
- `/classlist` - List upcoming classes.
- `/report [date]` - Attendance report.
- `/calendar [date]` - List classes on a date.
- `/health` - Bot health check.

### Trainee Commands
- `/attended` - Mark attendance.
- `/missed` - Report absence.

### General Commands
- `/start` - Start the bot and show menu.
- `/verify` - Verify trainee account.
- `/help` - Show help menu.

### Menu Options (via reply keyboard)
- Submit Weekly Report
- Schedule Class
- View My Classes
- View Reports
- Settings
- Help

## Architecture

- **Node.js** with Express for web routes.
- **Telegraf** for Telegram bot framework.
- **Firebase Firestore** for database.
- **PDFKit** for PDF generation.
- **Node-cron** for scheduled tasks.

## Security

- Password-protected specialist registration.
- Verification system for trainees.
- Automatic timeout for unverified users.
- Environment variable configuration for sensitive data.

## Deployment

The bot is designed to run on platforms like Render or Heroku. Ensure environment variables are set correctly.

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Make changes and test.
4. Submit a pull request.

## License

[Your License Here]