require('dotenv').config();
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const PDFDocument = require('pdfkit');
const admin = require('firebase-admin');
const cron = require('node-cron');
const express = require('express');

// ==========================================
// SETUP & CONNECTIONS
// ==========================================
const app = express();

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

const BOT_LINK = `https://t.me/${process.env.BOT_USERNAME}?start=verify`;
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID || null;
const SERVER_URL = process.env.SERVER_URL || null;
const REPORT_LOGO_PATH = process.env.REPORT_LOGO_PATH || './logo.jpg';
const REPORT_LOGOTAG = process.env.REPORT_LOGOTAG || 'Skillforge Principal Bot';
const CLASS_TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

const bot = new Telegraf(process.env.BOT_TOKEN);

const getClassDocId = (groupId, date, time) => `${groupId}_${date}_${time}`;
const normalizeUserIds = (userIds) => [...new Set(userIds.filter(Boolean).map(String))];

const reportError = async (message, error) => {
    const fullMessage = `❗️ Bot error: ${message}${error ? `\n${error.message || error}` : ''}`;
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

const buildReviewPdf = async (session) => {
    const lines = [];
    lines.push('Weekly Review Report');
    lines.push('');
    lines.push(`Group: ${session.group_name}`);
    lines.push(`Review period: ${session.week_start} to ${session.week_end}`);
    lines.push('');
    lines.push('Performance Summary:');
    lines.push(`• Sessions held: ${session.performance?.heldSessions ?? 0}/${session.performance?.expectedSessions ?? 0}`);
    lines.push(`• Active class days: ${session.performance?.classDays ?? 0}/${session.performance?.expectedDays ?? 0}`);
    lines.push(`• Attendance rate: ${session.performance?.attendanceRate ?? 0}%`);
    lines.push(`• Performance meter: ${session.performance?.meterValue ?? 0}/100`);
    lines.push(`• Target plan: ${session.sessions_per_week || 3} sessions per week, minimum ${session.min_days_per_week || 2} days per week, ${session.expected_duration_minutes || 45} minutes per session.`);
    if (session.rating) {
        lines.push(`• Trainee participation rating: ${session.rating}/5`);
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
    const snapshot = await db.collection('pending_verifications')
        .where('group_id', '==', groupId)
        .where('verified', '==', true)
        .get();

    return snapshot.docs.map(doc => doc.data().telegram_id.toString());
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
            return ctx.reply("❌ Invalid Skillforge master password.");
        }

        const specialistId = ctx.from.id.toString();
        const specialistName = ctx.from.first_name || "Specialist";

        await db.collection('specialists').doc(specialistId).set({
            telegram_id: specialistId,
            name: specialistName,
            registered_at: admin.firestore.FieldValue.serverTimestamp()
        });

        ctx.reply(`✅ Welcome to the team, Specialist ${specialistName}! \n\nYou are now authorized. Please go to your cohort's Telegram group, add me as an Admin, and type /claim to link the classroom.`);
    } catch (error) {
        console.log("Register Error:", error);
        ctx.reply("❌ An error occurred during registration.");
    }
});

bot.command('claim', async (ctx) => {
    try {
        if (ctx.chat.type === 'private') {
            return ctx.reply("❌ You cannot claim a Direct Message! You must type this command inside the actual Skillforge Telegram Group.");
        }

        const specialistId = ctx.from.id.toString();
        const groupId = ctx.chat.id.toString();
        const groupName = ctx.chat.title || "Skillforge Classroom"; 

        const specialistDoc = await db.collection('specialists').doc(specialistId).get();
        if (!specialistDoc.exists) {
            return ctx.reply("❌ You must be registered as a Specialist first! Go to my Direct Messages and type: /register YOUR_PASSWORD");
        }

        const specialistData = specialistDoc.data();
        const specialistName = specialistData.name || "Specialist";

        await db.collection('classrooms').doc(groupId).set({
            group_id: groupId,
            group_name: groupName,
            specialist_id: specialistId,
            specialist_name: specialistName
        });

        ctx.reply(`✅ Classroom successfully linked!\n\nI have registered this group as **${groupName}** under Specialist **${specialistName}**.\n\nNext, set the first course date with /setprogram ${groupId} YYYY-MM-DD so I can track the 3-week program and performance meter.`);
    } catch (error) {
        await reportError('Claim Error', error);
        ctx.reply("❌ An error occurred while trying to claim the group. Please try again.");
    }
});

