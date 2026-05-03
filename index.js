require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const PDFDocument = require('pdfkit');
const admin = require('firebase-admin');
const cron = require('node-cron');
const express = require('express');

// ==========================================
// SETUP & CONNECTIONS
// ==========================================
const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// SAFELY CONNECT TO FIREBASE
let serviceAccount;
if (process.env.FIREBASE_JSON) {
    // If running on Render, use the secret Environment Variable
    serviceAccount = JSON.parse(process.env.FIREBASE_JSON);
} else {
    // If running on your computer, use the local file
    serviceAccount = require('./firebase-service-account.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const requiredEnvs = ['BOT_TOKEN', 'BOT_USERNAME', 'STAFF_PASSWORD'];
const missingEnvs = requiredEnvs.filter((name) => !process.env[name]);
if (missingEnvs.length) {
    console.error(`Missing required environment variables: ${missingEnvs.join(', ')}`);
    process.exit(1);
}

const BOT_USERNAME_SAFE = (process.env.BOT_USERNAME || 'skillforge_bot').replace(/^@/, '').trim();
const BOT_LINK_BASE = `https://t.me/${BOT_USERNAME_SAFE}?start=`;
const getVerifyLink = (groupId) => `${BOT_LINK_BASE}verify_${encodeURIComponent(String(groupId))}`;
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID || null;
const SERVER_URL = process.env.SERVER_URL || null;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;
const SUPER_ADMIN_KEY = process.env.SUPER_ADMIN_KEY || null;
const REPORT_LOGO_PATH = process.env.REPORT_LOGO_PATH || './logo.jpg';
const REPORT_LOGOTAG = process.env.REPORT_LOGOTAG || 'Skillforge Principal Bot';
const CLASS_TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

const serveMenuHtml = (res) => {
    const menuPath = path.join(__dirname, 'public', 'menu.html');
    fs.readFile(menuPath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading menu.html:', err);
            return res.status(500).send('Error loading menu');
        }
        const updatedData = data.replace(/skillforge_bot/g, BOT_USERNAME_SAFE);
        res.header('Content-Type', 'text/html; charset=utf-8');
        res.send(updatedData);
    });
};

app.get('/', (req, res) => serveMenuHtml(res));
app.get('/menu', (req, res) => serveMenuHtml(res));

// Utility function to generate bot mention
const getBotMention = () => `@${BOT_USERNAME_SAFE}`;
const getBotDirectMessageLink = () => `https://t.me/${BOT_USERNAME_SAFE}`;

const bot = new Telegraf(process.env.BOT_TOKEN);

const getClassDocId = (groupId, date, time) => `${groupId}_${date}_${time}`;
const normalizeUserIds = (userIds) => [...new Set(userIds.filter(Boolean).map(String))];
const getVerificationDocId = (groupId, userId) => `${groupId}_${userId}`;

const getGroupVerification = async (groupId, userId) => {
    const docId = getVerificationDocId(groupId, userId);
    const doc = await db.collection('group_verifications').doc(docId).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
};

const setGroupVerification = async (groupId, userId, payload) => {
    const docId = getVerificationDocId(groupId, userId);
    await db.collection('group_verifications').doc(docId).set(payload, { merge: true });
};

const isSpecialist = async (userId) => {
    const doc = await db.collection('specialists').doc(String(userId)).get();
    return doc.exists;
};

const getUserRole = async (userId) => {
    const uid = String(userId);
    const specialistDoc = await db.collection('specialists').doc(uid).get();
    if (specialistDoc.exists) return { role: 'specialist' };

    const verifiedSnap = await db.collection('group_verifications')
        .where('user_id', '==', uid)
        .where('verified', '==', true)
        .where('removed', '==', false)
        .limit(1)
        .get();
    if (!verifiedSnap.empty) return { role: 'trainee_verified' };

    return { role: 'trainee_unverified' };
};

const requireSpecialist = async (ctx) => {
    const uid = ctx.from?.id ? String(ctx.from.id) : null;
    if (!uid) return false;
    const ok = await isSpecialist(uid);
    if (!ok) {
        await ctx.reply('Staff only.');
        return false;
    }
    return true;
};

const startVerifyCampaign = async (groupId) => {
    const docRef = db.collection('group_settings').doc(String(groupId));
    const now = admin.firestore.Timestamp.fromDate(new Date());
    await docRef.set({
        group_id: String(groupId),
        verify_campaign_active: true,
        verify_campaign_started_at: now,
        last_verify_reminder_at: now
    }, { merge: true });
};

const updateVerifyReminderSent = async (groupId) => {
    await db.collection('group_settings').doc(String(groupId)).set({
        last_verify_reminder_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
};

const stopVerifyCampaign = async (groupId) => {
    await db.collection('group_settings').doc(String(groupId)).set({
        verify_campaign_active: false,
        verify_campaign_stopped_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
};

const parseCookies = (cookieHeader) => {
    const out = {};
    if (!cookieHeader) return out;
    cookieHeader.split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx === -1) return;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        out[k] = decodeURIComponent(v);
    });
    return out;
};

const randomCode = () => String(Math.floor(100000 + Math.random() * 900000));
const hashCode = (code) => require('crypto').createHash('sha256').update(String(code)).digest('hex');
const randomSessionId = () => require('crypto').randomBytes(24).toString('hex');

const reportError = async (message, error) => {
    const fullMessage = `â—ï¸ Bot error: ${message}${error ? `\n${error.message || error}` : ''}`;
    console.error(fullMessage);
    if (REPORT_CHAT_ID) {
        try {
            await bot.telegram.sendMessage(REPORT_CHAT_ID, fullMessage);
        } catch (err) {
            console.error('Failed to send error report:', err.message);
        }
    }
};

const getLagosDateString = (date = new Date()) => {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(date);
};

const getLagosTimeParts = (date = new Date()) => {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Lagos',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(date).split(':').map(Number);
};

const parseDateString = (dateStr) => {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3) return null;
    const [year, month, day] = parts;
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getPdfBuffer = async (title, lines, options = {}) => {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));

            const renderHeaderFooter = () => {
                if (options.logoPath && fs.existsSync(options.logoPath)) {
                    try {
                        const imageWidth = 260;
                        const x = (doc.page.width - imageWidth) / 2;
                        const y = (doc.page.height - imageWidth) / 2;
                        doc.image(options.logoPath, x, y, { width: imageWidth, opacity: 0.08 });
                    } catch (logoError) {
                        console.warn('Unable to render logo watermark:', logoError.message || logoError);
                    }
                }

                if (options.logoTag) {
                    const headerY = doc.page.margins.top - 20;
                    doc.fontSize(10).fillColor('gray').text(options.logoTag, doc.page.margins.left, headerY, {
                        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
                        align: 'right'
                    });
                    doc.fillColor('black');
                }

                const footerText = `Generated: ${dateToString(new Date())} | Page ${doc.page.number}`;
                doc.fontSize(9).fillColor('gray').text(footerText, doc.page.margins.left, doc.page.height - 40, {
                    width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
                    align: 'center'
                });
                doc.fillColor('black');
            };

            renderHeaderFooter();
            doc.on('pageAdded', renderHeaderFooter);

            doc.moveDown(2);
            doc.fontSize(20).text(title, { underline: true });
            doc.moveDown();
            doc.fontSize(11);
            lines.forEach(line => {
                doc.text(line, { lineGap: 4 });
            });
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
};

const getWeekBounds = (date) => {
    const copy = new Date(date);
    const day = copy.getUTCDay();
    const diffToMonday = ((day + 6) % 7);
    copy.setUTCDate(copy.getUTCDate() - diffToMonday);
    const monday = new Date(Date.UTC(copy.getUTCFullYear(), copy.getUTCMonth(), copy.getUTCDate()));
    const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6));
    return { monday, sunday };
};

const dateToString = (date) => {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(date);
};

/**
 * Calculates the weekly performance metrics for a given group and week.
 * @param {string} groupId - The ID of the classroom group.
 * @param {Date} weekStartDate - The start date of the week (Monday).
 * @param {Date} weekEndDate - The end date of the week (Sunday).
 * @param {Object} plan - The course plan object with sessions_per_week, min_days_per_week, etc.
 * @returns {Object} Performance metrics including attendance, sessions held, etc.
 */
const getWeekPerformance = async (groupId, weekStartDate, weekEndDate, plan) => {
    const weekStart = dateToString(weekStartDate);
    const weekEnd = dateToString(weekEndDate);

    const classesSnapshot = await db.collection('classes')
        .where('group_id', '==', groupId)
        .where('date', '>=', weekStart)
        .where('date', '<=', weekEnd)
        .get();

    const classes = classesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const classDays = new Set(classes.map(c => c.date));

    let heldSessions = 0;
    let totalAttendance = 0;
    let totalPossibleAttendance = 0;

    for (const classData of classes) {
        const attendanceSnapshot = await db.collection('attendance')
            .where('class_id', '==', classData.id)
            .get();
        if (!attendanceSnapshot.empty) {
            heldSessions += 1;
            const attendedCount = attendanceSnapshot.docs.filter(d => d.data().attended).length;
            totalAttendance += attendedCount;
            totalPossibleAttendance += attendanceSnapshot.size;
        }
    }

    const expectedSessions = plan?.sessions_per_week || 3;
    const expectedDays = plan?.min_days_per_week || 2;
    const attendanceRate = totalPossibleAttendance > 0 ? ((totalAttendance / totalPossibleAttendance) * 100).toFixed(1) : 0;
    const sessionScore = Math.min(1, heldSessions / expectedSessions);
    const dayScore = Math.min(1, classDays.size / expectedDays);
    const attendanceScore = totalPossibleAttendance > 0 ? Math.min(1, totalAttendance / totalPossibleAttendance) : 0;
    const meterValue = Math.round((sessionScore * 40 + dayScore * 30 + attendanceScore * 30) * 10) / 10;

    return {
        classes,
        heldSessions,
        classDays: classDays.size,
        totalAttendance,
        totalPossibleAttendance,
        attendanceRate,
        meterValue,
        expectedSessions,
        expectedDays
    };
};

const REVIEW_QUESTIONS = [
    'Describe the current status of your class program and how close you are to meeting the 3x/week target.',
    'How many sessions were scheduled, held, and canceled this week?',
    'Did you meet the minimum 2 class days this week? If not, explain the reason.',
    'Rate trainee participation from 1 to 5, where 5 is excellent.',
    'What was the average attendance rate for your live sessions?',
    'What were the biggest challenges or blockers this week?',
    'What support do you need from the head of units?',
    'Anything else to note for this weekly review?'
];

const getActiveReviewSession = async (userId) => {
    const sessionSnapshot = await db.collection('questionnaire_sessions')
        .where('user_id', '==', userId)
        .where('status', 'in', ['in_progress', 'pending'])
        .orderBy('created_at', 'desc')
        .limit(1)
        .get();
    return sessionSnapshot.empty ? null : { id: sessionSnapshot.docs[0].id, data: sessionSnapshot.docs[0].data() };
};

/**
 * Builds a PDF buffer for the weekly review report.
 * @param {Object} session - The questionnaire session data.
 * @returns {Buffer} The PDF buffer.
 */
const buildReviewPdf = async (session) => {
    const lines = [];
    lines.push('Weekly Review Report');
    lines.push('');
    lines.push(`Group: ${session.group_name}`);
    lines.push(`Review period: ${session.week_start} to ${session.week_end}`);
    lines.push('');
    lines.push('Performance Summary:');
    lines.push(`â€¢ Sessions held: ${session.performance?.heldSessions ?? 0}/${session.performance?.expectedSessions ?? 0}`);
    lines.push(`â€¢ Active class days: ${session.performance?.classDays ?? 0}/${session.performance?.expectedDays ?? 0}`);
    lines.push(`â€¢ Attendance rate: ${session.performance?.attendanceRate ?? 0}%`);
    lines.push(`â€¢ Performance meter: ${session.performance?.meterValue ?? 0}/100`);
    lines.push(`â€¢ Target plan: ${session.sessions_per_week || 3} sessions per week, minimum ${session.min_days_per_week || 2} days per week, ${session.expected_duration_minutes || 45} minutes per session.`);
    if (session.rating) {
        lines.push(`â€¢ Trainee participation rating: ${session.rating}/5`);
    }
    lines.push('');
    lines.push('Review Answers:');
    session.answers?.forEach((answer, index) => {
        lines.push('');
        lines.push(`${index + 1}. ${REVIEW_QUESTIONS[index]}`);
        lines.push(`Answer: ${answer}`);
    });
    lines.push('');
    lines.push('--- End of Review ---');
    lines.push(`Generated on: ${dateToString(new Date())}`);
    return await getPdfBuffer('Weekly Review Report', lines, {
        logoPath: REPORT_LOGO_PATH,
        logoTag: REPORT_LOGOTAG
    });
};

async function getVerifiedTraineeIds(groupId) {
    const snapshot = await db.collection('group_verifications')
        .where('group_id', '==', groupId)
        .where('verified', '==', true)
        .where('removed', '==', false)
        .get();

    return snapshot.docs.map(doc => doc.data().user_id.toString());
}

async function sendDmUsers(userIds, text, extra = {}) {
    for (const userId of userIds) {
        if (!userId) continue;
        try {
            await bot.telegram.sendMessage(userId, text, extra);
        } catch (err) {
            console.log(`DM failed for ${userId}:`, err.message);
        }
    }
}

