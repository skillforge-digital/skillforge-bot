require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cron = require('node-cron');
const express = require('express'); // Dummy web server

// --- 1. SETUP & CONNECTIONS ---
const app = express();
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
const bot = new Telegraf(process.env.BOT_TOKEN);
const BOT_LINK = `https://t.me/${process.env.BOT_USERNAME}?start=verify`;

// ==========================================
// MODULE 1: SPECIALIST & CLASSROOM MANAGER
// ==========================================

/**
 * COMMAND: /register [password] (Used in DMs by staff)
 * Onboards a new Specialist
 */
bot.command('register', async (ctx) => {
    const messageText = ctx.message.text.split(' ');
    const password = messageText[1];

    if (password !== process.env.STAFF_PASSWORD) {
        return ctx.reply("❌ Invalid Skillforge master password.");
    }

    const specialistId = ctx.from.id.toString();
    const specialistName = ctx.from.first_name;

    // Save Specialist to Firebase
    await db.collection('specialists').doc(specialistId).set({
        telegram_id: specialistId,
        name: specialistName,
        registered_at: admin.firestore.FieldValue.serverTimestamp()
    });

    ctx.reply(`✅ Welcome to the team, Specialist ${specialistName}! \n\nYou are now authorized. Please go to your cohort's Telegram group, add me as an Admin, and type /claim to link the classroom to your profile.`);
});

/**
 * COMMAND: /claim (Used inside the group by the Specialist)
 * Links the group to the Specialist and grabs the group name
 */
bot.command('claim', async (ctx) => {
    const specialistId = ctx.from.id.toString();
    const groupId = ctx.chat.id.toString();
    const groupName = ctx.chat.title; // Grabs the name! e.g., "Currency Pairs"

    // 1. Check if the person is a verified Specialist
    const specialistDoc = await db.collection('specialists').doc(specialistId).get();
    if (!specialistDoc.exists) {
        return ctx.reply("❌ You must be registered as a Specialist to claim a group.");
    }

    const specialistData = specialistDoc.data();

    // 2. Save the Classroom to Firebase
    await db.collection('classrooms').doc(groupId).set({
        group_id: groupId,
        group_name: groupName,
        specialist_id: specialistId,
        specialist_name: specialistData.name
    });

    ctx.reply(`✅ Classroom successfully linked!\n\nI have registered this group as **${groupName}** under Specialist **${specialistData.name}**.\n\nI will DM the Specialist every morning to ask about the class schedule.`);
});

/**
 * CRON: Morning Class Check (Runs every day at 8:00 AM Lagos Time)
 * Asks every Specialist about their specific groups
 */
cron.schedule('0 8 * * *', async () => {
    const classroomsSnapshot = await db.collection('classrooms').get();
    if (classroomsSnapshot.empty) return;

    classroomsSnapshot.forEach(async (doc) => {
        const room = doc.data();
        
        const message = `Good morning Specialist ${room.specialist_name}! ☀️\n\nDo we have a class for **${room.group_name}** today?\n\nIf yes, copy the command below, add your time, and send it back to me:\n\n\`/setclass ${room.group_id} 14:00\``;
        
        try {
            await bot.telegram.sendMessage(room.specialist_id, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.log(`Failed to message Specialist ${room.specialist_name}.`);
        }
    });
}, { timezone: "Africa/Lagos" });

/**
 * COMMAND: /setclass [group_id] [time]
 * Specialist sets the time for a specific classroom
 */
bot.command('setclass', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const groupId = args[1];
    const timeInput = args[2];

    if (!groupId || !timeInput) {
        return ctx.reply("❌ Format error. Please use: /setclass <group_id> <time>\nExample: /setclass -100123456 14:00");
    }

    const todayStr = new Date().toISOString().split('T')[0]; 
    
    // Save the class schedule for this specific group
    await db.collection('classes').doc(groupId).set({
        date: todayStr,
        time: timeInput,
        reminder_sent: false,
        group_id: groupId
    });

    // Let the specialist know it worked
    const roomDoc = await db.collection('classrooms').doc(groupId).get();
    const groupName = roomDoc.exists ? roomDoc.data().group_name : "the group";

    ctx.reply(`✅ Locked in! Class for **${groupName}** is set for ${timeInput} today. I will handle the 30-minute warning. 🚀`, { parse_mode: 'Markdown' });
});

/**
 * CRON: 30-Minute Class Warning (Checks every minute)
 */
cron.schedule('* * * * *', async () => {
    const classesSnapshot = await db.collection('classes').get();
    if (classesSnapshot.empty) return;

    const todayStr = new Date().toISOString().split('T')[0];
    const now = new Date();
    const lagosTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    
    const [currentHour, currentMin] = lagosTime.split(':').map(Number);
    const currentTotalMins = (currentHour * 60) + currentMin;

    classesSnapshot.forEach(async (doc) => {
        const classData = doc.data();
        
        if (classData.reminder_sent || classData.date !== todayStr) return;

        const [classHour, classMin] = classData.time.split(':').map(Number);
        const classTotalMins = (classHour * 60) + classMin;

        // Is it exactly 30 minutes before class?
        if (classTotalMins - currentTotalMins === 30) {
            const message = `🚨 **CLASS REMINDER** 🚨\n\nSkillforge trainees, class will begin in exactly **30 minutes** (at ${classData.time}).\n\nPlease get your tools and workstations ready!`;
            
            try {
                await bot.telegram.sendMessage(classData.group_id, message, { parse_mode: 'Markdown' });
                await db.collection('classes').doc(doc.id).update({ reminder_sent: true });
            } catch (error) {
                console.log("Could not send reminder.");
            }
        }
    });
}, { timezone: "Africa/Lagos" });


// ==========================================
// MODULE 2: STUDENT VERIFICATION SYSTEM
// ==========================================

bot.on('new_chat_members', async (ctx) => {
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

    ctx.reply(`Welcome to Skillforge Digital! 🚀\n\nTo ensure a safe environment, please verify your account within 24 hours or you will be timed out.`,
        Markup.inlineKeyboard([Markup.button.url('Verify Now ✅', BOT_LINK)])
    );
});

bot.start(async (ctx) => {
    const payload = ctx.payload; 
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
        } catch (error) { }

        ctx.reply("Verification successful! ✅ You now have full access.");
    } else {
        ctx.reply("Welcome! If you are a Specialist, use /register [password]. If you are a trainee, use the verify button in your main group.");
    }
});

cron.schedule('0 * * * *', async () => {
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
        } catch (error) { }
    }
});

cron.schedule('*/30 * * * *', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const timeoutThreshold = admin.firestore.Timestamp.fromDate(yesterday);

    const snapshot = await db.collection('pending_verifications').where('verified', '==', false).where('timed_out', '==', false).where('joined_at', '<=', timeoutThreshold).get();
    if (snapshot.empty) return;

    for (const doc of snapshot.docs) {
        const data = doc.data();
        try {
            await bot.telegram.restrictChatMember(data.group_id, data.telegram_id, { permissions: { can_send_messages: false } });
            await db.collection('pending_verifications').doc(doc.id).update({ timed_out: true });
            const message = `⏳ @${data.username} has been timed out for failing to verify within 24 hours.`;
            await bot.telegram.sendMessage(data.group_id, message, Markup.inlineKeyboard([Markup.button.url('Verify to Restore Access 🔓', BOT_LINK)]));
        } catch (error) { }
    }
});

// ==========================================
// MODULE 3: SERVER START
// ==========================================

app.get('/', (req, res) => res.send('Skillforge Principal Bot is running!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));

bot.launch().then(() => console.log('Skillforge Bot is fully operational!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));