bot.command('help', (ctx) => {
    const helpText = `*Skillforge Bot Commands*

` +
        `• /register <password> - Register as a Specialist.
` +
        `• /claim - Claim your Telegram classroom group.
` +
        `• /setclass <group_id> <HH:MM> [topic] - Schedule today’s live session with optional topic.
` +
        `• /rescheduleclass <group_id> <old_time> <new_time> - Move a session to a new time.
` +
        `• /cancelclass <group_id> [time] - Cancel one or all today’s sessions.
` +
        `• /classlist - Show all upcoming live sessions for your classrooms.
` +
        `• /status - Show your classroom status and today’s schedule.
` +
        `• /health - Check bot health and system status.
` +
        `• /attended - Confirm attendance for the current session (in DM).
` +
        `• /missed - Report missing the current session (in DM).
` +
        `• /backup <group_name> - Assign yourself as backup specialist.
` +
        `• /calendar [date] - List classes for a date (YYYY-MM-DD).
` +
        `• /report [date] - Get attendance report for your classes.
` +
        `• /weeklyreport - Generate weekly summary report (Saturdays only).
` +
        `• /setprogram <group_id> <YYYY-MM-DD> - Define course first class date and tracking plan.
` +
        `• /courseprogress <group_id> - Show weekly performance meter and plan progress.
` +
        `• /questionnaire - Download the staff questionnaire PDF.
` +
        `• /verify - Verify your trainee account in private chat.
` +
        `• /help - Show this message.`;
    ctx.reply(helpText, { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
    try {
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
                    response += `\n• ${classData.group_name} at *${classData.time}*`;
                }
            }

            const pendingSnapshot = await db.collection('pending_verifications')
                .where('verified', '==', false)
                .where('timed_out', '==', false)
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
                response += `\n• Live class at *${classData.time}*`;
            }
        }

        const pendingSnapshot = await db.collection('pending_verifications')
            .where('group_id', '==', groupId)
            .where('verified', '==', false)
            .where('timed_out', '==', false)
            .get();
        response += `\n\nPending verifications: *${pendingSnapshot.size}*`;
        ctx.reply(response, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('Status command failed', error);
        ctx.reply('❌ Unable to fetch status right now. Please try again later.');
    }
});

bot.command('classlist', async (ctx) => {
    try {
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
                response += `\n• ${classData.group_name} at *${classData.time}*${topic}`;
            }
        }

        ctx.reply(response, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('classlist command failed', error);
        ctx.reply('❌ Unable to fetch class list right now. Please try again later.');
    }
});