// ==========================================
// MODULE 1: SPECIALIST & CLASSROOM MANAGER
// ==========================================

bot.command('register', async (ctx) => {
    try {
        const messageText = ctx.message.text.split(' ');
        const password = messageText[1];

        if (password !== process.env.STAFF_PASSWORD) {
            return ctx.reply("âŒ Invalid Skillforge master password.");
        }

        const specialistId = ctx.from.id.toString();
        const specialistName = ctx.from.first_name || "Specialist";

        await db.collection('specialists').doc(specialistId).set({
            telegram_id: specialistId,
            name: specialistName,
            registered_at: admin.firestore.FieldValue.serverTimestamp()
        });

        ctx.reply(`âœ… Welcome to the team, Specialist ${specialistName}! \n\nYou are now authorized. Please go to your cohort's Telegram group, add me as an Admin, and type /claim to link the classroom.`);
    } catch (error) {
        console.log("Register Error:", error);
        ctx.reply("âŒ An error occurred during registration.");
    }
});

bot.command('claim', async (ctx) => {
    try {
        if (!(await requireSpecialist(ctx))) return;
        if (ctx.chat.type === 'private') {
            return ctx.reply('❌ You cannot claim a Direct Message! You must type this command inside the actual Skillforge Telegram Group.\n\n📍 Go to your Skillforge group → Type /claim');
        }

        const specialistId = ctx.from.id.toString();
        const groupId = ctx.chat.id.toString();
        const groupName = ctx.chat.title || 'Skillforge Classroom';

        const specialistDoc = await db.collection('specialists').doc(specialistId).get();
        if (!specialistDoc.exists) {
            return ctx.reply(`❌ You must be registered as a Specialist first!\n\n📝 Steps:\n1. Go to Direct Message: ${getBotMention()}\n2. Type: /register YOUR_PASSWORD\n\nNeed password? Contact your head of units.`);
        }

        const specialistData = specialistDoc.data();
        const specialistName = specialistData.name || 'Specialist';

        const existingRoomDoc = await db.collection('classrooms').doc(groupId).get();
        if (existingRoomDoc.exists) {
            const existing = existingRoomDoc.data();
            if (existing?.specialist_id && existing.specialist_id !== specialistId) {
                const ownerName = existing.specialist_name || 'another specialist';
                return ctx.reply(`❌ This group is already linked to ${ownerName}.\n\nIf you need to transfer ownership, contact your head of units.`);
            }
        }

        // Capture group info
        const groupData = {
            group_id: groupId,
            group_name: groupName,
            specialist_id: specialistId,
            specialist_name: specialistName,
            claimed_at: admin.firestore.FieldValue.serverTimestamp(),
            member_count: ctx.chat.members_count || 0
        };

        await db.collection('classrooms').doc(groupId).set(groupData);

        // Confirm via inline keyboard with next steps
        const menuButtons = [
            [Markup.button.callback('📅 Set Program Date', `setup_program_${groupId}`)],
            [Markup.button.callback('⏰ Schedule Class', `schedule_${groupId}`)]
        ];
        if (SERVER_URL) {
            menuButtons.push([Markup.button.url('📖 View Menu', `${SERVER_URL}/menu`)]);
        }

        ctx.reply(
            `✅ *Classroom Successfully Linked!*\n\n` +
            `📍 *Group:* ${groupName}\n` +
            `👤 *Specialist:* ${specialistName}\n` +
            `📊 *Members:* ${ctx.chat.members_count || 'Unknown'}\n\n` +
            `*Next Step:* Set your course program details`,
            Markup.inlineKeyboard(menuButtons)
        );

    } catch (error) {
        await reportError('Claim Error', error);
        ctx.reply('❌ An error occurred while claiming the group. Please try again or contact support.');
    }
})

bot.command('help', (ctx) => {
    const userId = ctx.from?.id ? String(ctx.from.id) : null;
    if (!userId) return;

    getUserRole(userId).then(({ role }) => {
        if (role !== 'specialist') {
            const helpText = `*Skillforge Bot (Trainee)*

• /verify - Verify your account (if you have a pending verification)
• /attended - Mark attendance for today's class (DM only)
• /missed - Mark absence for today's class (DM only)
• /help - Show this help`;
            return ctx.reply(helpText, { parse_mode: 'Markdown' });
        }

        const helpText = `*Skillforge Bot Commands*

` +
            `â€¢ /register <password> - Register as a Specialist.
` +
            `â€¢ /claim - Claim your Telegram classroom group.
` +
            `â€¢ /setclass <group_id> <HH:MM> [topic] - Schedule todayâ€™s live session with optional topic.
` +
            `â€¢ /rescheduleclass <group_id> <old_time> <new_time> - Move a session to a new time.
` +
            `â€¢ /cancelclass <group_id> [time] - Cancel one or all todayâ€™s sessions.
` +
            `â€¢ /classlist - Show all upcoming live sessions for your classrooms.
` +
            `â€¢ /status - Show your classroom status and todayâ€™s schedule.
` +
            `â€¢ /health - Check bot health and system status.
` +
            `â€¢ /attended - Confirm attendance for the current session (in DM).
` +
            `â€¢ /missed - Report missing the current session (in DM).
` +
            `â€¢ /backup <group_name> - Assign yourself as backup specialist.
` +
            `â€¢ /calendar [date] - List classes for a date (YYYY-MM-DD).
` +
            `â€¢ /report [date] - Get attendance report for your classes.
` +
            `â€¢ /weeklyreport - Generate weekly summary report (Saturdays only).
` +
            `â€¢ /setprogram <group_id> <YYYY-MM-DD> - Define course first class date and tracking plan.
` +
            `â€¢ /courseprogress <group_id> - Show weekly performance meter and plan progress.
` +
            `â€¢ /questionnaire - Download the staff questionnaire PDF.
` +
            `â€¢ /verify - Verify your trainee account in private chat.
` +
            `â€¢ /help - Show this message.`;
        return ctx.reply(helpText, { parse_mode: 'Markdown' });
    }).catch(() => {
        ctx.reply('Use /help again.');
    });
});

bot.command('status', async (ctx) => {
    try {
        if (!(await requireSpecialist(ctx))) return;
        if (ctx.chat.type === 'private') {
            const specialistId = ctx.from.id.toString();
            const specialistDoc = await db.collection('specialists').doc(specialistId).get();
            if (!specialistDoc.exists) {
                return ctx.reply("You are not registered as a Specialist yet. Use /register <password>.");
            }

            const todayStr = getLagosDateString();
            const classesSnapshot = await db.collection('classes')
                .where('specialist_id', '==', specialistId)
                .where('date', '==', todayStr)
                .where('status', '==', 'active')
                .get();

            let response = `*Your schedule for today (${todayStr})*\n`;
            if (classesSnapshot.empty) {
                response += '\nNo live sessions are scheduled today.';
            } else {
                for (const classDoc of classesSnapshot.docs) {
                    const classData = classDoc.data();
                    response += `\nâ€¢ ${classData.group_name} at *${classData.time}*`;
                }
            }

            const pendingSnapshot = await db.collection('group_verifications')
                .where('verified', '==', false)
                .where('timed_out', '==', false)
                .where('removed', '==', false)
                .get();
            response += `\n\nPending verifications in all groups: *${pendingSnapshot.size}*`;
            return ctx.reply(response, { parse_mode: 'Markdown' });
        }

        const groupId = ctx.chat.id.toString();
        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            return ctx.reply("This group has not been claimed yet.");
        }

        const todayStr = getLagosDateString();
        const classesSnapshot = await db.collection('classes')
            .where('group_id', '==', groupId)
            .where('date', '==', todayStr)
            .where('status', '==', 'active')
            .get();

        let response = `*${roomDoc.data().group_name}* status for today (${todayStr}):\n`;
        if (classesSnapshot.empty) {
            response += '\nNo live sessions are scheduled today.';
        } else {
            for (const classDoc of classesSnapshot.docs) {
                const classData = classDoc.data();
                response += `\nâ€¢ Live class at *${classData.time}*`;
            }
        }

        const pendingSnapshot = await db.collection('group_verifications')
            .where('group_id', '==', groupId)
            .where('verified', '==', false)
            .where('timed_out', '==', false)
            .where('removed', '==', false)
            .get();
        response += `\n\nPending verifications: *${pendingSnapshot.size}*`;
        ctx.reply(response, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('Status command failed', error);
        ctx.reply('âŒ Unable to fetch status right now. Please try again later.');
    }
});

