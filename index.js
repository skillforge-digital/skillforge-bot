const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cron = require('node-cron');
const serviceAccount = require('./firebase-service-account.json');

require('dotenv').config();

// 1. Connect to your Firebase Notebook

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 2. Wake up the Telegram Bot using your secret token
const bot = new Telegraf(process.env.BOT_TOKEN);

// The magic link that takes them to the bot to verify
const BOT_LINK = `https://t.me/${process.env.BOT_USERNAME}?start=verify`;

/**
 * RULE 1: When new people join the group
 */
bot.on('new_chat_members', async (ctx) => {
        const newMembers = ctx.message.new_chat_members;
        const groupId = ctx.chat.id;

        for (const member of newMembers) {
                // Ignore other bots
                if (member.is_bot) continue;

                // Write their name in the Firebase Notebook
                await db.collection('pending_verifications').doc(member.id.toString()).set({
                        telegram_id: member.id,
                        username: member.username || member.first_name,
                        group_id: groupId,
                        joined_at: admin.firestore.FieldValue.serverTimestamp(),
                        verified: false,
                        timed_out: false
                });
        }

        // Greet them in the group
        ctx.reply(
                `Welcome to Skillforge Digital! 🚀\n\nTo ensure a safe environment, please verify your account within 24 hours or you will be timed out.`,
                Markup.inlineKeyboard([
                        Markup.button.url('Verify Now ✅', BOT_LINK)
                ])
        );
});

/**
 * RULE 2: When they click the "Verify Now" button and talk to the bot
 */
bot.start(async (ctx) => {
        const payload = ctx.payload; 
        const userId = ctx.from.id.toString();

        if (payload === 'verify') {
                const userRef = db.collection('pending_verifications').doc(userId);
                const doc = await userRef.get();

                if (!doc.exists) {
                        return ctx.reply("I couldn't find your record. Have you joined the main group yet?");
                }

                const userData = doc.data();

                if (userData.verified) {
                        return ctx.reply("You are already verified! You can chat in the group. 🎓");
                }

                // Check off their name in the notebook
                await userRef.update({ verified: true, timed_out: false });

                // Un-mute them in the main group if they were timed out
                try {
                        await ctx.telegram.restrictChatMember(userData.group_id, userData.telegram_id, {
                                permissions: {
                                        can_send_messages: true,
                                        can_send_audios: true,
                                        can_send_documents: true,
                                        can_send_photos: true,
                                        can_send_videos: true,
                                        can_send_other_messages: true,
                                        can_add_web_page_previews: true
                                }
                        });
                } catch (error) {
                        console.log("Error restoring permissions:", error);
                }

                ctx.reply("Verification successful! ✅ You now have full access to the Skillforge Digital group.");
        } else {
                ctx.reply("Welcome to the Skillforge Digital Bot. Please use the verify button in the main group.");
        }
});

/**
 * RULE 3: The Hourly Reminder
 * Checks the notebook every hour and tags people who haven't verified
 */
cron.schedule('0 * * * *', async () => {
        console.log("Checking for people who need reminders...");
        const snapshot = await db.collection('pending_verifications')
                .where('verified', '==', false)
                .where('timed_out', '==', false)
                .get();

        if (snapshot.empty) return;

        const groups = {};
        snapshot.forEach(doc => {
                const data = doc.data();
                if (!groups[data.group_id]) groups[data.group_id] = [];
                groups[data.group_id].push(`@${data.username}`);
        });

        for (const [groupId, users] of Object.entries(groups)) {
                const mentions = users.join(', ');
                const message = `⚠️ **Verification Reminder** ⚠️\n\n${users.length} members still need to verify. Please verify to avoid a chat timeout:\n${mentions}`;
                
                try {
                        await bot.telegram.sendMessage(groupId, message, {
                                parse_mode: 'Markdown',
                                ...Markup.inlineKeyboard([
                                        Markup.button.url('Verify Now ✅', BOT_LINK)
                                ])
                        });
                } catch (error) {
                        console.log("Could not send reminder.");
                }
        }
});

/**
 * RULE 4: The 24-Hour Timeout
 * Checks the notebook every 30 minutes for expired time limits
 */
cron.schedule('*/30 * * * *', async () => {
        console.log("Checking for expired 24-hour timers...");
        
        // Calculate what time it was exactly 24 hours ago
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const timeoutThreshold = admin.firestore.Timestamp.fromDate(yesterday);

        const snapshot = await db.collection('pending_verifications')
                .where('verified', '==', false)
                .where('timed_out', '==', false)
                .where('joined_at', '<=', timeoutThreshold)
                .get();

        if (snapshot.empty) return;

        for (const doc of snapshot.docs) {
                const data = doc.data();

                // Mute the user in the group
                try {
                        await bot.telegram.restrictChatMember(data.group_id, data.telegram_id, {
                                permissions: { can_send_messages: false }
                        });

                        // Mark them as timed out in the notebook
                        await db.collection('pending_verifications').doc(doc.id).update({ timed_out: true });

                        // Tell the group they were timed out
                        const message = `⏳ @${data.username} has been timed out for failing to verify within 24 hours.\n\nYou can get your chatting privileges back instantly by clicking the button below.`;
                        
                        await bot.telegram.sendMessage(data.group_id, message, Markup.inlineKeyboard([
                                Markup.button.url('Verify to Restore Access 🔓', BOT_LINK)
                        ]));

                } catch (error) {
                        console.log("Failed to timeout user.");
                }
        }
});

// Turn the bot on!
bot.launch().then(() => console.log('Skillforge Bot is awake and running!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));