bot.command('health', async (ctx) => {
    try {
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

        const pendingVerifications = await db.collection('pending_verifications')
            .where('verified', '==', false)
            .where('timed_out', '==', false)
            .get();

        const totalClasses = classesSnapshot.size;
        const totalPending = pendingVerifications.size;

        const uptime = process.uptime();
        const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

        let response = `*Bot Health Status*\n\n`;
        response += `• Uptime: ${uptimeStr}\n`;
        response += `• Today's Classes: ${totalClasses}\n`;
        response += `• Pending Verifications: ${totalPending}\n`;
        response += `• Timezone: Africa/Lagos\n`;
        response += `• Status: ✅ Operational`;

        ctx.reply(response, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('Health command failed', error);
        ctx.reply('❌ Unable to check health right now.');
    }
});

// Attendance Commands
bot.command('attended', async (ctx) => {
    if (ctx.chat.type !== 'private') {
        return ctx.reply('Please use this command in a private chat with the bot.');
    }

    const userId = ctx.from.id.toString();
    const todayStr = getLagosDateString();

    // Find the most recent active class for this user
    const userDoc = await db.collection('pending_verifications').doc(userId).get();
    if (!userDoc.exists || !userDoc.data().verified) {
        return ctx.reply('You are not verified. Please verify first.');
    }

    const groupId = userDoc.data().group_id;
    const classesSnapshot = await db.collection('classes')
        .where('group_id', '==', groupId)
        .where('date', '==', todayStr)
        .where('status', '==', 'active')
        .orderBy('time', 'desc')
        .limit(1)
        .get();

    if (classesSnapshot.empty) {
        return ctx.reply('No active classes found for today.');
    }

    const classDoc = classesSnapshot.docs[0];
    const classData = classDoc.data();

    await db.collection('attendance').doc(`${classDoc.id}_${userId}`).set({
        class_id: classDoc.id,
        user_id: userId,
        attended: true,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    ctx.reply(`✅ Attendance confirmed for **${classData.group_name}** at **${classData.time}**.${classData.topic ? ` Topic: ${classData.topic}` : ''}`);
});

bot.command('missed', async (ctx) => {
    if (ctx.chat.type !== 'private') {
        return ctx.reply('Please use this command in a private chat with the bot.');
    }

    const userId = ctx.from.id.toString();
    const todayStr = getLagosDateString();

    const userDoc = await db.collection('pending_verifications').doc(userId).get();
    if (!userDoc.exists || !userDoc.data().verified) {
        return ctx.reply('You are not verified. Please verify first.');
    }

    const groupId = userDoc.data().group_id;
    const classesSnapshot = await db.collection('classes')
        .where('group_id', '==', groupId)
        .where('date', '==', todayStr)
        .where('status', '==', 'active')
        .orderBy('time', 'desc')
        .limit(1)
        .get();

    if (classesSnapshot.empty) {
        return ctx.reply('No active classes found for today.');
    }

    const classDoc = classesSnapshot.docs[0];
    const classData = classDoc.data();

    await db.collection('attendance').doc(`${classDoc.id}_${userId}`).set({
        class_id: classDoc.id,
        user_id: userId,
        attended: false,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    ctx.reply(`📝 Noted that you missed **${classData.group_name}** at **${classData.time}**.${classData.topic ? ` Topic: ${classData.topic}` : ''}`);
});

// Assign Backup Specialist
bot.command('backup', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

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

    ctx.reply(`✅ Backup specialist assigned for **${groupName}**.`);
});

// Calendar: List classes for a specific date
bot.command('calendar', async (ctx) => {
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

    let response = `📅 **Classes on ${dateStr}**\n\n`;
    classesSnapshot.forEach(doc => {
        const data = doc.data();
        response += `🕒 ${data.time} - ${data.group_name}${data.topic ? ` (${data.topic})` : ''}\n`;
    });

    ctx.reply(response, { parse_mode: 'Markdown' });
});

// Attendance Report for Specialists
bot.command('report', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

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

    let response = `📊 **Attendance Report for ${dateStr}**\n\n`;
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
    let report = `📊 **Weekly Report for ${specialistDoc.data().name}**\n`;
    report += `Period: ${mondayStr} to ${sundayStr}\n\n`;
    report += `📅 **Class Statistics**\n`;
    report += `• Classes Scheduled: ${totalScheduled}\n`;
    report += `• Classes Held: ${totalHeld}\n`;
    report += `• Classes Missed: ${totalScheduled - totalHeld}\n\n`;
    report += `👥 **Attendance Overview**\n`;
    report += `• Total Attendance: ${totalAttendance}/${totalPossibleAttendance}\n`;
    report += `• Attendance Rate: ${attendanceRate}%\n\n`;
    report += `🎯 **Program Tracking Note**\n`;
    report += `• Target: 3 sessions per week, at least 2 unique class days, 45 minutes per session.\n`;
    report += `• Use /courseprogress <group_id> for the course performance meter and detailed weekly status.\n\n`;

    if (feedbackList.length > 0) {
        report += `📝 **Feedback Summary**\n`;
        report += `Total Feedback Received: ${feedbackList.length}\n\n`;
        // Simple sentiment analysis (count ratings)
        const ratings = feedbackList.filter(f => /\b[1-5]\b/.test(f)).map(f => parseInt(f.match(/\b[1-5]\b/)[0]));
        if (ratings.length > 0) {
            const avgRating = (ratings.reduce((a,b)=>a+b,0) / ratings.length).toFixed(1);
            report += `Average Rating: ${avgRating}/5 ⭐\n\n`;
        }
        report += `Recent Comments:\n`;
        feedbackList.slice(-5).forEach((fb, i) => {
            report += `${i+1}. ${fb.length > 100 ? fb.substring(0,100)+'...' : fb}\n`;
        });
    } else {
        report += `📝 No feedback received this week.\n`;
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

    ctx.reply(`✅ Course program saved for **${room.group_name}**.\nStart Date: ${dateToString(startDate)}\nEnd Date: ${dateToString(endDate)}\nExpected: ${sessionsPerWeek} sessions per week, ${expectedDurationMinutes} minutes each, for ${weeks} weeks.`);
});

bot.command('courseprogress', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

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

    let response = `📈 **Course Progress for ${room.group_name}**\n`;
    response += `• Course start: ${room.course_start_date}\n`;
    response += `• Course end: ${room.course_end_date}\n`;
    response += `• Status: ${statusLabel}\n\n`;
    response += `**Weekly Performance Meter**\n`;
    response += `• Sessions held this week: ${performance.heldSessions}/${performance.expectedSessions}\n`;
    response += `• Active class days this week: ${performance.classDays}/${performance.expectedDays}\n`;
    response += `• Attendance rate: ${performance.attendanceRate}%\n`;
    response += `• Performance meter: ${performance.meterValue}/100\n\n`;
    response += `**Plan targets**\n`;
    response += `• ${sessionsPerWeek} classes per week\n`;
    response += `• Minimum ${minDaysPerWeek} class days per week\n`;
    response += `• ${room.expected_duration_minutes || 45} minutes per session\n`;
    response += `• Total planned sessions: ${room.expected_total_sessions || weeks * sessionsPerWeek}\n`;

    if (isStarted) {
        response += `\n✅ The course has officially started.`;
    } else {
        response += `\n⏳ The course has not started yet. First class is scheduled for ${room.course_start_date}.`;
    }

    ctx.reply(response, { parse_mode: 'Markdown' });
});

bot.command('questionnaire', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

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
                listResponse += `• ${room.group_name}: ${doc.id}\n`;
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

    const message = `📋 Weekly review ready for *${room.group_name}*\nPeriod: *${dateToString(weekBounds.monday)}* to *${dateToString(weekBounds.sunday)}*\n\nAre you ready to take your weekly review?`;
    await ctx.reply(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([Markup.button.callback('Yes, start review', `review_start_${sessionId}`)])
    });
});

bot.action(/^review_start_(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const sessionRef = db.collection('questionnaire_sessions').doc(sessionId);
    const sessionDoc = await sessionRef.get();
    if (!sessionDoc.exists) {
        await ctx.answerCbQuery('Review session not found.');
        return;
    }

    const session = sessionDoc.data();
    if (session.status !== 'pending') {
        await ctx.answerCbQuery('This review session has already started or completed.');
        return;
    }

    await sessionRef.update({
        status: 'in_progress',
        updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    await ctx.editMessageText('✅ Weekly review started. I will ask you the questions one by one.');
    await ctx.reply(`Question 1 of ${REVIEW_QUESTIONS.length}: ${REVIEW_QUESTIONS[0]}`);
    await ctx.answerCbQuery();
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

        await ctx.reply('✅ Weekly review completed! Generating your PDF now...');
        await ctx.replyWithDocument({ source: pdfBuffer, filename: `weekly_review_${session.group_name}_${session.week_start}_to_${session.week_end}.pdf` });
        if (SERVER_URL) {
            await ctx.reply(`You can also download it again here:\n${SERVER_URL}/review/${sessionId}`);
        }
        return;
    }

    // Check if this is a feedback response (simple heuristic: contains rating or is reply)
    if (messageText.match(/\b[1-5]\b/) || messageText.length > 10) {
        const todayStr = getLagosDateString();
        const userDoc = await db.collection('pending_verifications').doc(userId).get();
        if (!userDoc.exists || !userDoc.data().verified) return;

        const groupId = userDoc.data().group_id;
        const recentClasses = await db.collection('classes')
            .where('group_id', '==', groupId)
            .where('date', '==', todayStr)
            .where('feedback_sent', '==', true)
            .orderBy('time', 'desc')
            .limit(1)
            .get();

        if (!recentClasses.empty) {
            const classDoc = recentClasses.docs[0];
            await db.collection('feedback').add({
                class_id: classDoc.id,
                user_id: userId,
                feedback: messageText,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            ctx.reply('✅ Thank you for your feedback!');
        }
    }
});

// Morning Class Check (Runs every day at 8:00 AM Lagos Time)
cron.schedule('0 8 * * *', async () => {
    const classroomsSnapshot = await db.collection('classrooms').get();
    if (classroomsSnapshot.empty) return;

    classroomsSnapshot.forEach(async (doc) => {
        const room = doc.data();
        const message = `Good morning Specialist ${room.specialist_name}! ☀️\n\nWill there be a live session for **${room.group_name}** today?\n\nIf yes, set the time using:\n\n\`/setclass ${room.group_id} 14:00\``;
        
        try {
            await bot.telegram.sendMessage(room.specialist_id, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.log(`Failed to message Specialist ${room.specialist_name}:`, error.message);
        }
    });
}, { timezone: "Africa/Lagos" });

bot.command('setclass', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        const groupId = args[1];
        const timeInput = args[2];
        const topic = args.slice(3).join(' ') || null;

        if (!groupId || !timeInput) {
            return ctx.reply("❌ Format error. Please use: /setclass <group_id> <time> [topic]\nExample: /setclass -100123456 14:00 Introduction to JavaScript");
        }

        if (!CLASS_TIME_REGEX.test(timeInput)) {
            return ctx.reply("❌ Time format should be HH:MM in 24-hour format. Example: /setclass -100123456 14:00");
        }

        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            return ctx.reply("❌ That group is not linked to a classroom. Have the Specialist claim the group first.");
        }

        const room = roomDoc.data();
        const specialistId = ctx.from.id.toString();
        if (specialistId !== room.specialist_id) {
            return ctx.reply("❌ Only the linked Specialist can schedule this group.");
        }

        if (!room.course_start_date) {
            await ctx.reply(`⚠️ I recommend setting the first course date for this group with:\n/setprogram ${groupId} YYYY-MM-DD\nThis allows the performance meter and weekly tracking to work correctly.`);
        }

        const todayStr = getLagosDateString();
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
        const announcementText = `📢 **Live Session Scheduled**\n\nA live session for **${room.group_name}** is confirmed at **${timeInput}** today.${topicText}\n\nI will pin this announcement and send personal reminders to the Specialist and verified trainees at 30, 15, and 5 minutes before class.`;
        try {
            const sentMessage = await ctx.telegram.sendMessage(groupId, announcementText, { parse_mode: 'Markdown' });
            await ctx.telegram.pinChatMessage(groupId, sentMessage.message_id, { disable_notification: true });
        } catch (error) {
            await reportError('Could not announce or pin the class message', error);
        }

        ctx.reply(`✅ Locked in! Class for **${room.group_name}** is set for ${timeInput} today. I have announced it and will send reminders. 🚀`, { parse_mode: 'Markdown' });

        const verifiedTrainees = await getVerifiedTraineeIds(groupId);
        const reminderText = `✅ Live session for **${room.group_name}** is scheduled at **${timeInput}** today.${topic ? ` Topic: ${topic}` : ''} I will remind you 30, 15, and 5 minutes before the class.`;
        await sendDmUsers(normalizeUserIds([room.specialist_id, ...verifiedTrainees]), reminderText, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('setclass command failed', error);
        ctx.reply('❌ Failed to schedule the class. Please try again.');
    }
});

bot.command('cancelclass', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        const groupId = args[1];
        const timeInput = args[2];

        if (!groupId) {
            return ctx.reply("❌ Format error. Please use: /cancelclass <group_id> [time]\nExample: /cancelclass -100123456 14:00");
        }

        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            return ctx.reply('❌ That group is not linked to a classroom.');
        }

        const room = roomDoc.data();
        const specialistId = ctx.from.id.toString();
        if (specialistId !== room.specialist_id) {
            return ctx.reply('❌ Only the linked Specialist can cancel the class.');
        }

        const todayStr = getLagosDateString();
        let canceledCount = 0;

        if (timeInput) {
            if (!CLASS_TIME_REGEX.test(timeInput)) {
                return ctx.reply('❌ Time format should be HH:MM in 24-hour format.');
            }
            const classId = getClassDocId(groupId, todayStr, timeInput);
            const classDoc = await db.collection('classes').doc(classId).get();
            if (!classDoc.exists || classDoc.data().status !== 'active') {
                return ctx.reply('❌ No active class scheduled at that time.');
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
                return ctx.reply('❌ No active classes scheduled for today to cancel.');
            }
            for (const classDoc of snapshot.docs) {
                await db.collection('classes').doc(classDoc.id).update({ status: 'canceled', canceled_at: admin.firestore.FieldValue.serverTimestamp() });
                canceledCount += 1;
            }
        }

        const cancelMessage = `⚠️ The live session${timeInput ? ` at ${timeInput}` : ''} for **${room.group_name}** has been canceled.`;
        await ctx.telegram.sendMessage(groupId, cancelMessage, { parse_mode: 'Markdown' });
        ctx.reply(`✅ Canceled ${canceledCount} scheduled class(es).`);
    } catch (error) {
        await reportError('cancelclass command failed', error);
        ctx.reply('❌ Failed to cancel the class. Please try again.');
    }
});