bot.command('classlist', async (ctx) => {
    try {
        if (!(await requireSpecialist(ctx))) return;
        const specialistId = ctx.from.id.toString();
        const specialistDoc = await db.collection('specialists').doc(specialistId).get();
        if (!specialistDoc.exists) {
            return ctx.reply("You are not registered as a Specialist yet. Use /register <password>.");
        }

        const todayStr = getLagosDateString();
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = getLagosDateString(tomorrow);

        const classesSnapshot = await db.collection('classes')
            .where('specialist_id', '==', specialistId)
            .where('status', '==', 'active')
            .where('date', '>=', todayStr)
            .orderBy('date')
            .orderBy('time')
            .limit(20)
            .get();

        let response = `*Your Upcoming Live Sessions*\n`;
        if (classesSnapshot.empty) {
            response += '\nNo upcoming live sessions scheduled.';
        } else {
            let currentDate = '';
            for (const classDoc of classesSnapshot.docs) {
                const classData = classDoc.data();
                if (classData.date !== currentDate) {
                    currentDate = classData.date;
                    response += `\n**${currentDate}**`;
                }
                const topic = classData.topic ? ` - ${classData.topic}` : '';
                response += `\nâ€¢ ${classData.group_name} at *${classData.time}*${topic}`;
            }
        }

        ctx.reply(response, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('classlist command failed', error);
        ctx.reply('âŒ Unable to fetch class list right now. Please try again later.');
    }
});

bot.command('health', async (ctx) => {
    try {
        if (!(await requireSpecialist(ctx))) return;
        const specialistId = ctx.from.id.toString();
        const specialistDoc = await db.collection('specialists').doc(specialistId).get();
        if (!specialistDoc.exists) {
            return ctx.reply("You are not registered as a Specialist yet. Use /register <password>.");
        }

        const todayStr = getLagosDateString();
        const classesSnapshot = await db.collection('classes')
            .where('specialist_id', '==', specialistId)
            .where('date', '==', todayStr)
            .where('status', '==', 'active')
            .get();

        const pendingVerifications = await db.collection('group_verifications')
            .where('verified', '==', false)
            .where('timed_out', '==', false)
            .where('removed', '==', false)
            .get();

        const totalClasses = classesSnapshot.size;
        const totalPending = pendingVerifications.size;

        const uptime = process.uptime();
        const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

        let response = `*Bot Health Status*\n\n`;
        response += `â€¢ Uptime: ${uptimeStr}\n`;
        response += `â€¢ Today's Classes: ${totalClasses}\n`;
        response += `â€¢ Pending Verifications: ${totalPending}\n`;
        response += `â€¢ Timezone: Africa/Lagos\n`;
        response += `â€¢ Status: âœ… Operational`;

        ctx.reply(response, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('Health command failed', error);
        ctx.reply('âŒ Unable to check health right now.');
    }
});

// Attendance Commands
const recordAttendance = async (classId, userId, attended) => {
    await db.collection('attendance').doc(`${classId}_${userId}`).set({
        class_id: classId,
        user_id: userId,
        attended,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
};

const handleAttendanceCommand = async (ctx, attended) => {
    if (ctx.chat.type !== 'private') {
        return ctx.reply('Please use this command in a private chat with the bot.');
    }

    const userId = ctx.from.id.toString();
    const todayStr = getLagosDateString();

    const verifiedGroupsSnapshot = await db.collection('group_verifications')
        .where('user_id', '==', userId)
        .where('verified', '==', true)
        .where('removed', '==', false)
        .get();

    if (verifiedGroupsSnapshot.empty) {
        return ctx.reply('You are not verified. Please verify first.');
    }

    const candidateClasses = [];
    for (const membershipDoc of verifiedGroupsSnapshot.docs) {
        const membership = membershipDoc.data();
        const groupId = membership.group_id;
        const classesSnapshot = await db.collection('classes')
            .where('group_id', '==', groupId)
            .where('date', '==', todayStr)
            .where('status', '==', 'active')
            .orderBy('time', 'desc')
            .limit(1)
            .get();

        if (!classesSnapshot.empty) {
            const classDoc = classesSnapshot.docs[0];
            candidateClasses.push({ id: classDoc.id, data: classDoc.data() });
        }
    }

    if (!candidateClasses.length) {
        return ctx.reply('No active classes found for today.');
    }

    if (candidateClasses.length === 1) {
        const classDoc = candidateClasses[0];
        await recordAttendance(classDoc.id, userId, attended);
        const classData = classDoc.data;
        return ctx.reply(`${attended ? 'âœ… Attendance confirmed' : 'ðŸ“ Noted absence'} for **${classData.group_name}** at **${classData.time}**.${classData.topic ? ` Topic: ${classData.topic}` : ''}`, { parse_mode: 'Markdown' });
    }

    const buttons = candidateClasses.slice(0, 8).map((classDoc) => {
        const classData = classDoc.data;
        return [Markup.button.callback(`${classData.group_name} â€¢ ${classData.time}`, `attendance_pick_${attended ? 'attended' : 'missed'}_${classDoc.id}`)];
    });

    return ctx.reply('Select which class this applies to:', Markup.inlineKeyboard(buttons));
};

bot.command('attended', async (ctx) => {
    try {
        await handleAttendanceCommand(ctx, true);
    } catch (error) {
        await reportError('attended command failed', error);
        ctx.reply('âŒ Unable to record attendance right now. Please try again later.');
    }
});

bot.command('missed', async (ctx) => {
    try {
        await handleAttendanceCommand(ctx, false);
    } catch (error) {
        await reportError('missed command failed', error);
        ctx.reply('âŒ Unable to record absence right now. Please try again later.');
    }
});

bot.action(/^attendance_pick_(attended|missed)_(.+)$/, async (ctx) => {
    const mode = ctx.match[1];
    const classId = ctx.match[2];
    const attended = mode === 'attended';
    const userId = ctx.from.id.toString();
    try {
        const classDoc = await db.collection('classes').doc(classId).get();
        if (!classDoc.exists) {
            await ctx.reply('That class could not be found.');
            ctx.answerCbQuery();
            return;
        }

        await recordAttendance(classId, userId, attended);
        const classData = classDoc.data();
        await ctx.reply(`${attended ? 'âœ… Attendance confirmed' : 'ðŸ“ Noted absence'} for **${classData.group_name}** at **${classData.time}**.${classData.topic ? ` Topic: ${classData.topic}` : ''}`, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('attendance pick failed', error);
        await ctx.reply('âŒ Unable to save attendance right now. Please try again later.');
    }
    ctx.answerCbQuery();
});

// Assign Backup Specialist
bot.command('backup', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!(await requireSpecialist(ctx))) return;

    const userId = ctx.from.id.toString();
    const specialistDoc = await db.collection('specialists').doc(userId).get();
    if (!specialistDoc.exists) {
        return ctx.reply('You are not a registered specialist.');
    }

    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) {
        return ctx.reply('Usage: /backup <group_name>');
    }

    const groupName = args.join(' ');
    const groupSnapshot = await db.collection('classrooms').where('group_name', '==', groupName).get();
    if (groupSnapshot.empty) {
        return ctx.reply('Group not found.');
    }

    const groupDoc = groupSnapshot.docs[0];
    const groupData = groupDoc.data();
    if (groupData.specialist_id !== userId) {
        return ctx.reply('You are not the primary specialist for this group.');
    }

    await db.collection('classrooms').doc(groupDoc.id).update({
        backup_specialist_id: userId // For now, self-assign as backup, but can be extended
    });

    ctx.reply(`âœ… Backup specialist assigned for **${groupName}**.`);
});

// Calendar: List classes for a specific date
bot.command('calendar', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return;
    const args = ctx.message.text.split(' ').slice(1);
    let dateStr = getLagosDateString();
    if (args.length > 0) {
        dateStr = args[0]; // Assume YYYY-MM-DD format
    }

    const classesSnapshot = await db.collection('classes')
        .where('date', '==', dateStr)
        .orderBy('time')
        .get();

    if (classesSnapshot.empty) {
        return ctx.reply(`No classes scheduled for ${dateStr}.`);
    }

    let response = `ðŸ“… **Classes on ${dateStr}**\n\n`;
    classesSnapshot.forEach(doc => {
        const data = doc.data();
        response += `ðŸ•’ ${data.time} - ${data.group_name}${data.topic ? ` (${data.topic})` : ''}\n`;
    });

    ctx.reply(response, { parse_mode: 'Markdown' });
});

// Attendance Report for Specialists
bot.command('report', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!(await requireSpecialist(ctx))) return;

    const userId = ctx.from.id.toString();
    const specialistDoc = await db.collection('specialists').doc(userId).get();
    if (!specialistDoc.exists) {
        return ctx.reply('You are not a registered specialist.');
    }

    const args = ctx.message.text.split(' ').slice(1);
    let dateStr = getLagosDateString();
    if (args.length > 0) {
        dateStr = args[0];
    }

    const classesSnapshot = await db.collection('classes')
        .where('specialist_id', '==', userId)
        .where('date', '==', dateStr)
        .get();

    if (classesSnapshot.empty) {
        return ctx.reply(`No classes found for ${dateStr}.`);
    }

    let response = `ðŸ“Š **Attendance Report for ${dateStr}**\n\n`;
    for (const doc of classesSnapshot.docs) {
        const classData = doc.data();
        const attendanceSnapshot = await db.collection('attendance')
            .where('class_id', '==', doc.id)
            .get();

        const attended = attendanceSnapshot.docs.filter(d => d.data().attended).length;
        const missed = attendanceSnapshot.docs.filter(d => !d.data().attended).length;
        const total = attended + missed;

        response += `**${classData.group_name}** at ${classData.time}:\n`;
        response += `  Attended: ${attended}\n`;
        response += `  Missed: ${missed}\n`;
        response += `  Total: ${total}\n\n`;
    }

    ctx.reply(response, { parse_mode: 'Markdown' });
});