bot.command('rescheduleclass', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        const groupId = args[1];
        const oldTime = args[2];
        const newTime = args[3];

        if (!groupId || !oldTime || !newTime) {
            return ctx.reply('❌ Format error. Please use: /rescheduleclass <group_id> <old_time> <new_time>\nExample: /rescheduleclass -100123456 14:00 15:00');
        }

        if (!CLASS_TIME_REGEX.test(oldTime) || !CLASS_TIME_REGEX.test(newTime)) {
            return ctx.reply('❌ Time format should be HH:MM in 24-hour format.');
        }

        if (oldTime === newTime) {
            return ctx.reply('⚠️ The new time must be different from the old time.');
        }

        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            return ctx.reply('❌ That group is not linked to a classroom.');
        }

        const room = roomDoc.data();
        const specialistId = ctx.from.id.toString();
        if (specialistId !== room.specialist_id) {
            return ctx.reply('❌ Only the linked Specialist can reschedule this class.');
        }

        const todayStr = getLagosDateString();
        const oldClassId = getClassDocId(groupId, todayStr, oldTime);
        const oldClassDoc = await db.collection('classes').doc(oldClassId).get();
        if (!oldClassDoc.exists || oldClassDoc.data().status !== 'active') {
            return ctx.reply('❌ No active class exists at the old time.');
        }

        const newClassId = getClassDocId(groupId, todayStr, newTime);
        const existingNewClass = await db.collection('classes').doc(newClassId).get();
        if (existingNewClass.exists && existingNewClass.data().status === 'active') {
            return ctx.reply('❌ A class is already scheduled at the new time.');
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

        const announcementText = `🔄 **Class Rescheduled**\n\nThe live session for **${room.group_name}** has been moved from **${oldTime}** to **${newTime}** today.${oldClassDoc.data().topic ? `\n\n**Topic:** ${oldClassDoc.data().topic}` : ''}`;
        try {
            const sentMessage = await ctx.telegram.sendMessage(groupId, announcementText, { parse_mode: 'Markdown' });
            await ctx.telegram.pinChatMessage(groupId, sentMessage.message_id, { disable_notification: true });
        } catch (error) {
            await reportError('Could not announce or pin the rescheduled class message', error);
        }

        ctx.reply(`✅ Rescheduled class from ${oldTime} to ${newTime}.`);

        const verifiedTrainees = await getVerifiedTraineeIds(groupId);
        const reminderText = `🔄 The live session for **${room.group_name}** has been rescheduled to **${newTime}** today.${oldClassDoc.data().topic ? ` Topic: ${oldClassDoc.data().topic}` : ''}`;
        await sendDmUsers(normalizeUserIds([room.specialist_id, ...verifiedTrainees]), reminderText, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('rescheduleclass command failed', error);
        ctx.reply('❌ Failed to reschedule the class. Please try again.');
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
            reminderText = `🚨 **Class Starting Now** 🚨\n\nLive session for **${room.group_name}** is starting now at **${classData.time}**.${topicText} Please join immediately.`;
            groupReminder = reminderText;
        } else {
            reminderText = `⏰ **Class Reminder** (${reminderType} minutes)\n\nLive session for **${room.group_name}** starts at **${classData.time}**.${topicText}\n\nPlease prepare and join on time.`;
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
            const attendancePrompt = `📊 **Attendance Check**\n\nDid you attend the live session for **${room.group_name}**?${topicText}\n\nReply with /attended or /missed in a private chat with me.`;
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
            const feedbackText = `📝 **Session Feedback**\n\nHow was the live session for **${room.group_name}**?${classData.topic ? ` Topic: ${classData.topic}` : ''}\n\nRate 1-5 stars or share your thoughts in a reply to this message.`;
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
                    summary += `\n• ${classData.group_name} at *${classData.time}*${topic}`;
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

        const message = `📊 **Weekly Report Time!**\n\nGood morning ${specialistName}! It's Saturday, time to review your weekly performance.\n\nUse /weeklyreport in a private chat with me to generate and download your weekly summary, including class counts, attendance rates, and feedback.`;
        
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
            await db.collection('pending_verifications').doc(member.id.toString()).set({
                telegram_id: member.id,
                username: member.username || member.first_name,
                group_id: groupId,
                joined_at: admin.firestore.FieldValue.serverTimestamp(),
                verified: false,
                timed_out: false
            });
        }

        await ctx.reply(`Welcome to Skillforge Digital! 🚀\n\nTo ensure a safe environment, please verify your account within 24 hours or you will be timed out.`,
            Markup.inlineKeyboard([Markup.button.url('Verify Now ✅', BOT_LINK)])
        );
    } catch (error) {
        console.log("Could not send welcome message (Bot might have been kicked):", error.message);
    }
});