// Weekly Report for Specialists (Available on Saturdays)
bot.command('weeklyreport', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!(await requireSpecialist(ctx))) return;

    const userId = ctx.from.id.toString();
    const specialistDoc = await db.collection('specialists').doc(userId).get();
    if (!specialistDoc.exists) {
        return ctx.reply('You are not a registered specialist.');
    }

    // Check if today is Saturday
    const today = new Date();
    if (today.getDay() !== 6) { // 0=Sunday, 6=Saturday
        return ctx.reply('Weekly reports are only available on Saturdays.');
    }

    // Calculate last week: Monday to Sunday
    const lastMonday = new Date(today);
    lastMonday.setDate(today.getDate() - today.getDay() - 6); // Go back to last Monday
    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastMonday.getDate() + 6);

    const mondayStr = getLagosDateString(lastMonday);
    const sundayStr = getLagosDateString(lastSunday);

    // Get all classes for the specialist in the past week
    const classesSnapshot = await db.collection('classes')
        .where('specialist_id', '==', userId)
        .where('date', '>=', mondayStr)
        .where('date', '<=', sundayStr)
        .get();

    let totalScheduled = 0;
    let totalHeld = 0;
    let totalAttendance = 0;
    let totalPossibleAttendance = 0;
    let feedbackList = [];

    for (const classDoc of classesSnapshot.docs) {
        const classData = classDoc.data();
        totalScheduled += 1;

        // Check if class was held (has attendance records)
        const attendanceSnapshot = await db.collection('attendance')
            .where('class_id', '==', classDoc.id)
            .get();

        if (!attendanceSnapshot.empty) {
            totalHeld += 1;
            const attendedCount = attendanceSnapshot.docs.filter(d => d.data().attended).length;
            totalAttendance += attendedCount;
            totalPossibleAttendance += attendanceSnapshot.size;
        }

        // Get feedback
        const feedbackSnapshot = await db.collection('feedback')
            .where('class_id', '==', classDoc.id)
            .get();

        feedbackSnapshot.forEach(fb => {
            feedbackList.push(fb.data().feedback);
        });
    }

    const attendanceRate = totalPossibleAttendance > 0 ? ((totalAttendance / totalPossibleAttendance) * 100).toFixed(1) : 0;

    // Generate report
    let report = `ðŸ“Š **Weekly Report for ${specialistDoc.data().name}**\n`;
    report += `Period: ${mondayStr} to ${sundayStr}\n\n`;
    report += `ðŸ“… **Class Statistics**\n`;
    report += `â€¢ Classes Scheduled: ${totalScheduled}\n`;
    report += `â€¢ Classes Held: ${totalHeld}\n`;
    report += `â€¢ Classes Missed: ${totalScheduled - totalHeld}\n\n`;
    report += `ðŸ‘¥ **Attendance Overview**\n`;
    report += `â€¢ Total Attendance: ${totalAttendance}/${totalPossibleAttendance}\n`;
    report += `â€¢ Attendance Rate: ${attendanceRate}%\n\n`;
    report += `ðŸŽ¯ **Program Tracking Note**\n`;
    report += `â€¢ Target: 3 sessions per week, at least 2 unique class days, 45 minutes per session.\n`;
    report += `â€¢ Use /courseprogress <group_id> for the course performance meter and detailed weekly status.\n\n`;

    if (feedbackList.length > 0) {
        report += `ðŸ“ **Feedback Summary**\n`;
        report += `Total Feedback Received: ${feedbackList.length}\n\n`;
        // Simple sentiment analysis (count ratings)
        const ratings = feedbackList.filter(f => /\b[1-5]\b/.test(f)).map(f => parseInt(f.match(/\b[1-5]\b/)[0]));
        if (ratings.length > 0) {
            const avgRating = (ratings.reduce((a,b)=>a+b,0) / ratings.length).toFixed(1);
            report += `Average Rating: ${avgRating}/5 â­\n\n`;
        }
        report += `Recent Comments:\n`;
        feedbackList.slice(-5).forEach((fb, i) => {
            report += `${i+1}. ${fb.length > 100 ? fb.substring(0,100)+'...' : fb}\n`;
        });
    } else {
        report += `ðŸ“ No feedback received this week.\n`;
    }

    report += `\n--- End of Report ---\n`;
    report += `Generated on: ${getLagosDateString()}`;

    // Send as message (for "download", user can copy-paste)
    ctx.reply(report, { parse_mode: 'Markdown' });

    // Optional: Send as file
    const reportBuffer = Buffer.from(report.replace(/\*/g, '').replace(/`/g, ''), 'utf-8');
    await ctx.replyWithDocument({ source: reportBuffer, filename: `weekly_report_${mondayStr}_to_${sundayStr}.txt` });
});

bot.command('setprogram', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!(await requireSpecialist(ctx))) return;

    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
        return ctx.reply('Usage: /setprogram <group_id> <YYYY-MM-DD>\nExample: /setprogram -100123456 2026-05-05');
    }

    const [groupId, startDateStr] = args;
    const startDate = parseDateString(startDateStr);
    if (!startDate) {
        return ctx.reply('Invalid date format. Use YYYY-MM-DD.');
    }

    const roomDoc = await db.collection('classrooms').doc(groupId).get();
    if (!roomDoc.exists) {
        return ctx.reply('That group is not linked to a classroom yet.');
    }

    const room = roomDoc.data();
    const specialistId = ctx.from.id.toString();
    if (specialistId !== room.specialist_id) {
        return ctx.reply('Only the linked Specialist can set the course program.');
    }

    const weeks = 3;
    const sessionsPerWeek = 3;
    const minDaysPerWeek = 2;
    const expectedDurationMinutes = 45;
    const endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + (weeks * 7) - 1);

    await db.collection('classrooms').doc(groupId).update({
        course_start_date: dateToString(startDate),
        course_end_date: dateToString(endDate),
        course_weeks: weeks,
        sessions_per_week: sessionsPerWeek,
        min_days_per_week: minDaysPerWeek,
        expected_duration_minutes: expectedDurationMinutes,
        expected_total_sessions: weeks * sessionsPerWeek
    });

    ctx.reply(`âœ… Course program saved for **${room.group_name}**.\nStart Date: ${dateToString(startDate)}\nEnd Date: ${dateToString(endDate)}\nExpected: ${sessionsPerWeek} sessions per week, ${expectedDurationMinutes} minutes each, for ${weeks} weeks.`);
});

bot.command('courseprogress', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!(await requireSpecialist(ctx))) return;

    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) {
        return ctx.reply('Usage: /courseprogress <group_id>');
    }

    const groupId = args[0];
    const roomDoc = await db.collection('classrooms').doc(groupId).get();
    if (!roomDoc.exists) {
        return ctx.reply('That group is not linked to a classroom yet.');
    }

    const room = roomDoc.data();
    if (!room.course_start_date) {
        return ctx.reply(`No course program is defined for **${room.group_name}**.\nPlease set the first class date with /setprogram ${groupId} YYYY-MM-DD.`);
    }

    const startDate = parseDateString(room.course_start_date);
    const endDate = parseDateString(room.course_end_date);
    const today = new Date();
    const isStarted = today >= startDate;
    const weeks = room.course_weeks || 3;
    const sessionsPerWeek = room.sessions_per_week || 3;
    const minDaysPerWeek = room.min_days_per_week || 2;

    const daysSinceStart = isStarted ? Math.floor((today - startDate) / (1000 * 60 * 60 * 24)) : 0;
    const weekIndex = isStarted ? Math.min(weeks, Math.floor(daysSinceStart / 7) + 1) : 0;
    const statusLabel = isStarted ? `Started (Week ${weekIndex} of ${weeks})` : 'Not started yet';

    const weekBounds = getWeekBounds(today);
    const performance = await getWeekPerformance(groupId, weekBounds.monday, weekBounds.sunday, room);

    let response = `ðŸ“ˆ **Course Progress for ${room.group_name}**\n`;
    response += `â€¢ Course start: ${room.course_start_date}\n`;
    response += `â€¢ Course end: ${room.course_end_date}\n`;
    response += `â€¢ Status: ${statusLabel}\n\n`;
    response += `**Weekly Performance Meter**\n`;
    response += `â€¢ Sessions held this week: ${performance.heldSessions}/${performance.expectedSessions}\n`;
    response += `â€¢ Active class days this week: ${performance.classDays}/${performance.expectedDays}\n`;
    response += `â€¢ Attendance rate: ${performance.attendanceRate}%\n`;
    response += `â€¢ Performance meter: ${performance.meterValue}/100\n\n`;
    response += `**Plan targets**\n`;
    response += `â€¢ ${sessionsPerWeek} classes per week\n`;
    response += `â€¢ Minimum ${minDaysPerWeek} class days per week\n`;
    response += `â€¢ ${room.expected_duration_minutes || 45} minutes per session\n`;
    response += `â€¢ Total planned sessions: ${room.expected_total_sessions || weeks * sessionsPerWeek}\n`;

    if (isStarted) {
        response += `\nâœ… The course has officially started.`;
    } else {
        response += `\nâ³ The course has not started yet. First class is scheduled for ${room.course_start_date}.`;
    }

    ctx.reply(response, { parse_mode: 'Markdown' });
});

bot.command('questionnaire', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!(await requireSpecialist(ctx))) return;

    const args = ctx.message.text.split(' ').slice(1);
    const specialistId = ctx.from.id.toString();

    const specialistDoc = await db.collection('specialists').doc(specialistId).get();
    if (!specialistDoc.exists) {
        return ctx.reply('You are not a registered specialist.');
    }

    let groupId = args[0] || null;
    if (!groupId) {
        const groupsSnapshot = await db.collection('classrooms')
            .where('specialist_id', '==', specialistId)
            .get();

        if (groupsSnapshot.empty) {
            return ctx.reply('You have no classroom groups linked yet. Use /claim in a group first.');
        }

        if (groupsSnapshot.size === 1) {
            groupId = groupsSnapshot.docs[0].id;
        } else {
            let listResponse = 'You have multiple classroom groups. Please run /questionnaire <group_id> with one of these group IDs:\n';
            groupsSnapshot.docs.forEach(doc => {
                const room = doc.data();
                listResponse += `â€¢ ${room.group_name}: ${doc.id}\n`;
            });
            return ctx.reply(listResponse);
        }
    }

    const roomDoc = await db.collection('classrooms').doc(groupId).get();
    if (!roomDoc.exists) {
        return ctx.reply('That group is not linked to a classroom.');
    }

    const room = roomDoc.data();
    if (room.specialist_id !== specialistId) {
        return ctx.reply('You are not the linked specialist for that group.');
    }

    const today = new Date();
    const weekBounds = getWeekBounds(today);
    const sessionRef = db.collection('questionnaire_sessions').doc();
    const sessionId = sessionRef.id;

    await sessionRef.set({
        user_id: specialistId,
        specialist_id: specialistId,
        group_id: groupId,
        group_name: room.group_name,
        status: 'pending',
        current_step: 0,
        answers: [],
        week_start: dateToString(weekBounds.monday),
        week_end: dateToString(weekBounds.sunday),
        course_weeks: room.course_weeks || 3,
        sessions_per_week: room.sessions_per_week || 3,
        min_days_per_week: room.min_days_per_week || 2,
        expected_duration_minutes: room.expected_duration_minutes || 45,
        expected_total_sessions: room.expected_total_sessions || 9,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    const message = `ðŸ“‹ Weekly review ready for *${room.group_name}*\nPeriod: *${dateToString(weekBounds.monday)}* to *${dateToString(weekBounds.sunday)}*\n\nAre you ready to take your weekly review?`;
    await ctx.reply(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([Markup.button.callback('Yes, start review', `review_start_${sessionId}`)])
    });
});

bot.action('report_weekly', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    ctx.editMessageText('Generating weekly report...');
    ctx.answerCbQuery();
});

bot.action('report_attendance', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    ctx.editMessageText('Generating attendance report...');
    ctx.answerCbQuery();
});

bot.action('report_progress', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    ctx.editMessageText('Generating course progress report...');
    ctx.answerCbQuery();
});

bot.action('settings_name', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    ctx.editMessageText('To change your name, reply with your new name.');
    ctx.answerCbQuery();
});

bot.action('settings_profile', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    const specialistId = ctx.from.id.toString();
    const specialistDoc = await db.collection('specialists').doc(specialistId).get();
    if (specialistDoc.exists) {
        const data = specialistDoc.data();
        ctx.editMessageText(`Profile:\nName: ${data.name}\nRegistered: ${data.registered_at.toDate().toLocaleDateString()}`);
    }
    ctx.answerCbQuery();
});

// Handle feedback messages in private chat and active review sessions
bot.on('text', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    const userId = ctx.from.id.toString();
    const messageText = ctx.message.text;

    if (!messageText || messageText.startsWith('/')) {
        return;
    }

    const activeSessionSnapshot = await db.collection('questionnaire_sessions')
        .where('user_id', '==', userId)
        .where('status', '==', 'in_progress')
        .orderBy('created_at', 'desc')
        .limit(1)
        .get();

    if (!activeSessionSnapshot.empty) {
        const sessionId = activeSessionSnapshot.docs[0].id;
        const session = activeSessionSnapshot.docs[0].data();
        const step = session.current_step || 0;
        const answers = session.answers || [];
        answers[step] = messageText;

        const nextStep = step + 1;
        const updatePayload = {
            answers,
            current_step: nextStep,
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        };

        if (nextStep < REVIEW_QUESTIONS.length) {
            await db.collection('questionnaire_sessions').doc(sessionId).update(updatePayload);
            await ctx.reply(`Question ${nextStep + 1} of ${REVIEW_QUESTIONS.length}: ${REVIEW_QUESTIONS[nextStep]}`);
            return;
        }

        const sessionRef = db.collection('questionnaire_sessions').doc(sessionId);
        const performance = await getWeekPerformance(
            session.group_id,
            parseDateString(session.week_start),
            parseDateString(session.week_end),
            {
                sessions_per_week: session.sessions_per_week,
                min_days_per_week: session.min_days_per_week
            }
        );

        const ratingAnswer = answers[3] || '';
        const ratingMatch = ratingAnswer.match(/\b([1-5])\b/);
        const rating = ratingMatch ? Number(ratingMatch[1]) : null;

        const completedPayload = {
            ...updatePayload,
            status: 'completed',
            performance,
            rating,
            completed_at: admin.firestore.FieldValue.serverTimestamp()
        };

        await sessionRef.update(completedPayload);

        const completedSession = { id: sessionId, ...session, ...completedPayload };
        const pdfBuffer = await buildReviewPdf(completedSession);

        await ctx.reply('âœ… Weekly review completed! Generating your PDF now...');
        await ctx.replyWithDocument({ source: pdfBuffer, filename: `weekly_review_${session.group_name}_${session.week_start}_to_${session.week_end}.pdf` });
        if (SERVER_URL) {
            await ctx.reply(`You can also download it again here:\n${SERVER_URL}/review/${sessionId}`);
        }
        return;
    }

    const scheduleSessionDoc = await db.collection('schedule_sessions').doc(userId).get();
    if (scheduleSessionDoc.exists && scheduleSessionDoc.data().status === 'awaiting_time') {
        const scheduleSession = scheduleSessionDoc.data();
        const expiresAt = scheduleSession.expires_at?.toDate ? scheduleSession.expires_at.toDate() : null;
        if (expiresAt && expiresAt.getTime() <= Date.now()) {
            await db.collection('schedule_sessions').doc(userId).update({
                status: 'expired',
                expired_at: admin.firestore.FieldValue.serverTimestamp()
            });
            await ctx.reply('Your scheduling session has expired. Please tap Yes again to start scheduling.');
            return;
        }

        const [timeInput, ...topicParts] = messageText.trim().split(/\s+/);
        if (!CLASS_TIME_REGEX.test(timeInput)) {
            await ctx.reply('âŒ Time format should be HH:MM in 24-hour format. Example: 14:00 Introduction to JavaScript');
            return;
        }

        const topic = topicParts.join(' ') || null;
        try {
            await scheduleLiveClass({
                groupId: scheduleSession.group_id,
                specialistId: userId,
                timeInput,
                topic,
                dateStr: scheduleSession.date || null,
                telegram: ctx.telegram,
                reply: (text, extra) => ctx.reply(text, extra)
            });

            await db.collection('schedule_sessions').doc(userId).set({
                ...scheduleSession,
                status: 'completed',
                scheduled_time: timeInput,
                topic,
                completed_at: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (error) {
            await reportError('Schedule session failed', error);
            await ctx.reply('âŒ Failed to schedule the class. Please try again or tap Yes again to restart.');
        }
        return;
    }

    // Check if this is a feedback response (simple heuristic: contains rating or is reply)
    if (messageText.match(/\b[1-5]\b/) || messageText.length > 10) {
        const todayStr = getLagosDateString();
        const verifiedGroupsSnapshot = await db.collection('group_verifications')
            .where('user_id', '==', userId)
            .where('verified', '==', true)
            .where('removed', '==', false)
            .get();
        if (verifiedGroupsSnapshot.empty) return;

        let bestClass = null;
        for (const membershipDoc of verifiedGroupsSnapshot.docs) {
            const membership = membershipDoc.data();
            const groupId = membership.group_id;
            const recentClasses = await db.collection('classes')
                .where('group_id', '==', groupId)
                .where('date', '==', todayStr)
                .where('feedback_sent', '==', true)
                .orderBy('time', 'desc')
                .limit(1)
                .get();

            if (!recentClasses.empty) {
                const classDoc = recentClasses.docs[0];
                const classData = classDoc.data();
                if (!bestClass || String(classData.time) > String(bestClass.data.time)) {
                    bestClass = { id: classDoc.id, data: classData };
                }
            }
        }

        if (bestClass) {
            await db.collection('feedback').add({
                class_id: bestClass.id,
                user_id: userId,
                feedback: messageText,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            ctx.reply('âœ… Thank you for your feedback!');
        }
    }
});

// Morning Class Check (Runs every day at 8:00 AM Lagos Time)
// ==========================================
// CALLBACK HANDLERS FOR INLINE BUTTONS
// ==========================================

bot.action('dashboard', (ctx) => {
    requireSpecialist(ctx).then((ok) => {
        if (!ok) return ctx.answerCbQuery();
        ctx.reply('📋 Dashboard coming soon! Use /status to see your daily overview.');
        ctx.answerCbQuery();
    }).catch(() => ctx.answerCbQuery());
});

bot.action('schedule_class', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await sendScheduleGroupPicker(ctx, userId);
    ctx.answerCbQuery();
});

bot.action('submit_report', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    const today = new Date();
    if (today.getDay() !== 6) {
        return ctx.answerCbQuery('Reports can only be submitted on Saturdays!');
    }
    ctx.reply('📝 Starting weekly report. Use /weeklyreport or click the button below:', 
        Markup.inlineKeyboard([
            [Markup.button.callback('Start Report Now', 'start_report')]
        ])
    );
    ctx.answerCbQuery();
});

bot.action('start_report', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    ctx.reply('📊 Weekly Report started. Please answer the questions...');
    ctx.answerCbQuery();
});

bot.action('help_info', (ctx) => {
    const userId = ctx.from?.id ? String(ctx.from.id) : null;
    if (!userId) return ctx.answerCbQuery();

    getUserRole(userId).then(({ role }) => {
        if (role !== 'specialist') {
            ctx.reply(
                `*📚 Skillforge Bot Help (Trainee)*\n\n` +
                `*Key Commands:*\n` +
                `✅ /verify - Verify your account\n` +
                `🟢 /attended - Mark attendance (DM only)\n` +
                `🔴 /missed - Mark absence (DM only)\n` +
                `❓ /help - Full help\n\n` +
                `If you can’t verify, join your classroom group and tap the Verify button there.`,
                { parse_mode: 'Markdown' }
            );
        } else {
            ctx.reply(
                `*📚 Skillforge Bot Help (Staff)*\n\n` +
                `*Key Commands:*\n` +
                `📝 /register - Register as specialist\n` +
                `🏢 /claim - Link your classroom\n` +
                `📅 /setclass - Schedule class\n` +
                `📊 /weeklyreport - Submit report\n` +
                `❓ /help - Full help menu\n\n` +
                `*Need More Help?*\n` +
                `Contact: support@skillforge.com`,
                { parse_mode: 'Markdown' }
            );
        }
        ctx.answerCbQuery('Help opened');
    }).catch(() => {
        ctx.answerCbQuery();
    });
});

bot.action('trainee_attendance_help', async (ctx) => {
    await ctx.reply('Use /attended or /missed in DM after a class. If multiple classes apply, you will be asked to pick one.');
    ctx.answerCbQuery();
});

bot.action('trainee_verify', async (ctx) => {
    try {
        await handleVerification(ctx);
    } catch (error) {
        await reportError('trainee verify callback failed', error);
        await ctx.reply('❌ Unable to verify right now. Please try again later.');
    }
    ctx.answerCbQuery();
});

bot.action(/^setup_program_(.+)$/, async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    const groupId = ctx.match[1];
    ctx.reply(
        `📅 *Setup Program Date*\n\n` +
        `Please reply with the start date in format: YYYY-MM-DD\n\n` +
        `Example: 2026-04-24`,
        { parse_mode: 'Markdown' }
    );
    ctx.answerCbQuery();
});

const beginScheduleSession = async (ctx, groupId, dateStr = null) => {
    const specialistId = ctx.from.id.toString();
    const roomDoc = await db.collection('classrooms').doc(groupId).get();
    if (!roomDoc.exists) {
        await ctx.reply('That group is not linked to a classroom yet.');
        return false;
    }

    const room = roomDoc.data();
    if (room.specialist_id !== specialistId) {
        await ctx.reply('Only the linked Specialist can schedule this group.');
        return false;
    }

    const effectiveDate = dateStr || getLagosDateString();
    const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + (2 * 60 * 60 * 1000)));
    await db.collection('schedule_sessions').doc(specialistId).set({
        specialist_id: specialistId,
        group_id: groupId,
        group_name: room.group_name,
        date: effectiveDate,
        status: 'awaiting_time',
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        expires_at: expiresAt
    }, { merge: true });

    await ctx.reply(
        `⏰ *Schedule Class for ${room.group_name}*\n\nSend the time in HH:MM format (24-hour) and an optional topic.\n\nExample:\n14:30 Introduction to Node.js`,
        { parse_mode: 'Markdown' }
    );
    return true;
};

bot.action(/^schedule_(.+)$/, async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    const groupId = ctx.match[1];
    try {
        await beginScheduleSession(ctx, groupId);
    } catch (error) {
        await reportError('schedule callback failed', error);
        await ctx.reply('âŒ Unable to start scheduling right now.');
    }
    ctx.answerCbQuery();
});

cron.schedule('0 8 * * *', async () => {
    try {
        const classroomsSnapshot = await db.collection('classrooms').get();
        if (classroomsSnapshot.empty) return;
        const todayStr = getLagosDateString();

        for (const doc of classroomsSnapshot.docs) {
            const room = doc.data();
            const message = `Good morning Specialist ${room.specialist_name}! â˜€ï¸\n\nWill there be a live session for **${room.group_name}** today?`;
            try {
                await bot.telegram.sendMessage(room.specialist_id, message, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('Yes ✅', `daily_prompt_yes_${room.group_id}_${todayStr}`)],
                        [Markup.button.callback('No ❌', `daily_prompt_no_${room.group_id}_${todayStr}`)]
                    ])
                });
            } catch (error) {
                await reportError(`Failed to message specialist for ${room.group_name}`, error);
            }
        }
    } catch (error) {
        await reportError('Daily 8am prompt job failed', error);
    }
}, { timezone: "Africa/Lagos" });

bot.action(/^daily_prompt_yes_(.+)_([0-9]{4}-[0-9]{2}-[0-9]{2})$/, async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    const groupId = ctx.match[1];
    const dateStr = ctx.match[2];
    try {
        const ok = await beginScheduleSession(ctx, groupId, dateStr);
        if (ok) {
            await ctx.reply('Send the time now and I will schedule it.');
        }
    } catch (error) {
        await reportError('daily prompt yes failed', error);
        await ctx.reply('âŒ Unable to start scheduling right now.');
    }
    ctx.answerCbQuery();
});

bot.action(/^daily_prompt_no_(.+)_([0-9]{4}-[0-9]{2}-[0-9]{2})$/, async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    const groupId = ctx.match[1];
    try {
        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        const roomName = roomDoc.exists ? roomDoc.data().group_name : 'your classroom';
        await ctx.reply(`Okay. No class scheduled for ${roomName} today.`);
    } catch (error) {
        await reportError('daily prompt no failed', error);
        await ctx.reply('Okay.');
    }
    ctx.answerCbQuery();
});

const scheduleLiveClass = async ({ groupId, specialistId, timeInput, topic, dateStr, telegram, reply }) => {
    const roomDoc = await db.collection('classrooms').doc(groupId).get();
    if (!roomDoc.exists) {
        throw new Error('âŒ That group is not linked to a classroom. Have the Specialist claim the group first.');
    }

    const room = roomDoc.data();
    if (specialistId !== room.specialist_id) {
        throw new Error('âŒ Only the linked Specialist can schedule this group.');
    }

    if (!room.course_start_date) {
        if (reply) {
            await reply(`âš ï¸ I recommend setting the first course date for this group with:\n/setprogram ${groupId} YYYY-MM-DD\nThis allows the performance meter and weekly tracking to work correctly.`);
        }
    }

    const todayStr = dateStr || getLagosDateString();
    const classId = getClassDocId(groupId, todayStr, timeInput);
    await db.collection('classes').doc(classId).set({
        date: todayStr,
        time: timeInput,
        topic: topic,
        reminder_30_sent: false,
        reminder_15_sent: false,
        reminder_5_sent: false,
        reminder_0_sent: false,
        feedback_sent: false,
        group_id: groupId,
        specialist_id: room.specialist_id,
        group_name: room.group_name,
        status: 'active',
        created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    const topicText = topic ? `\n\n**Topic:** ${topic}` : '';
    const announcementText = `ðŸ“¢ **Live Session Scheduled**\n\nA live session for **${room.group_name}** is confirmed at **${timeInput}** on ${todayStr}.${topicText}\n\nI will pin this announcement and send personal reminders to the Specialist and verified trainees at 30, 15, and 5 minutes before class.`;
    try {
        const sentMessage = await telegram.sendMessage(groupId, announcementText, { parse_mode: 'Markdown' });
        await telegram.pinChatMessage(groupId, sentMessage.message_id, { disable_notification: true });
    } catch (error) {
        await reportError('Could not announce or pin the class message', error);
    }

    if (reply) {
        await reply(`âœ… Locked in! Class for **${room.group_name}** is set for ${timeInput} on ${todayStr}. I have announced it and will send reminders. ðŸš€`, { parse_mode: 'Markdown' });
    }

    const verifiedTrainees = await getVerifiedTraineeIds(groupId);
    const reminderText = `âœ… Live session for **${room.group_name}** is scheduled at **${timeInput}** on ${todayStr}.${topic ? ` Topic: ${topic}` : ''} I will remind you 30, 15, and 5 minutes before the class.`;
    await sendDmUsers(normalizeUserIds([room.specialist_id, ...verifiedTrainees]), reminderText, { parse_mode: 'Markdown' });

    return { room, todayStr, classId };
};

bot.command('setclass', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return;
    try {
        const args = ctx.message.text.split(' ');
        const groupId = args[1];
        const timeInput = args[2];
        const topic = args.slice(3).join(' ') || null;

        if (!groupId || !timeInput) {
            return ctx.reply("âŒ Format error. Please use: /setclass <group_id> <time> [topic]\nExample: /setclass -100123456 14:00 Introduction to JavaScript");
        }

        if (!CLASS_TIME_REGEX.test(timeInput)) {
            return ctx.reply("âŒ Time format should be HH:MM in 24-hour format. Example: /setclass -100123456 14:00");
        }
        const specialistId = ctx.from.id.toString();
        await scheduleLiveClass({
            groupId,
            specialistId,
            timeInput,
            topic,
            telegram: ctx.telegram,
            reply: (text, extra) => ctx.reply(text, extra)
        });
    } catch (error) {
        if (error?.message) {
            const handled = error.message.startsWith('âŒ') || error.message.startsWith('❌');
            if (handled) {
                return ctx.reply(error.message);
            }
        }
        await reportError('setclass command failed', error);
        return ctx.reply('âŒ Failed to schedule the class. Please try again.');
    }
});

bot.command('cancelclass', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return;
    try {
        const args = ctx.message.text.split(' ');
        const groupId = args[1];
        const timeInput = args[2];

        if (!groupId) {
            return ctx.reply("âŒ Format error. Please use: /cancelclass <group_id> [time]\nExample: /cancelclass -100123456 14:00");
        }

        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            return ctx.reply('âŒ That group is not linked to a classroom.');
        }

        const room = roomDoc.data();
        const specialistId = ctx.from.id.toString();
        if (specialistId !== room.specialist_id) {
            return ctx.reply('âŒ Only the linked Specialist can cancel the class.');
        }

        const todayStr = getLagosDateString();
        let canceledCount = 0;

        if (timeInput) {
            if (!CLASS_TIME_REGEX.test(timeInput)) {
                return ctx.reply('âŒ Time format should be HH:MM in 24-hour format.');
            }
            const classId = getClassDocId(groupId, todayStr, timeInput);
            const classDoc = await db.collection('classes').doc(classId).get();
            if (!classDoc.exists || classDoc.data().status !== 'active') {
                return ctx.reply('âŒ No active class scheduled at that time.');
            }
            await db.collection('classes').doc(classId).update({ status: 'canceled', canceled_at: admin.firestore.FieldValue.serverTimestamp() });
            canceledCount = 1;
        } else {
            const snapshot = await db.collection('classes')
                .where('group_id', '==', groupId)
                .where('date', '==', todayStr)
                .where('status', '==', 'active')
                .get();
            if (snapshot.empty) {
                return ctx.reply('âŒ No active classes scheduled for today to cancel.');
            }
            for (const classDoc of snapshot.docs) {
                await db.collection('classes').doc(classDoc.id).update({ status: 'canceled', canceled_at: admin.firestore.FieldValue.serverTimestamp() });
                canceledCount += 1;
            }
        }

        const cancelMessage = `âš ï¸ The live session${timeInput ? ` at ${timeInput}` : ''} for **${room.group_name}** has been canceled.`;
        await ctx.telegram.sendMessage(groupId, cancelMessage, { parse_mode: 'Markdown' });
        ctx.reply(`âœ… Canceled ${canceledCount} scheduled class(es).`);
    } catch (error) {
        await reportError('cancelclass command failed', error);
        ctx.reply('âŒ Failed to cancel the class. Please try again.');
    }
});

bot.command('rescheduleclass', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        const groupId = args[1];
        const oldTime = args[2];
        const newTime = args[3];

        if (!groupId || !oldTime || !newTime) {
            return ctx.reply('âŒ Format error. Please use: /rescheduleclass <group_id> <old_time> <new_time>\nExample: /rescheduleclass -100123456 14:00 15:00');
        }

        if (!CLASS_TIME_REGEX.test(oldTime) || !CLASS_TIME_REGEX.test(newTime)) {
            return ctx.reply('âŒ Time format should be HH:MM in 24-hour format.');
        }

        if (oldTime === newTime) {
            return ctx.reply('âš ï¸ The new time must be different from the old time.');
        }

        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            return ctx.reply('âŒ That group is not linked to a classroom.');
        }

        const room = roomDoc.data();
        const specialistId = ctx.from.id.toString();
        if (specialistId !== room.specialist_id) {
            return ctx.reply('âŒ Only the linked Specialist can reschedule this class.');
        }

        const todayStr = getLagosDateString();
        const oldClassId = getClassDocId(groupId, todayStr, oldTime);
        const oldClassDoc = await db.collection('classes').doc(oldClassId).get();
        if (!oldClassDoc.exists || oldClassDoc.data().status !== 'active') {
            return ctx.reply('âŒ No active class exists at the old time.');
        }

        const newClassId = getClassDocId(groupId, todayStr, newTime);
        const existingNewClass = await db.collection('classes').doc(newClassId).get();
        if (existingNewClass.exists && existingNewClass.data().status === 'active') {
            return ctx.reply('âŒ A class is already scheduled at the new time.');
        }

        await db.collection('classes').doc(oldClassId).update({ status: 'rescheduled', canceled_at: admin.firestore.FieldValue.serverTimestamp() });
        await db.collection('classes').doc(newClassId).set({
            date: todayStr,
            time: newTime,
            topic: oldClassDoc.data().topic || null,
            reminder_30_sent: false,
            reminder_15_sent: false,
            reminder_5_sent: false,
            reminder_0_sent: false,
            group_id: groupId,
            specialist_id: room.specialist_id,
            group_name: room.group_name,
            status: 'active',
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });

        const announcementText = `ðŸ”„ **Class Rescheduled**\n\nThe live session for **${room.group_name}** has been moved from **${oldTime}** to **${newTime}** today.${oldClassDoc.data().topic ? `\n\n**Topic:** ${oldClassDoc.data().topic}` : ''}`;
        try {
            const sentMessage = await ctx.telegram.sendMessage(groupId, announcementText, { parse_mode: 'Markdown' });
            await ctx.telegram.pinChatMessage(groupId, sentMessage.message_id, { disable_notification: true });
        } catch (error) {
            await reportError('Could not announce or pin the rescheduled class message', error);
        }

        ctx.reply(`âœ… Rescheduled class from ${oldTime} to ${newTime}.`);

        const verifiedTrainees = await getVerifiedTraineeIds(groupId);
        const reminderText = `ðŸ”„ The live session for **${room.group_name}** has been rescheduled to **${newTime}** today.${oldClassDoc.data().topic ? ` Topic: ${oldClassDoc.data().topic}` : ''}`;
        await sendDmUsers(normalizeUserIds([room.specialist_id, ...verifiedTrainees]), reminderText, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('rescheduleclass command failed', error);
        ctx.reply('âŒ Failed to reschedule the class. Please try again.');
    }
});

cron.schedule('* * * * *', async () => {
    const todayStr = getLagosDateString();
    const classesSnapshot = await db.collection('classes')
        .where('date', '==', todayStr)
        .where('status', '==', 'active')
        .get();
    if (classesSnapshot.empty) return;

    const [currentHour, currentMin] = getLagosTimeParts();
    const currentTotalMins = (currentHour * 60) + currentMin;

    for (const doc of classesSnapshot.docs) {
        const classData = doc.data();
        const [classHour, classMin] = classData.time.split(':').map(Number);
        const classTotalMins = (classHour * 60) + classMin;
        const minutesUntil = classTotalMins - currentTotalMins;

        if (minutesUntil < 0) continue;

        const roomDoc = await db.collection('classrooms').doc(classData.group_id).get();
        if (!roomDoc.exists) continue;
        const room = roomDoc.data();

        let reminderType = null;
        if (minutesUntil === 30 && !classData.reminder_30_sent) reminderType = '30';
        if (minutesUntil === 15 && !classData.reminder_15_sent) reminderType = '15';
        if (minutesUntil === 5 && !classData.reminder_5_sent) reminderType = '5';
        if (minutesUntil === 0 && !classData.reminder_0_sent) reminderType = '0';
        if (!reminderType) continue;

        const usersToMessage = normalizeUserIds([room.specialist_id, ...await getVerifiedTraineeIds(classData.group_id)]);
        let reminderText;
        let groupReminder;
        const topicText = classData.topic ? `\n\n**Topic:** ${classData.topic}` : '';
        if (reminderType === '0') {
            reminderText = `ðŸš¨ **Class Starting Now** ðŸš¨\n\nLive session for **${room.group_name}** is starting now at **${classData.time}**.${topicText} Please join immediately.`;
            groupReminder = reminderText;
        } else {
            reminderText = `â° **Class Reminder** (${reminderType} minutes)\n\nLive session for **${room.group_name}** starts at **${classData.time}**.${topicText}\n\nPlease prepare and join on time.`;
            groupReminder = reminderText;
        }

        await sendDmUsers(usersToMessage, reminderText, { parse_mode: 'Markdown' });

        try {
            await bot.telegram.sendMessage(classData.group_id, groupReminder, { parse_mode: 'Markdown' });
        } catch (error) {
            await reportError('Could not send group reminder', error);
        }

        await db.collection('classes').doc(doc.id).update({ [`reminder_${reminderType}_sent`]: true });

        // Send attendance prompt after class starts
        if (reminderType === '0') {
            const attendancePrompt = `ðŸ“Š **Attendance Check**\n\nDid you attend the live session for **${room.group_name}**?${topicText}\n\nReply with /attended or /missed in a private chat with me.`;
            await sendDmUsers(await getVerifiedTraineeIds(classData.group_id), attendancePrompt, { parse_mode: 'Markdown' });
        }
    }
}, { timezone: 'Africa/Lagos' });

cron.schedule('* * * * *', async () => {
    const todayStr = getLagosDateString();
    const classesSnapshot = await db.collection('classes')
        .where('date', '==', todayStr)
        .where('status', '==', 'active')
        .get();
    if (classesSnapshot.empty) return;

    const [currentHour, currentMin] = getLagosTimeParts();
    const currentTotalMins = (currentHour * 60) + currentMin;

    for (const doc of classesSnapshot.docs) {
        const classData = doc.data();
        const [classHour, classMin] = classData.time.split(':').map(Number);
        const classTotalMins = (classHour * 60) + classMin;
        const minutesAfter = currentTotalMins - classTotalMins;

        // Send feedback 1 hour after class start
        if (minutesAfter === 60 && !classData.feedback_sent) {
            const roomDoc = await db.collection('classrooms').doc(classData.group_id).get();
            if (!roomDoc.exists) continue;
            const room = roomDoc.data();

            const verifiedTrainees = await getVerifiedTraineeIds(classData.group_id);
            const feedbackText = `ðŸ“ **Session Feedback**\n\nHow was the live session for **${room.group_name}**?${classData.topic ? ` Topic: ${classData.topic}` : ''}\n\nRate 1-5 stars or share your thoughts in a reply to this message.`;
            await sendDmUsers(verifiedTrainees, feedbackText, { parse_mode: 'Markdown' });

            await db.collection('classes').doc(doc.id).update({ feedback_sent: true });
        }
    }
}, { timezone: 'Africa/Lagos' });

cron.schedule('30 7 * * *', async () => {
    try {
        const todayStr = getLagosDateString();
        const specialistsSnapshot = await db.collection('specialists').get();
        if (specialistsSnapshot.empty) return;

        for (const specialistDoc of specialistsSnapshot.docs) {
            const specialistId = specialistDoc.id;
            const classesSnapshot = await db.collection('classes')
                .where('specialist_id', '==', specialistId)
                .where('date', '==', todayStr)
                .where('status', '==', 'active')
                .get();

            let summary = `*Daily Live Session Summary*\nToday: ${todayStr}\n`;
            if (classesSnapshot.empty) {
                summary += '\nNo live sessions are scheduled for today.';
            } else {
                for (const classDoc of classesSnapshot.docs) {
                    const classData = classDoc.data();
                    const topic = classData.topic ? ` - ${classData.topic}` : '';
                    summary += `\nâ€¢ ${classData.group_name} at *${classData.time}*${topic}`;
                }
            }

            await sendDmUsers([specialistId], summary, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        await reportError('Daily summary job failed', error);
    }
}, { timezone: 'Africa/Lagos' });

// Saturday Weekly Report Reminder (Runs every Saturday at 10:00 AM Lagos Time)
cron.schedule('0 10 * * 6', async () => {
    const specialistsSnapshot = await db.collection('specialists').get();
    if (specialistsSnapshot.empty) return;

    for (const specialistDoc of specialistsSnapshot.docs) {
        const specialistId = specialistDoc.id;
        const specialistName = specialistDoc.data().name;

        const message = `ðŸ“Š **Weekly Report Time!**\n\nGood morning ${specialistName}! It's Saturday, time to review your weekly performance.\n\nUse /weeklyreport in a private chat with me to generate and download your weekly summary, including class counts, attendance rates, and feedback.`;
        
        try {
            await bot.telegram.sendMessage(specialistId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.log(`Failed to send weekly report reminder to ${specialistName}:`, error.message);
        }
    }
}, { timezone: 'Africa/Lagos' });