bot.start(async (ctx) => {
    const payload = ctx.startPayload;
    const userId = ctx.from.id.toString();

    if (payload === 'verify') {
        const userRef = db.collection('pending_verifications').doc(userId);
        const doc = await userRef.get();

        if (!doc.exists) return ctx.reply("I couldn't find your record. Have you joined a Skillforge group yet?");
        if (doc.data().verified) return ctx.reply("You are already verified! 🎓");

        await userRef.update({ verified: true, timed_out: false });

        try {
            await ctx.telegram.restrictChatMember(doc.data().group_id, userId, {
                permissions: { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_other_messages: true, can_add_web_page_previews: true }
            });
        } catch (error) { 
            console.log("Permission restore error:", error.message);
        }

        ctx.reply("Verification successful! ✅ You now have full access.");
    } else {
        ctx.reply("Welcome! If you are a Specialist, use /register [password]. If you are a trainee, use the verify button in your main group.");
    }
});

cron.schedule('0 * * * *', async () => {
    try {
        const snapshot = await db.collection('pending_verifications').where('verified', '==', false).where('timed_out', '==', false).get();
        if (snapshot.empty) return;

        const groups = {};
        snapshot.forEach(doc => {
            const data = doc.data();
            if (!groups[data.group_id]) groups[data.group_id] = [];
            groups[data.group_id].push(`@${data.username}`);
        });

        for (const [groupId, users] of Object.entries(groups)) {
            const message = `⚠️ **Verification Reminder** ⚠️\n\n${users.length} members still need to verify. Please verify to avoid a chat timeout:\n${users.join(', ')}`;
            try {
                await bot.telegram.sendMessage(groupId, message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.url('Verify Now ✅', BOT_LINK)]) });
            } catch (error) {
                await reportError('Hourly reminder error', error);
            }
        }
    } catch (error) {
        await reportError('Hourly verification reminder job failed', error);
    }
});