// ==========================================
// MODULE 2: STUDENT VERIFICATION SYSTEM
// ==========================================

bot.on('new_chat_members', async (ctx) => {
    try {
        const newMembers = ctx.message.new_chat_members;
        const groupId = ctx.chat.id.toString();

        for (const member of newMembers) {
            if (member.is_bot) continue;
            await setGroupVerification(groupId, member.id.toString(), {
                group_id: groupId,
                user_id: member.id.toString(),
                username: member.username || member.first_name || null,
                joined_at: admin.firestore.FieldValue.serverTimestamp(),
                verified: false,
                verified_at: null,
                timed_out: false,
                timed_out_at: null,
                removed: false,
                removed_at: null
            });
        }

        await ctx.reply(`Welcome to Skillforge Digital! ðŸš€\n\nTo ensure a safe environment, please verify your account within 24 hours or you will be timed out.`,
            Markup.inlineKeyboard([Markup.button.url('Verify Now âœ…', getVerifyLink(groupId))])
        );
    } catch (error) {
        console.log("Could not send welcome message (Bot might have been kicked):", error.message);
    }
});

bot.on('my_chat_member', async (ctx) => {
    try {
        const chat = ctx.chat;
        if (!chat || !['group', 'supergroup'].includes(chat.type)) return;
        const update = ctx.update?.my_chat_member;
        const newStatus = update?.new_chat_member?.status;
        const oldStatus = update?.old_chat_member?.status;
        if (!['member', 'administrator'].includes(newStatus)) return;
        if (!['left', 'kicked'].includes(oldStatus)) return;

        const groupId = chat.id.toString();
        await startVerifyCampaign(groupId);
        const message = `✅ Verification Required\n\nPlease verify your account to access the classroom fully.\n\nTap the button below to verify:`;
        await ctx.telegram.sendMessage(groupId, message, Markup.inlineKeyboard([
            [Markup.button.url('Verify Now âœ…', getVerifyLink(groupId))]
        ]));
    } catch (error) {
        await reportError('my_chat_member handler failed', error);
    }
});

const handleVerification = async (ctx, groupIdHint = null) => {
    if (ctx.chat.type !== 'private') {
        return ctx.reply('Please verify in a private chat with the bot.');
    }

    const userId = ctx.from.id.toString();
    const candidatesSnapshot = await db.collection('group_verifications')
        .where('user_id', '==', userId)
        .where('verified', '==', false)
        .where('removed', '==', false)
        .get();

    let candidates = candidatesSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    if (!candidates.length) {
        const legacyDoc = await db.collection('pending_verifications').doc(userId).get();
        if (legacyDoc.exists && !legacyDoc.data().verified) {
            const legacy = legacyDoc.data();
            await setGroupVerification(legacy.group_id, userId, {
                group_id: String(legacy.group_id),
                user_id: userId,
                username: legacy.username || null,
                joined_at: legacy.joined_at || admin.firestore.FieldValue.serverTimestamp(),
                verified: false,
                verified_at: null,
                timed_out: Boolean(legacy.timed_out),
                timed_out_at: null,
                removed: Boolean(legacy.removed),
                removed_at: legacy.removed_at || null
            });
            const refreshedSnapshot = await db.collection('group_verifications')
                .where('user_id', '==', userId)
                .where('verified', '==', false)
                .where('removed', '==', false)
                .get();
            candidates = refreshedSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        }
    }

    if (!candidates.length) {
        return ctx.reply("I couldn't find any pending verifications for you. If you just joined a group, wait a moment and try again.");
    }

    const finalizeVerification = async (groupId) => {
        const existing = await getGroupVerification(groupId, userId);
        if (existing?.verified) {
            return ctx.reply('You are already verified! 🎓');
        }

        if (!existing) {
            await setGroupVerification(groupId, userId, {
                group_id: String(groupId),
                user_id: userId,
                username: ctx.from?.username || ctx.from?.first_name || null,
                joined_at: admin.firestore.FieldValue.serverTimestamp(),
                verified: false,
                verified_at: null,
                timed_out: false,
                timed_out_at: null,
                removed: false,
                removed_at: null
            });
        }

        await setGroupVerification(groupId, userId, {
            verified: true,
            verified_at: admin.firestore.FieldValue.serverTimestamp(),
            timed_out: false,
            timed_out_at: null
        });

        try {
            await ctx.telegram.restrictChatMember(groupId, userId, {
                permissions: { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_other_messages: true, can_add_web_page_previews: true }
            });
        } catch (error) {
            console.log('Permission restore error:', error.message);
        }

        return ctx.reply('Verification successful! ✅ You now have full access.');
    };

    if (groupIdHint) {
        return await finalizeVerification(String(groupIdHint));
    }

    if (candidates.length === 1) {
        return await finalizeVerification(String(candidates[0].group_id));
    }

    const buttons = [];
    for (const candidate of candidates.slice(0, 8)) {
        const groupId = String(candidate.group_id);
        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        const label = roomDoc.exists ? (roomDoc.data().group_name || groupId) : groupId;
        buttons.push([Markup.button.callback(`Verify: ${label}`, `verify_select_${groupId}`)]);
    }

    return ctx.reply('You have multiple pending verifications. Select the group to verify:', Markup.inlineKeyboard(buttons));
};

const sendScheduleGroupPicker = async (ctx, specialistId) => {
    const specialistDoc = await db.collection('specialists').doc(specialistId).get();
    if (!specialistDoc.exists) {
        return ctx.reply('You are not a registered specialist.');
    }

    const groupsSnapshot = await db.collection('classrooms')
        .where('specialist_id', '==', specialistId)
        .get();

    if (groupsSnapshot.empty) {
        return ctx.reply('You have no classroom groups linked yet. Use /claim in a group first.');
    }

    let response = 'Select a group to schedule a class:\n';
    const buttons = [];
    groupsSnapshot.docs.forEach(doc => {
        const room = doc.data();
        response += `â€¢ ${room.group_name}: ${doc.id}\n`;
        buttons.push([Markup.button.callback(`Schedule for ${room.group_name}`, `schedule_${doc.id}`)]);
    });
    response += '\nOr use /setclass <group_id> <time> [topic]';

    return ctx.reply(response, Markup.inlineKeyboard(buttons));
};

bot.command('verify', async (ctx) => {
    try {
        await handleVerification(ctx);
    } catch (error) {
        await reportError('verify command failed', error);
        ctx.reply('âŒ Unable to verify right now. Please try again later.');
    }
});

bot.action(/^verify_select_(.+)$/, async (ctx) => {
    const groupId = ctx.match[1];
    try {
        await handleVerification(ctx, groupId);
    } catch (error) {
        await reportError('verify selection failed', error);
        await ctx.reply('âŒ Unable to verify right now. Please try again later.');
    }
    ctx.answerCbQuery();
});