cron.schedule('*/30 * * * *', async () => {
    try {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const timeoutThreshold = admin.firestore.Timestamp.fromDate(yesterday);

        const snapshot = await db.collection('pending_verifications')
            .where('verified', '==', false)
            .where('timed_out', '==', false)
            .where('joined_at', '<=', timeoutThreshold)
            .get();
        if (!snapshot.empty) {
            for (const doc of snapshot.docs) {
                const data = doc.data();
                try {
                    await bot.telegram.restrictChatMember(data.group_id, data.telegram_id, { permissions: { can_send_messages: false } });
                    await db.collection('pending_verifications').doc(doc.id).update({ timed_out: true });
                    const message = `⏳ @${data.username} has been timed out for failing to verify within 24 hours.`;
                    await bot.telegram.sendMessage(data.group_id, message, Markup.inlineKeyboard([Markup.button.url('Verify to Restore Access 🔓', BOT_LINK)]));
                } catch (error) {
                    await reportError('Timeout enforcement error', error);
                }
            }
        }

        const removalCutoff = new Date(Date.now() - 25 * 60 * 60 * 1000);
        const removalThreshold = admin.firestore.Timestamp.fromDate(removalCutoff);
        const removalSnapshot = await db.collection('pending_verifications')
            .where('verified', '==', false)
            .where('timed_out', '==', true)
            .where('joined_at', '<=', removalThreshold)
            .get();

        if (!removalSnapshot.empty) {
            for (const doc of removalSnapshot.docs) {
                const data = doc.data();
                try {
                    await bot.telegram.kickChatMember(data.group_id, data.telegram_id);
                    await db.collection('pending_verifications').doc(doc.id).update({ removed: true, removed_at: admin.firestore.FieldValue.serverTimestamp() });
                    const message = `⛔ @${data.username} has been removed for failing to verify after timeout.`;
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

app.get('/', (req, res) => res.send('Skillforge Principal Bot is running!'));

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

app.listen(PORT, '0.0.0.0', () => console.log(`Web server listening on port ${PORT}`));

bot.launch().then(() => console.log('Skillforge Bot is fully operational!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));