bot.start(async (ctx) => {
    const payload = ctx.startPayload;
    const userId = ctx.from.id.toString();
    const normalizedPayload = payload === 'start' || payload === 'menu' ? null : payload;

    if (normalizedPayload === 'verify' || (normalizedPayload && normalizedPayload.startsWith('verify_'))) {
        const groupId = normalizedPayload && normalizedPayload.startsWith('verify_') ? decodeURIComponent(normalizedPayload.slice('verify_'.length)) : null;
        return await handleVerification(ctx, groupId);
    }

    const roleInfo = await getUserRole(userId);
    const isStaff = roleInfo.role === 'specialist';

    if (normalizedPayload === 'register') {
        return ctx.reply(`To register as a specialist, use:\n/register YOUR_PASSWORD\n\nIf you don't have the password, contact your head of units.`);
    }

    if (normalizedPayload === 'claim') {
        return ctx.reply(`To claim a classroom, go to your Telegram group, add me as an admin, and type:\n/claim`);
    }

    if (normalizedPayload === 'schedule') {
        if (!isStaff) return ctx.reply('Staff only.');
        return await sendScheduleGroupPicker(ctx, userId);
    }

    if (normalizedPayload === 'classes') {
        if (!isStaff) return ctx.reply('Staff only.');
        return ctx.reply('Use /classlist in a private chat to see your upcoming classes.');
    }

    if (normalizedPayload === 'report') {
        if (!isStaff) return ctx.reply('Staff only.');
        return ctx.reply('Choose a report type:', Markup.inlineKeyboard([
            [Markup.button.callback('Weekly Report', 'report_weekly')],
            [Markup.button.callback('Attendance Report', 'report_attendance')],
            [Markup.button.callback('Course Progress', 'report_progress')]
        ]));
    }

    if (normalizedPayload === 'progress') {
        if (!isStaff) return ctx.reply('Staff only.');
        return ctx.reply('Use /courseprogress <group_id> in a private chat to view course progress.');
    }

    if (normalizedPayload === 'weekly') {
        if (!isStaff) return ctx.reply('Staff only.');
        return ctx.reply('On Saturdays, use /weeklyreport to generate your weekly summary or /questionnaire to complete the weekly review.');
    }

    if (normalizedPayload === 'help') {
        return ctx.reply('Use /help to see the full commands list.');
    }

    if (normalizedPayload === 'settings') {
        if (!isStaff) return ctx.reply('Staff only.');
        return ctx.reply('Settings options:', Markup.inlineKeyboard([
            [Markup.button.callback('Change Name', 'settings_name')],
            [Markup.button.callback('View Profile', 'settings_profile')]
        ]));
    }

    if (normalizedPayload) {
        return ctx.reply('Unknown action. Use /help to see available commands.');
    }

    if (roleInfo.role === 'specialist') {
        const specialistDoc = await db.collection('specialists').doc(userId).get();
        const specialistData = specialistDoc.exists ? specialistDoc.data() : {};
        const buttons = [
            [Markup.button.callback('📋 Dashboard', 'dashboard')],
            [Markup.button.callback('📅 Schedule Class', 'schedule_class')],
            [Markup.button.callback('📊 Submit Report', 'submit_report')]
        ];
        if (SERVER_URL) {
            buttons.push([Markup.button.url('🌐 Full Menu', `${SERVER_URL}/menu`)]);
        }
        buttons.push([Markup.button.callback('❓ Help', 'help_info')]);
        return ctx.reply(
            `*👋 Welcome back, ${specialistData.name || 'Specialist'}!*\n\nSelect an option below to get started:`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );
    }

    if (roleInfo.role === 'trainee_verified') {
        return ctx.reply(
            `*Welcome!* 🎓\n\nUse the buttons below for trainee actions:`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Attendance', 'trainee_attendance_help')],
                [Markup.button.callback('❓ Help', 'help_info')]
            ]) }
        );
    }

    return ctx.reply(
        `*Welcome!* 🎓\n\nTo participate in a classroom, please verify your account. Join your classroom group and tap the Verify button there, or use /verify if you already have a pending verification.`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Verify', 'trainee_verify')],
            [Markup.button.callback('❓ Help', 'help_info')]
        ]) }
    );
})

// Menu handlers
bot.hears('Submit Weekly Report', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    const specialistId = ctx.from.id.toString();
    const specialistDoc = await db.collection('specialists').doc(specialistId).get();
    if (!specialistDoc.exists) {
        return ctx.reply('You are not a registered specialist.');
    }

    // Check if it's Saturday
    const today = new Date();
    if (today.getDay() !== 6) { // 0=Sunday, 6=Saturday
        return ctx.reply('Weekly reports can only be submitted on Saturdays.');
    }

    // Proceed to questionnaire logic
    const groupsSnapshot = await db.collection('classrooms')
        .where('specialist_id', '==', specialistId)
        .get();

    if (groupsSnapshot.empty) {
        return ctx.reply('You have no classroom groups linked yet. Use /claim in a group first.');
    }

    let groupId;
    if (groupsSnapshot.size === 1) {
        groupId = groupsSnapshot.docs[0].id;
    } else {
        let listResponse = 'You have multiple classroom groups. Please select one:\n';
        groupsSnapshot.docs.forEach(doc => {
            const room = doc.data();
            listResponse += `â€¢ ${room.group_name}: ${doc.id}\n`;
        });
        return ctx.reply(listResponse + '\nUse /questionnaire <group_id> to proceed.');
    }

    // Start the questionnaire for the group
    const sessionId = `${specialistId}_${groupId}_${Date.now()}`;
    await db.collection('questionnaire_sessions').doc(sessionId).set({
        specialist_id: specialistId,
        group_id: groupId,
        current_question: 0,
        answers: {},
        started_at: admin.firestore.FieldValue.serverTimestamp()
    });

    ctx.reply('Starting weekly questionnaire...', Markup.inlineKeyboard([
        Markup.button.callback('Start Review', `review_start_${sessionId}`)
    ]));
});

bot.hears('Schedule Class', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    const specialistId = ctx.from.id.toString();
    const specialistDoc = await db.collection('specialists').doc(specialistId).get();
    if (!specialistDoc.exists) {
        return ctx.reply('You are not a registered specialist.');
    }

    const groupsSnapshot = await db.collection('classrooms')
        .where('specialist_id', '==', specialistId)
        .get();

    if (groupsSnapshot.empty) {
        return ctx.reply('You have no classroom groups linked yet. Use /claim in a group first.');
    }

    let response = 'Select a group to schedule a class:\n';
    const buttons = [];
    groupsSnapshot.docs.forEach(doc => {
        const room = doc.data();
        response += `â€¢ ${room.group_name}: ${doc.id}\n`;
        buttons.push([Markup.button.callback(`Schedule for ${room.group_name}`, `schedule_${doc.id}`)]);
    });
    response += '\nOr use /setclass <group_id> <time> [topic]';

    ctx.reply(response, Markup.inlineKeyboard(buttons));
});

bot.hears('View Reports', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    const specialistId = ctx.from.id.toString();
    const specialistDoc = await db.collection('specialists').doc(specialistId).get();
    if (!specialistDoc.exists) {
        return ctx.reply('You are not a registered specialist.');
    }

    ctx.reply('Choose a report type:', Markup.inlineKeyboard([
        [Markup.button.callback('Weekly Report', 'report_weekly')],
        [Markup.button.callback('Attendance Report', 'report_attendance')],
        [Markup.button.callback('Course Progress', 'report_progress')]
    ]));
});

bot.hears('Settings', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    const specialistId = ctx.from.id.toString();
    const specialistDoc = await db.collection('specialists').doc(specialistId).get();
    if (!specialistDoc.exists) {
        return ctx.reply('You are not a registered specialist.');
    }

    ctx.reply('Settings options:', Markup.inlineKeyboard([
        [Markup.button.callback('Change Name', 'settings_name')],
        [Markup.button.callback('View Profile', 'settings_profile')]
    ]));
});

bot.hears('Help', async (ctx) => {
    ctx.reply(`Help Menu:
- Submit Weekly Report: Start the weekly questionnaire (only on Saturdays)
- Schedule Class: Schedule a new class for your groups
- View My Classes: List your linked groups
- View Reports: Access various reports
- Settings: Manage your profile
- Use /register [password] to register as specialist
- Use /claim in a group to link it`);
});

cron.schedule('0 */3 * * *', async () => {
    try {
        const settingsSnapshot = await db.collection('group_settings')
            .where('verify_campaign_active', '==', true)
            .get();
        if (settingsSnapshot.empty) return;

        const now = Date.now();
        for (const settingsDoc of settingsSnapshot.docs) {
            const settings = settingsDoc.data();
            const groupId = String(settings.group_id || settingsDoc.id);
            const startedAt = settings.verify_campaign_started_at?.toDate ? settings.verify_campaign_started_at.toDate().getTime() : null;
            const lastSentAt = settings.last_verify_reminder_at?.toDate ? settings.last_verify_reminder_at.toDate().getTime() : null;

            if (startedAt && (now - startedAt) > (24 * 60 * 60 * 1000)) {
                const unverifiedSnapshot = await db.collection('group_verifications')
                    .where('group_id', '==', groupId)
                    .where('verified', '==', false)
                    .where('removed', '==', false)
                    .get();
                if (unverifiedSnapshot.empty) {
                    await stopVerifyCampaign(groupId);
                    continue;
                }
            }

            if (lastSentAt && (now - lastSentAt) < (3 * 60 * 60 * 1000) - (60 * 1000)) {
                continue;
            }

            const message = `âš ï¸ **Verification Reminder** âš ï¸\n\nIf you have not verified yet, please verify now to access the classroom fully.`;
            try {
                await bot.telegram.sendMessage(groupId, message, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([Markup.button.url('Verify Now âœ…', getVerifyLink(groupId))])
                });
                await updateVerifyReminderSent(groupId);
            } catch (error) {
                await reportError('3-hour verification reminder failed', error);
            }
        }
    } catch (error) {
        await reportError('3-hour verification reminder job failed', error);
    }
});

cron.schedule('*/30 * * * *', async () => {
    try {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const timeoutThreshold = admin.firestore.Timestamp.fromDate(yesterday);

        const snapshot = await db.collection('group_verifications')
            .where('verified', '==', false)
            .where('timed_out', '==', false)
            .where('removed', '==', false)
            .where('joined_at', '<=', timeoutThreshold)
            .get();
        if (!snapshot.empty) {
            for (const doc of snapshot.docs) {
                const data = doc.data();
                try {
                    await bot.telegram.restrictChatMember(data.group_id, data.user_id, { permissions: { can_send_messages: false } });
                    await db.collection('group_verifications').doc(doc.id).update({
                        timed_out: true,
                        timed_out_at: admin.firestore.FieldValue.serverTimestamp()
                    });
                    const displayName = data.username ? `@${data.username}` : `${data.user_id}`;
                    const message = `â³ ${displayName} has been timed out for failing to verify within 24 hours.`;
                    await bot.telegram.sendMessage(data.group_id, message, Markup.inlineKeyboard([Markup.button.url('Verify to Restore Access ðŸ”“', getVerifyLink(data.group_id))]));
                } catch (error) {
                    await reportError('Timeout enforcement error', error);
                }
            }
        }

        const removalCutoff = new Date(Date.now() - 25 * 60 * 60 * 1000);
        const removalThreshold = admin.firestore.Timestamp.fromDate(removalCutoff);
        const removalSnapshot = await db.collection('group_verifications')
            .where('verified', '==', false)
            .where('timed_out', '==', true)
            .where('removed', '==', false)
            .where('joined_at', '<=', removalThreshold)
            .get();

        if (!removalSnapshot.empty) {
            for (const doc of removalSnapshot.docs) {
                const data = doc.data();
                try {
                    await bot.telegram.kickChatMember(data.group_id, data.user_id);
                    await db.collection('group_verifications').doc(doc.id).update({ removed: true, removed_at: admin.firestore.FieldValue.serverTimestamp() });
                    const displayName = data.username ? `@${data.username}` : `${data.user_id}`;
                    const message = `â›” ${displayName} has been removed for failing to verify after timeout.`;
                    await bot.telegram.sendMessage(data.group_id, message);
                } catch (error) {
                    await reportError('Timed-out removal error', error);
                }
            }
        }
    } catch (error) {
        await reportError('Verification timeout/removal job failed', error);
    }
});

// ==========================================
// MODULE 3: SERVER START
// ==========================================

app.get('/public/menu.html', (req, res) => res.redirect('/menu'));
app.use('/public', express.static('public'));

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/', (req, res) => res.redirect('/admin'));

const getAdminSession = async (req) => {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies.sf_admin_session;
    if (!sid) return null;
    const doc = await db.collection('admin_sessions').doc(String(sid)).get();
    if (!doc.exists) return null;
    const sess = doc.data();
    const exp = sess.expires_at?.toDate ? sess.expires_at.toDate().getTime() : 0;
    if (Date.now() > exp) return null;
    return sess;
};

const isHttpsRequest = (req) => {
    if (req?.secure) return true;
    const xfProto = req?.headers?.['x-forwarded-proto'];
    if (xfProto && String(xfProto).toLowerCase() === 'https') return true;
    if (SERVER_URL && SERVER_URL.startsWith('https://')) return true;
    return false;
};

const setAdminSessionCookie = (req, res, sessionId) => {
    const secure = isHttpsRequest(req);
    const secureFlag = secure ? '; Secure' : '';
    const base = `sf_admin_session=${encodeURIComponent(String(sessionId))}; Path=/; HttpOnly; SameSite=Lax${secureFlag}`;
    res.setHeader('Set-Cookie', base);
};

const clearAdminSessionCookie = (res) => {
    res.setHeader('Set-Cookie', 'sf_admin_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
};

app.get('/admin/api/me', async (req, res) => {
    try {
        const sess = await getAdminSession(req);
        if (!sess) return res.status(401).json({ error: 'unauthorized' });
        return res.json({ telegram_id: sess.telegram_id, role: sess.role });
    } catch (error) {
        await reportError('admin me failed', error);
        return res.status(500).json({ error: 'failed' });
    }
});

app.post('/admin/auth/request', async (req, res) => {
    try {
        const telegram_id = String(req.body?.telegram_id || '').trim();
        if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
        const specialistDoc = await db.collection('specialists').doc(telegram_id).get();
        if (!specialistDoc.exists) return res.status(403).json({ error: 'not a specialist' });

        const code = randomCode();
        const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000));
        await db.collection('admin_sessions_pending').doc(telegram_id).set({
            telegram_id,
            code_hash: hashCode(code),
            attempts: 0,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            expires_at: expiresAt
        }, { merge: true });

        await bot.telegram.sendMessage(telegram_id, `Skillforge Admin login code: ${code}\n\nThis code expires in 10 minutes.`);
        return res.json({ ok: true });
    } catch (error) {
        await reportError('admin auth request failed', error);
        return res.status(500).json({ error: 'failed' });
    }
});

app.post('/admin/auth/verify', async (req, res) => {
    try {
        const telegram_id = String(req.body?.telegram_id || '').trim();
        const code = String(req.body?.code || '').trim();
        if (!telegram_id || !code) return res.status(400).json({ error: 'telegram_id and code required' });

        const pendingDoc = await db.collection('admin_sessions_pending').doc(telegram_id).get();
        if (!pendingDoc.exists) return res.status(403).json({ error: 'no pending code' });
        const pending = pendingDoc.data();
        const expiresAt = pending.expires_at?.toDate ? pending.expires_at.toDate().getTime() : 0;
        if (Date.now() > expiresAt) return res.status(403).json({ error: 'code expired' });

        const attempts = Number(pending.attempts || 0);
        if (attempts >= 5) return res.status(429).json({ error: 'too many attempts' });

        if (hashCode(code) !== pending.code_hash) {
            await db.collection('admin_sessions_pending').doc(telegram_id).set({ attempts: attempts + 1 }, { merge: true });
            return res.status(403).json({ error: 'invalid code' });
        }

        const sessionId = randomSessionId();
        const sessionExpires = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 12 * 60 * 60 * 1000));
        await db.collection('admin_sessions').doc(sessionId).set({
            session_id: sessionId,
            telegram_id,
            role: 'specialist',
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            expires_at: sessionExpires
        });
        await db.collection('admin_sessions_pending').doc(telegram_id).delete();

        setAdminSessionCookie(req, res, sessionId);
        return res.json({ ok: true });
    } catch (error) {
        await reportError('admin auth verify failed', error);
        return res.status(500).json({ error: 'failed' });
    }
});

app.post('/admin/auth/elevate', async (req, res) => {
    try {
        const sess = await getAdminSession(req);
        if (!sess) return res.status(401).json({ error: 'unauthorized' });
        const key = String(req.body?.key || '').trim();
        if (!SUPER_ADMIN_KEY || key !== SUPER_ADMIN_KEY) return res.status(403).json({ error: 'invalid key' });
        await db.collection('admin_sessions').doc(sess.session_id).set({ role: 'super_admin' }, { merge: true });
        return res.json({ ok: true });
    } catch (error) {
        await reportError('admin elevate failed', error);
        return res.status(500).json({ error: 'failed' });
    }
});

app.post('/admin/auth/logout', async (req, res) => {
    try {
        const cookies = parseCookies(req.headers.cookie);
        const sid = cookies.sf_admin_session;
        if (sid) {
            await db.collection('admin_sessions').doc(String(sid)).delete().catch(() => {});
        }
        clearAdminSessionCookie(res);
        return res.json({ ok: true });
    } catch (error) {
        await reportError('admin logout failed', error);
        clearAdminSessionCookie(res);
        return res.json({ ok: true });
    }
});

const requireSuperAdmin = async (req, res) => {
    const sess = await getAdminSession(req);
    if (!sess) return { ok: false, session: null, responseSent: res.status(401).json({ error: 'unauthorized' }) };
    if (sess.role !== 'super_admin') return { ok: false, session: sess, responseSent: res.status(403).json({ error: 'forbidden' }) };
    return { ok: true, session: sess, responseSent: null };
};

app.get('/admin/api/classrooms', async (req, res) => {
    try {
        const sess = await getAdminSession(req);
        if (!sess) return res.status(401).json({ error: 'unauthorized' });

        const classroomsQuery = sess.role === 'super_admin'
            ? db.collection('classrooms')
            : db.collection('classrooms').where('specialist_id', '==', String(sess.telegram_id));

        const snap = await classroomsQuery.get();
        const items = [];
        for (const doc of snap.docs) {
            const room = doc.data();
            const groupId = String(room.group_id || doc.id);

            const verSnap = await db.collection('group_verifications').where('group_id', '==', groupId).get();
            const verified = verSnap.docs.filter(d => d.data().verified).length;
            const removed = verSnap.docs.filter(d => d.data().removed).length;
            const unverified = verSnap.size - verified - removed;

            const settingsDoc = await db.collection('group_settings').doc(groupId).get();
            const settings = settingsDoc.exists ? settingsDoc.data() : {};

            items.push({
                group_id: groupId,
                group_name: room.group_name || groupId,
                specialist_id: room.specialist_id || '',
                specialist_name: room.specialist_name || '',
                verification: { verified, unverified, removed },
                campaign: { active: Boolean(settings.verify_campaign_active) },
                can_manage: sess.role === 'super_admin'
            });
        }

        return res.json({ items });
    } catch (error) {
        await reportError('admin classrooms api failed', error);
        return res.status(500).json({ error: 'failed' });
    }
});

app.get('/admin/api/today', async (req, res) => {
    try {
        const sess = await getAdminSession(req);
        if (!sess) return res.status(401).json({ error: 'unauthorized' });
        const todayStr = getLagosDateString();

        const classesSnap = await db.collection('classes')
            .where('date', '==', todayStr)
            .where('status', '==', 'active')
            .get();

        const items = [];
        for (const doc of classesSnap.docs) {
            const c = doc.data();
            if (sess.role !== 'super_admin' && String(c.specialist_id) !== String(sess.telegram_id)) continue;
            items.push({
                id: doc.id,
                group_id: c.group_id,
                group_name: c.group_name,
                time: c.time,
                topic: c.topic || null,
                status: c.status
            });
        }

        return res.json({ items });
    } catch (error) {
        await reportError('admin today api failed', error);
        return res.status(500).json({ error: 'failed' });
    }
});

app.post('/admin/api/classrooms/:groupId/start', async (req, res) => {
    const auth = await requireSuperAdmin(req, res);
    if (!auth.ok) return;
    try {
        await startVerifyCampaign(req.params.groupId);
        return res.json({ ok: true });
    } catch (error) {
        await reportError('admin start campaign failed', error);
        return res.status(500).json({ error: 'failed' });
    }
});

app.post('/admin/api/classrooms/:groupId/stop', async (req, res) => {
    const auth = await requireSuperAdmin(req, res);
    if (!auth.ok) return;
    try {
        await stopVerifyCampaign(req.params.groupId);
        return res.json({ ok: true });
    } catch (error) {
        await reportError('admin stop campaign failed', error);
        return res.status(500).json({ error: 'failed' });
    }
});

app.post('/admin/api/classrooms/:groupId/announce', async (req, res) => {
    const auth = await requireSuperAdmin(req, res);
    if (!auth.ok) return;
    try {
        const groupId = String(req.params.groupId);
        await bot.telegram.sendMessage(groupId, '✅ Verification Required\n\nTap below to verify:', Markup.inlineKeyboard([
            [Markup.button.url('Verify Now âœ…', getVerifyLink(groupId))]
        ]));
        return res.json({ ok: true });
    } catch (error) {
        await reportError('admin announce verify failed', error);
        return res.status(500).json({ error: 'failed' });
    }
});

app.get('/admin/api/attendance/export', async (req, res) => {
    try {
        const sess = await getAdminSession(req);
        if (!sess) return res.status(401).send('unauthorized');
        const groupId = String(req.query.groupId || '').trim();
        const from = String(req.query.from || '').trim();
        const to = String(req.query.to || '').trim();
        if (!groupId || !from || !to) return res.status(400).send('groupId, from, to required');

        if (sess.role !== 'super_admin') {
            const roomDoc = await db.collection('classrooms').doc(groupId).get();
            if (!roomDoc.exists || String(roomDoc.data().specialist_id) !== String(sess.telegram_id)) {
                return res.status(403).send('forbidden');
            }
        }

        const classesSnap = await db.collection('classes')
            .where('group_id', '==', groupId)
            .where('date', '>=', from)
            .where('date', '<=', to)
            .get();

        const classIds = classesSnap.docs.map(d => d.id);
        const rows = [];
        for (const classId of classIds) {
            const attSnap = await db.collection('attendance').where('class_id', '==', classId).get();
            for (const doc of attSnap.docs) {
                const a = doc.data();
                rows.push({ class_id: classId, user_id: a.user_id, attended: a.attended ? 'true' : 'false' });
            }
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="attendance_${groupId}_${from}_to_${to}.csv"`);
        res.write('class_id,user_id,attended\n');
        for (const r of rows) res.write(`${r.class_id},${r.user_id},${r.attended}\n`);
        res.end();
    } catch (error) {
        await reportError('attendance export failed', error);
        return res.status(500).send('failed');
    }
});

app.get('/questionnaire', async (req, res) => {
    try {
        const lines = [
            'Staff Questionnaire',
            'Please answer the following questions with clear, specific responses:',
            '1. Describe the current status of your class program and how close you are to meeting the 3x/week target.',
            '2. How many sessions were scheduled, held, and canceled this week?',
            '3. Did you meet the minimum 2 class days this week? If not, explain the reason.',
            '4. Rate the overall trainee participation from 1 to 5, where 5 is excellent.',
            '5. What is the average attendance rate for your live sessions?',
            '6. Provide any key challenges or blockers that affected session delivery.',
            '7. Share any improvement ideas or support you need from the head of units.',
            '8. Do you have any technical or classroom issues that need immediate attention?',
            '\nThank you for completing this questionnaire. Please submit the completed form to your head of units.',
        ];

        const pdfBuffer = await getPdfBuffer('Staff Questionnaire', lines, {
            logoPath: REPORT_LOGO_PATH,
            logoTag: REPORT_LOGOTAG
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="staff_questionnaire.pdf"');
        res.send(pdfBuffer);
    } catch (error) {
        console.error('Questionnaire route error:', error);
        res.status(500).send('Unable to generate questionnaire PDF.');
    }
});

app.get('/review/:id', async (req, res) => {
    try {
        const sessionDoc = await db.collection('questionnaire_sessions').doc(req.params.id).get();
        if (!sessionDoc.exists) {
            return res.status(404).send('Review session not found.');
        }

        const session = { id: sessionDoc.id, ...sessionDoc.data() };
        const pdfBuffer = await buildReviewPdf(session);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="weekly_review_${session.group_name}_${session.week_start}_to_${session.week_end}.pdf"`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('Review route error:', error);
        res.status(500).send('Unable to generate review PDF.');
    }
});

const PORT = process.env.PORT || 3000;
const isWebhookMode = Boolean(SERVER_URL);
const WEBHOOK_PATH = isWebhookMode ? `/webhook/${WEBHOOK_SECRET}` : null;

app.listen(PORT, '0.0.0.0', () => console.log(`Web server listening on port ${PORT}`));

bot.catch(async (err, ctx) => {
    console.error('Bot update failed:', err?.message || err, 'Update type:', ctx?.updateType);
    await reportError('Unhandled bot error', err);
});

const startBot = async () => {
    try {
        if (isWebhookMode) {
            if (!WEBHOOK_SECRET) {
                console.error('Missing required environment variable: WEBHOOK_SECRET');
                process.exit(1);
            }
            const webhookUrl = `${SERVER_URL}${WEBHOOK_PATH}`;
            app.use(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));
            await bot.telegram.setWebhook(webhookUrl);
            console.log(`Bot webhook configured at ${webhookUrl}`);
        } else {
            await bot.telegram.deleteWebhook();
            await bot.launch();
            console.log('Skillforge Bot launched in polling mode');
        }

        await bot.telegram.setMyCommands([
            { command: 'start', description: 'Start the bot and show menu' },
            { command: 'register', description: 'Register as a Specialist (staff only)' },
            { command: 'claim', description: 'Link a group as your classroom' },
            { command: 'setclass', description: 'Schedule a live session' },
            { command: 'cancelclass', description: 'Cancel scheduled sessions' },
            { command: 'rescheduleclass', description: 'Change session time' },
            { command: 'status', description: 'View daily status and schedule' },
            { command: 'classlist', description: 'List upcoming sessions' },
            { command: 'health', description: 'Check bot health' },
            { command: 'attended', description: 'Mark attendance (trainees)' },
            { command: 'missed', description: 'Report absence (trainees)' },
            { command: 'calendar', description: 'View classes on a date' },
            { command: 'report', description: 'Get attendance report' },
            { command: 'weeklyreport', description: 'Generate weekly summary' },
            { command: 'courseprogress', description: 'View course performance' },
            { command: 'questionnaire', description: 'Start weekly review' },
            { command: 'verify', description: 'Verify trainee account' },
            { command: 'help', description: 'Show help menu' }
        ]);

        console.log('Skillforge Bot is fully operational!');
    } catch (error) {
        console.error('Failed to start Skillforge Bot:', error?.message || error);
        await reportError('Bot startup failure', error);
        process.exit(1);
    }
};

startBot();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
