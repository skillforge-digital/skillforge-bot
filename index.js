require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Telegraf, Markup } = require('telegraf');
const PDFDocument = require('pdfkit');
const admin = require('firebase-admin');
const cron = require('node-cron');
const express = require('express');
const { createSequentialLimiter, withTelegramRetry } = require('./lib/telegramLimiter');
const { adjustGroupCounters, computeCountersFromVerificationDocs } = require('./lib/groupCounters');
const { isGroupAdmin, setGroupAdmin, removeGroupAdmin, listGroupAdmins } = require('./lib/groupAdmins');

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

if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️  OPENAI_API_KEY not set — AI features will be disabled.');
} else {
    console.log('✅ OpenAI API key detected. AI features enabled.');
}

const BOT_USERNAME_SAFE = (process.env.BOT_USERNAME || 'skillforge_bot').replace(/^@/, '').trim();
const BOT_LINK_BASE = `https://t.me/${BOT_USERNAME_SAFE}?start=`;
const getVerifyLink = (groupId) => `${BOT_LINK_BASE}verify_${encodeURIComponent(String(groupId))}`;
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID || null;
const MOD_LOG_CHAT_ID = process.env.MOD_LOG_CHAT_ID || null;
const FEEDBACK_LOG_CHAT_ID = process.env.FEEDBACK_LOG_CHAT_ID || null;
const SERVER_URL = process.env.SERVER_URL || null;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;
const SUPER_ADMIN_KEY = process.env.SUPER_ADMIN_KEY || null;
const REPORT_LOGO_PATH = process.env.REPORT_LOGO_PATH || './logo.jpg';
const REPORT_LOGOTAG = process.env.REPORT_LOGOTAG || 'Skillforge Principal Bot';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
const OPENAI_MOD_MODEL = process.env.OPENAI_MOD_MODEL || 'omni-moderation-latest';
const LINK_ALLOWLIST = new Set(
    String(process.env.LINK_ALLOWLIST || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
);
const CLASS_TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EXCLUDED_SYSTEM_USER_IDS = new Set(['1087968824', '777000']);
const EXCLUDED_SYSTEM_USERNAMES = new Set(['groupanonymousbot', 'telegram']);
const SUPER_ADMIN_IDS = new Set(
    String(process.env.SUPER_ADMIN_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
);

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

app.post('/api/webapp/role', async (req, res) => {
    try {
        const initData = String(req.body?.initData || '').trim();
        if (!initData) return res.status(400).json({ ok: false, error: 'initData required' });
        const verified = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
        if (!verified.ok) return res.status(401).json({ ok: false, error: verified.error });

        const userId = String(verified.user.id);
        const specialistDoc = await db.collection('specialists').doc(userId).get();
        const role = specialistDoc.exists ? 'specialist' : 'public';
        return res.json({ ok: true, role, user_id: userId });
    } catch (error) {
        await reportError('webapp role failed', error);
        return res.status(500).json({ ok: false, error: 'failed' });
    }
});

// Utility function to generate bot mention
const getBotMention = () => `@${BOT_USERNAME_SAFE}`;
const getBotDirectMessageLink = () => `https://t.me/${BOT_USERNAME_SAFE}`;

const bot = new Telegraf(process.env.BOT_TOKEN);

{
    const originalSendMessage = bot.telegram.sendMessage.bind(bot.telegram);
    const telegramLimiter = createSequentialLimiter();
    bot.telegram.sendMessage = (chatId, text, extra) => telegramLimiter(() => withTelegramRetry(() => originalSendMessage(chatId, normalizeBotText(text), extra)));
    if (typeof bot.telegram.restrictChatMember === 'function') {
        const originalRestrict = bot.telegram.restrictChatMember.bind(bot.telegram);
        bot.telegram.restrictChatMember = (chatId, userId, extra) => telegramLimiter(() => withTelegramRetry(() => originalRestrict(chatId, userId, extra)));
    }
    if (typeof bot.telegram.kickChatMember === 'function') {
        const originalKick = bot.telegram.kickChatMember.bind(bot.telegram);
        bot.telegram.kickChatMember = (chatId, userId, extra) => telegramLimiter(() => withTelegramRetry(() => originalKick(chatId, userId, extra)));
    }
    if (typeof bot.telegram.unbanChatMember === 'function') {
        const originalUnban = bot.telegram.unbanChatMember.bind(bot.telegram);
        bot.telegram.unbanChatMember = (chatId, userId, extra) => telegramLimiter(() => withTelegramRetry(() => originalUnban(chatId, userId, extra)));
    }
}

bot.use(async (ctx, next) => {
    try {
        if (typeof ctx.reply === 'function') {
            const originalReply = ctx.reply.bind(ctx);
            ctx.reply = (text, extra) => originalReply(normalizeBotText(text), extra);
        }
        if (typeof ctx.editMessageText === 'function') {
            const originalEdit = ctx.editMessageText.bind(ctx);
            ctx.editMessageText = (text, extra) => originalEdit(normalizeBotText(text), extra);
        }
        if (typeof ctx.answerCbQuery === 'function') {
            const originalAnswer = ctx.answerCbQuery.bind(ctx);
            ctx.answerCbQuery = (text, extra) => originalAnswer(text == null ? text : normalizeBotText(text), extra);
        }
    } catch {}
    return next();
});

bot.catch(async (error, ctx) => {
    try {
        await reportError('Telegraf handler error', error);
    } catch {}
    try {
        if (ctx?.chat?.type === 'private') {
            await ctx.reply('❌ Something went wrong. Please try again.');
        }
    } catch {}
});

const getClassDocId = (groupId, date, time) => `${groupId}_${date}_${time}`;
const normalizeUserIds = (userIds) => [...new Set(userIds.filter(Boolean).map(String))];
const getVerificationDocId = (groupId, userId) => `${groupId}_${userId}`;

const verifyTelegramInitData = (initData, botToken) => {
    const crypto = require('crypto');
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { ok: false, error: 'missing hash' };
    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return { ok: false, error: 'bad hash' };

    const userStr = params.get('user');
    if (!userStr) return { ok: false, error: 'missing user' };
    const user = JSON.parse(userStr);
    return { ok: true, user };
};

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

const isSuperAdminId = (userId) => SUPER_ADMIN_IDS.has(String(userId));

const isStaffUser = async (userId) => {
    const uid = String(userId);
    if (isSuperAdminId(uid)) return true;
    return await isSpecialist(uid);
};

const requireStaff = async (ctx) => {
    const uid = ctx.from?.id ? String(ctx.from.id) : null;
    if (!uid) return false;
    const ok = await isStaffUser(uid);
    if (!ok) {
        await ctx.reply('Staff only.');
        return false;
    }
    return true;
};

const requireClassroomOwnerOrSuperAdmin = async (ctx, groupId) => {
    const uid = ctx.from?.id ? String(ctx.from.id) : null;
    if (!uid) return false;
    if (isSuperAdminId(uid)) return true;
    const roomDoc = await db.collection('classrooms').doc(String(groupId)).get();
    const room = roomDoc.exists ? roomDoc.data() : null;
    if (room && String(room.specialist_id || '') === uid) return true;
    await ctx.reply('You do not have access to this group.');
    return false;
};

const requireGroupManager = async (ctx, groupId) => {
    const uid = ctx.from?.id ? String(ctx.from.id) : null;
    if (!uid) return false;
    if (isSuperAdminId(uid)) return true;
    if (await isSpecialist(uid)) return true;
    const ok = await isGroupAdmin(db, String(groupId), uid);
    if (!ok) {
        await ctx.reply('Admins only.');
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

const updateVerifyReminderSent = async (groupId, messageId = null) => {
    const payload = {
        last_verify_reminder_at: admin.firestore.FieldValue.serverTimestamp()
    };
    if (messageId != null) payload.last_verify_tag_message_id = String(messageId);
    await db.collection('group_settings').doc(String(groupId)).set(payload, { merge: true });
};

const updateVerifyTagMessageId = async (groupId, messageId = null) => {
    if (messageId == null) return;
    await db.collection('group_settings').doc(String(groupId)).set({
        last_verify_tag_message_id: String(messageId)
    }, { merge: true });
};

const getGroupSettings = async (groupId) => {
    const doc = await db.collection('group_settings').doc(String(groupId)).get();
    return doc.exists ? (doc.data() || {}) : null;
};

const deleteLastVerifyTagMessage = async (groupId, settings) => {
    const mid = settings?.last_verify_tag_message_id ? String(settings.last_verify_tag_message_id) : null;
    if (!mid) return;
    try {
        await bot.telegram.deleteMessage(groupId, Number(mid));
    } catch {}
};

const getBypassAdminIdSet = async (groupId) => {
    const out = new Set();
    try {
        const admins = await bot.telegram.getChatAdministrators(groupId);
        for (const a of admins || []) {
            const id = a?.user?.id;
            if (id != null) out.add(String(id));
        }
    } catch {}
    try {
        const stored = await listGroupAdmins(db, groupId, 200);
        for (const row of stored || []) {
            const id = row?.user_id || row?.id;
            if (id != null) out.add(String(id));
        }
    } catch {}
    return out;
};

const bypassVerificationForAdmin = async (groupId, verification) => {
    const userId = String(verification?.user_id || '');
    if (!userId) return;
    if (Boolean(verification.verified) || Boolean(verification.removed)) return;
    const pendingDelta = verification.timed_out ? 0 : -1;
    const timedOutDelta = verification.timed_out ? -1 : 0;
    await adjustGroupCounters(db, groupId, { verified_count: 1, unverified_count: -1, pending_count: pendingDelta, timed_out_count: timedOutDelta });
    await setGroupVerification(groupId, userId, {
        verified: true,
        verified_at: admin.firestore.FieldValue.serverTimestamp(),
        timed_out: false,
        timed_out_at: null,
        bypassed_admin: true
    });
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

const normalizeBotText = (text) => {
    if (text == null) return text;
    return String(text)
        .replaceAll('â—ï¸', '❗️')
        .replaceAll('âŒ', '❌')
        .replaceAll('âœ…', '✅')
        .replaceAll('âš ï¸', '⚠️')
        .replaceAll('â³', '⏳')
        .replaceAll('â›”', '🚫')
        .replaceAll('â˜€ï¸', '☀️')
        .replaceAll('ðŸš€', '🚀')
        .replaceAll('ðŸ“Š', '📊')
        .replaceAll('ðŸ“', '📝')
        .replaceAll('ðŸ‘¥', '👥')
        .replaceAll('â­', '⭐')
        .replaceAll('â€¢', '•');
};

const escapeHtml = (text) => String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const buildUserMentionHtml = (userId, label) => `<a href="tg://user?id=${encodeURIComponent(String(userId))}">${escapeHtml(label)}</a>`;

const shouldTrackUser = (user) => {
    if (!user) return false;
    if (user.is_bot) return false;
    const id = user.id == null ? '' : String(user.id);
    if (EXCLUDED_SYSTEM_USER_IDS.has(id)) return false;
    const uname = user.username ? String(user.username).toLowerCase() : '';
    if (uname && EXCLUDED_SYSTEM_USERNAMES.has(uname)) return false;
    return true;
};

const getUserProfileFields = (user) => {
    const username = user?.username ? String(user.username) : null;
    const first_name = user?.first_name ? String(user.first_name) : null;
    const last_name = user?.last_name ? String(user.last_name) : null;
    const display_name = first_name ? (last_name ? `${first_name} ${last_name}` : first_name) : (username ? username : null);
    return { username, first_name, last_name, display_name, is_bot: Boolean(user?.is_bot) };
};

const upsertUserProfile = async (user) => {
    if (!user?.id) return;
    const userId = String(user.id);
    if (EXCLUDED_SYSTEM_USER_IDS.has(userId)) return;
    const profile = getUserProfileFields(user);
    await db.collection('users').doc(userId).set({
        user_id: userId,
        ...profile,
        last_seen_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
};

const reportError = async (message, error) => {
    const fullMessage = normalizeBotText(`❗️ Bot error: ${message}${error ? `\n${error.message || error}` : ''}`);
    console.error(fullMessage);
    if (REPORT_CHAT_ID) {
        try {
            await bot.telegram.sendMessage(REPORT_CHAT_ID, fullMessage);
        } catch (err) {
            console.error('Failed to send error report:', err.message);
        }
    }
};

const sendLogMessage = async (chatId, text, extra = {}) => {
    if (!chatId) return;
    try {
        await bot.telegram.sendMessage(chatId, String(text || ''), extra);
    } catch {}
};

const openaiRequestJson = async (pathname, payload) => {
    if (!OPENAI_API_KEY) return { ok: false, error: 'missing OPENAI_API_KEY' };
    return await new Promise((resolve) => {
        let url;
        try {
            const base = String(OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '');
            const path = String(pathname || '').startsWith('/') ? String(pathname || '') : `/${String(pathname || '')}`;
            url = new URL(base + path);
        } catch {
            resolve({ ok: false, error: 'bad url' });
            return;
        }

        const body = Buffer.from(JSON.stringify(payload || {}));
        const req = https.request(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': String(body.length)
            }
        }, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                try {
                    const parsed = JSON.parse(raw || '{}');
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ ok: true, data: parsed });
                        return;
                    }
                    resolve({ ok: false, error: parsed?.error?.message || `http ${res.statusCode}`, data: parsed });
                } catch {
                    resolve({ ok: false, error: `http ${res.statusCode}`, raw });
                }
            });
        });

        req.on('error', (err) => resolve({ ok: false, error: err?.message || String(err) }));
        req.setTimeout(12_000, () => {
            try { req.destroy(new Error('timeout')); } catch {}
        });
        req.write(body);
        req.end();
    });
};

const openaiModerateText = async (text) => {
    const input = String(text || '').trim();
    if (!input) return { ok: true, flagged: false, categories: {}, category_scores: {} };
    const res = await openaiRequestJson('/v1/moderations', { model: OPENAI_MOD_MODEL, input });
    if (!res.ok) return { ok: false, error: res.error };
    const result = res.data?.results?.[0] || {};
    return {
        ok: true,
        flagged: Boolean(result.flagged),
        categories: result.categories || {},
        category_scores: result.category_scores || {}
    };
};

const openaiChatReply = async (messages, options = {}) => {
    const res = await openaiRequestJson('/v1/chat/completions', {
        model: OPENAI_CHAT_MODEL,
        messages: Array.isArray(messages) ? messages : [],
        temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.4,
        max_tokens: Number.isFinite(Number(options.max_tokens)) ? Number(options.max_tokens) : 250
    });
    if (!res.ok) return { ok: false, error: res.error };
    const content = res.data?.choices?.[0]?.message?.content;
    return { ok: true, content: String(content || '').trim() };
};

const aiReplyCooldown = new Map();
const shouldReplyWithAiNow = (key, cooldownMs = 10_000) => {
    const k = String(key || '');
    if (!k) return false;
    const now = Date.now();
    const last = aiReplyCooldown.get(k) || 0;
    if (now - last < cooldownMs) return false;
    aiReplyCooldown.set(k, now);
    return true;
};

const BAD_WORD_PATTERNS = [
    /\bfuck\b/i,
    /\bshit\b/i,
    /\bbitch\b/i,
    /\basshole\b/i,
    /\bbastard\b/i,
    /\bdumb\b/i,
    /\bidiot\b/i,
    /\bstupid\b/i
];

const ADVERT_PATTERNS = [
    /\bearn\s+(extra\s+)?money\b/i,
    /\bmake\s+money\s+online\b/i,
    /\bjoin\s+my\s+(group|channel|class)\b/i,
    /\bloan\s+offer\b/i,
    /\bgiveaway\b/i,
    /\bpromo\s+code\b/i,
    /\bwhatsapp\s+group\b/i
];

const extractUrls = (text) => {
    const src = String(text || '');
    const matches = src.match(/(https?:\/\/[^\s]+|www\.[^\s]+|t\.me\/[^\s]+)/gi) || [];
    return matches.map((m) => m.replace(/[)\],.!?;:'"]+$/g, ''));
};

const getUrlHostname = (rawUrl) => {
    const input = String(rawUrl || '').trim();
    if (!input) return null;
    try {
        const url = new URL(input.startsWith('http') ? input : `https://${input}`);
        return String(url.hostname || '').toLowerCase();
    } catch {
        return null;
    }
};

const textHasBadWords = (text) => {
    const src = String(text || '');
    return BAD_WORD_PATTERNS.some((re) => re.test(src));
};

const textLooksLikeAdvert = (text) => {
    const src = String(text || '');
    return ADVERT_PATTERNS.some((re) => re.test(src));
};

const textHasDisallowedLinks = async (groupId, text) => {
    const urls = extractUrls(text);
    if (!urls.length) return { blocked: false, urls: [] };
    if (!LINK_ALLOWLIST.size) return { blocked: false, urls };
    const settings = await getGroupSettings(groupId);
    const groupAllow = new Set(
        String(settings?.link_allowlist || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
    );
    const allow = groupAllow.size ? groupAllow : LINK_ALLOWLIST;
    const blocked = [];
    for (const u of urls) {
        const host = getUrlHostname(u);
        if (!host) continue;
        const ok = allow.has(host) || Array.from(allow).some((d) => host === d || host.endsWith(`.${d}`));
        if (!ok) blocked.push(u);
    }
    return { blocked: blocked.length > 0, urls, blocked_urls: blocked };
};

const moderationDocId = (groupId, userId) => `${String(groupId)}_${String(userId)}`;

const loadModerationState = async (groupId, userId) => {
    const doc = await db.collection('moderation_state').doc(moderationDocId(groupId, userId)).get();
    return doc.exists ? (doc.data() || {}) : {};
};

const updateModerationState = async (groupId, userId, updates) => {
    await db.collection('moderation_state').doc(moderationDocId(groupId, userId)).set({
        group_id: String(groupId),
        user_id: String(userId),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
        ...updates
    }, { merge: true });
};

const logModeration = async (payload) => {
    const groupId = payload?.group_id ? String(payload.group_id) : '';
    const groupName = payload?.group_name ? String(payload.group_name) : groupId;
    const userId = payload?.user_id ? String(payload.user_id) : '';
    const userLabel = payload?.user_label ? String(payload.user_label) : userId;
    const action = payload?.action ? String(payload.action) : '';
    const reason = payload?.reason ? String(payload.reason) : '';
    const text = payload?.text ? String(payload.text) : '';
    const snippet = text.length > 400 ? `${text.slice(0, 400)}...` : text;
    const when = new Date().toISOString();
    const msg = `🛡️ <b>Moderation</b>\nGroup: <b>${escapeHtml(groupName)}</b>\nUser: ${buildUserMentionHtml(userId, userLabel)}\nAction: <b>${escapeHtml(action)}</b>\nReason: <b>${escapeHtml(reason)}</b>\nAt: <b>${escapeHtml(when)}</b>\n\n${escapeHtml(snippet || '[no text]')}`;
    await sendLogMessage(MOD_LOG_CHAT_ID, msg, { parse_mode: 'HTML' });
};

const logFeedback = async (payload) => {
    const groupId = payload?.group_id ? String(payload.group_id) : '';
    const groupName = payload?.group_name ? String(payload.group_name) : groupId;
    const userId = payload?.user_id ? String(payload.user_id) : '';
    const userLabel = payload?.user_label ? String(payload.user_label) : userId;
    const text = payload?.text ? String(payload.text) : '';
    const snippet = text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
    const when = new Date().toISOString();
    let ai = '';
    if (OPENAI_API_KEY) {
        const r = await openaiChatReply([
            { role: 'system', content: `You are ${REPORT_LOGOTAG}. Summarize the feedback and suggest a short professional reply. Do not include sensitive personal data.` },
            { role: 'user', content: snippet }
        ], { max_tokens: 220, temperature: 0.3 });
        if (r.ok && r.content) ai = r.content;
    }
    const msg = `📝 <b>Feedback</b>\nGroup: <b>${escapeHtml(groupName || 'DM')}</b>\nFrom: ${buildUserMentionHtml(userId, userLabel)}\nAt: <b>${escapeHtml(when)}</b>\n\n${escapeHtml(snippet || '[no text]')}${ai ? `\n\n<b>AI summary + suggested reply</b>\n${escapeHtml(ai)}` : ''}`;
    await sendLogMessage(FEEDBACK_LOG_CHAT_ID, msg, { parse_mode: 'HTML' });
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

                if (options.watermarkText) {
                    try {
                        const text = String(options.watermarkText);
                        const fontSize = Number.isFinite(Number(options.watermarkFontSize)) ? Number(options.watermarkFontSize) : 60;
                        const opacity = Number.isFinite(Number(options.watermarkOpacity)) ? Number(options.watermarkOpacity) : 0.06;
                        doc.save();
                        doc.opacity(opacity);
                        doc.fillColor('gray');
                        doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
                        doc.fontSize(fontSize).text(text, 0, doc.page.height / 2 - fontSize, {
                            width: doc.page.width,
                            align: 'center'
                        });
                        doc.restore();
                        doc.opacity(1);
                        doc.fillColor('black');
                    } catch {}
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
    const feedbackList = [];

    for (const classData of classes) {
        const attendanceSnapshot = await db.collection('attendance')
            .where('class_id', '==', classData.id)
            .get();
        let attendedCount = 0;
        let totalCount = 0;
        if (!attendanceSnapshot.empty) {
            attendedCount = attendanceSnapshot.docs.filter(d => d.data().attended).length;
            totalCount = attendanceSnapshot.size;
        }
        classData.attendance_attended = attendedCount;
        classData.attendance_total = totalCount;
        classData.attendance_missed = totalCount ? (totalCount - attendedCount) : 0;
        classData.was_held = totalCount > 0;

        if (!attendanceSnapshot.empty) {
            heldSessions += 1;
            totalAttendance += attendedCount;
            totalPossibleAttendance += totalCount;
        }

        try {
            const feedbackSnapshot = await db.collection('feedback')
                .where('class_id', '==', classData.id)
                .get();
            const feedbackTexts = feedbackSnapshot.docs.map((d) => d.data()?.feedback).filter(Boolean).map((t) => String(t));
            classData.feedback_count = feedbackTexts.length;
            classData.feedback_samples = feedbackTexts.slice(-3);
            feedbackList.push(...feedbackTexts);
        } catch {
            classData.feedback_count = 0;
            classData.feedback_samples = [];
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
        expectedDays,
        feedbackList
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
    let performance = session.performance || null;
    const perfClasses = Array.isArray(performance?.classes) ? performance.classes : null;
    const perfHasAttendance = Boolean(perfClasses?.length && (perfClasses[0]?.attendance_total != null || perfClasses[0]?.was_held != null));
    if (!performance || !perfClasses || !perfHasAttendance) {
        performance = await getWeekPerformance(
            session.group_id,
            parseDateString(session.week_start),
            parseDateString(session.week_end),
            {
                sessions_per_week: session.sessions_per_week,
                min_days_per_week: session.min_days_per_week
            }
        );
    }

    const lines = [];
    lines.push('Weekly Review Report');
    lines.push('');
    lines.push(`Group: ${session.group_name}`);
    lines.push(`Review period: ${session.week_start} to ${session.week_end}`);
    lines.push('');
    lines.push('Performance Summary:');
    lines.push(`• Sessions held: ${performance?.heldSessions ?? 0}/${performance?.expectedSessions ?? 0}`);
    lines.push(`• Active class days: ${performance?.classDays ?? 0}/${performance?.expectedDays ?? 0}`);
    lines.push(`• Attendance rate: ${performance?.attendanceRate ?? 0}%`);
    lines.push(`• Performance meter: ${performance?.meterValue ?? 0}/100`);
    lines.push(`• Target plan: ${session.sessions_per_week || 3} sessions per week, minimum ${session.min_days_per_week || 2} days per week, ${session.expected_duration_minutes || 45} minutes per session.`);
    if (session.rating) {
        lines.push(`• Trainee participation rating: ${session.rating}/5`);
    }

    lines.push('');
    lines.push('Weekly Activity:');
    const classRows = Array.isArray(performance?.classes) ? performance.classes : [];
    if (!classRows.length) {
        lines.push('No class activity was recorded for this week.');
    } else {
        const sorted = [...classRows].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.time || '').localeCompare(String(b.time || '')));
        for (const c of sorted) {
            const date = c.date ? String(c.date) : '';
            const time = c.time ? String(c.time) : '';
            const topic = c.topic ? ` - ${String(c.topic)}` : '';
            const total = Number(c.attendance_total || 0);
            const attended = Number(c.attendance_attended || 0);
            const rate = total > 0 ? ((attended / total) * 100).toFixed(1) : '0.0';
            const fbCount = Number(c.feedback_count || 0);
            lines.push(`• ${date} ${time}${topic} | Attendance: ${attended}/${total} (${rate}%) | Feedback: ${fbCount}`);
        }
    }

    const feedback = Array.isArray(performance?.feedbackList) ? performance.feedbackList : [];
    if (feedback.length) {
        lines.push('');
        lines.push('Feedback Highlights:');
        feedback.slice(-5).forEach((fb, i) => {
            const clean = String(fb).replace(/\s+/g, ' ').trim();
            lines.push(`${i + 1}. ${clean.length > 140 ? `${clean.slice(0, 140)}...` : clean}`);
        });
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
        logoTag: REPORT_LOGOTAG,
        watermarkText: REPORT_LOGOTAG
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

const sendSpecialistGroupPicker = async (ctx, specialistId, title, callbackPrefix) => {
    const groupsSnapshot = await db.collection('classrooms')
        .where('specialist_id', '==', specialistId)
        .get();

    if (groupsSnapshot.empty) {
        await ctx.reply('You have no classroom groups linked yet. Use /claim in a group first.');
        return false;
    }

    if (groupsSnapshot.size === 1) {
        const only = groupsSnapshot.docs[0];
        return { groupId: only.id, groupName: only.data()?.group_name || only.id };
    }

    const buttons = [];
    for (const doc of groupsSnapshot.docs.slice(0, 12)) {
        const room = doc.data() || {};
        const label = room.group_name || doc.id;
        buttons.push([Markup.button.callback(label, `${callbackPrefix}_${doc.id}`)]);
    }
    await ctx.reply(title, Markup.inlineKeyboard(buttons));
    return false;
};

const runAttendanceReport = async (ctx, dateStr) => {
    if (ctx.chat.type !== 'private') return;
    if (!(await requireSpecialist(ctx))) return;

    const userId = ctx.from.id.toString();
    const specialistDoc = await db.collection('specialists').doc(userId).get();
    if (!specialistDoc.exists) {
        return ctx.reply('You are not a registered specialist.');
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

    return ctx.reply(response, { parse_mode: 'Markdown' });
};

const runWeeklyReport = async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!(await requireSpecialist(ctx))) return;

    const userId = ctx.from.id.toString();
    const specialistDoc = await db.collection('specialists').doc(userId).get();
    if (!specialistDoc.exists) {
        return ctx.reply('You are not a registered specialist.');
    }

    const today = new Date();
    if (today.getDay() !== 6) {
        return ctx.reply('Weekly reports are only available on Saturdays.');
    }

    const lastMonday = new Date(today);
    lastMonday.setDate(today.getDate() - today.getDay() - 6);
    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastMonday.getDate() + 6);

    const mondayStr = getLagosDateString(lastMonday);
    const sundayStr = getLagosDateString(lastSunday);

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

        const attendanceSnapshot = await db.collection('attendance')
            .where('class_id', '==', classDoc.id)
            .get();

        if (!attendanceSnapshot.empty) {
            totalHeld += 1;
            const attendedCount = attendanceSnapshot.docs.filter(d => d.data().attended).length;
            totalAttendance += attendedCount;
            totalPossibleAttendance += attendanceSnapshot.size;
        }

        const feedbackSnapshot = await db.collection('feedback')
            .where('class_id', '==', classDoc.id)
            .get();

        feedbackSnapshot.forEach(fb => {
            feedbackList.push(fb.data().feedback);
        });
    }

    const attendanceRate = totalPossibleAttendance > 0 ? ((totalAttendance / totalPossibleAttendance) * 100).toFixed(1) : 0;

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

    await ctx.reply(report, { parse_mode: 'Markdown' });
    const reportBuffer = Buffer.from(report.replace(/\*/g, '').replace(/`/g, ''), 'utf-8');
    return ctx.replyWithDocument({ source: reportBuffer, filename: `weekly_report_${mondayStr}_to_${sundayStr}.txt` });
};

const runCourseProgress = async (ctx, groupId) => {
    if (ctx.chat.type !== 'private') return;
    if (!(await requireSpecialist(ctx))) return;

    const roomDoc = await db.collection('classrooms').doc(groupId).get();
    if (!roomDoc.exists) {
        return ctx.reply('That group is not linked to a classroom yet.');
    }

    const room = roomDoc.data();
    const specialistId = ctx.from.id.toString();
    if (room.specialist_id !== specialistId) {
        return ctx.reply('You are not the linked specialist for that group.');
    }

    if (!room.course_start_date) {
        return ctx.reply(`No course program is defined for **${room.group_name}**.\nPlease set the first class date with /setprogram ${groupId} YYYY-MM-DD.`);
    }

    const startDate = parseDateString(room.course_start_date);
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
    response += isStarted
        ? `\n✅ The course has officially started.`
        : `\n⏳ The course has not started yet. First class is scheduled for ${room.course_start_date}.`;

    return ctx.reply(response, { parse_mode: 'Markdown' });
};

const startWeeklyQuestionnaire = async (ctx, specialistId, groupId) => {
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
    return ctx.reply(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([Markup.button.callback('Yes, start review', `review_start_${sessionId}`)])
    });
};

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

        ctx.reply(`✅ Welcome to the team, Specialist ${specialistName}!\n\nYou are now authorized. Please go to your cohort's Telegram group, add me as an Admin, and type /claim to link the classroom.`);
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
            group_type: ctx.chat.type,
            group_name: groupName,
            specialist_id: specialistId,
            specialist_name: specialistName,
            claimed_at: admin.firestore.FieldValue.serverTimestamp(),
            member_count: ctx.chat.members_count || 0
        };

        await db.collection('classrooms').doc(groupId).set(groupData);
        console.log(`[CLAIM] Specialist ${specialistId} claimed group ${groupId} (${groupName})`);

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
            `• /register <password> - Register as a Specialist.
` +
            `• /claim - Claim your Telegram classroom group.
` +
            `• /mygroups - List your classroom groups (pick instead of typing group_id).
` +
            `• /announce - Send an announcement to a group (or all groups if super admin).
` +
            `• /setclass <HH:MM> [topic] - Schedule today’s live session (auto-detects your group if you have one).
` +
            `• /setclass <group_id> <HH:MM> [topic] - Schedule today’s live session for a specific group (if you manage multiple groups).
` +
            `• /rescheduleclass <group_id> <old_time> <new_time> - Move a session to a new time.
` +
            `• /cancelclass <group_id> [time] - Cancel one or all today’s sessions.
` +
            `• /classlist - Show all upcoming live sessions for your classrooms.
` +
            `• /status - Show your classroom status and today’s schedule.
` +
            `• /roster - View trainee roster for your classrooms.
` +
            `• /recount <group_id> - Recalculate verification counters for one group.
` +
            `• /addadmin <group_id> <user_id> - Add a stored group admin.
` +
            `• /removeadmin <group_id> <user_id> - Remove a stored group admin.
` +
            `• /listadmins <group_id> - List stored group admins.
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
        return ctx.reply(helpText, { parse_mode: 'Markdown' });
    }).catch(() => {
        ctx.reply('Use /help again.');
    });
});

const getAccessibleClassrooms = async (userId) => {
    const uid = String(userId);
    const query = isSuperAdminId(uid)
        ? db.collection('classrooms')
        : db.collection('classrooms').where('specialist_id', '==', uid);
    const snap = await query.get();
    return snap.docs.map((d) => ({ id: String(d.id), ...(d.data() || {}) }));
};

bot.command('mygroups', async (ctx) => {
    try {
        if (ctx.chat.type !== 'private') {
            return ctx.reply('Please use /mygroups in a private chat with the bot.');
        }
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const rooms = await getAccessibleClassrooms(String(ctx.from.id));
        if (!rooms.length) return ctx.reply('No classroom groups found.');
        const buttons = rooms.slice(0, 20).map((r) => [Markup.button.callback(`${r.group_name || r.id}`, `groupmenu_${r.id}`)]);
        return ctx.reply('Select a group:', Markup.inlineKeyboard(buttons));
    } catch (error) {
        await reportError('mygroups command failed', error);
        return ctx.reply('Unable to load groups right now.');
    }
});

bot.action(/^groupmenu_(.+)$/, async (ctx) => {
    try {
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const groupId = String(ctx.match[1]);
        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            await ctx.reply('Group not found.');
            return;
        }
        const room = roomDoc.data() || {};
        if (!isSuperAdminId(String(ctx.from.id)) && String(room.specialist_id || '') !== String(ctx.from.id)) {
            await ctx.reply('You do not have access to this group.');
            return;
        }
        const title = room.group_name || groupId;
        const buttons = [
            [Markup.button.callback('Status', `gstatus_${groupId}`)],
            [Markup.button.callback('Roster', `roster_${groupId}`)],
            [Markup.button.callback('Announce', `announce_to_${groupId}`)],
            [Markup.button.callback('Recount', `recount_${groupId}`)],
            [Markup.button.callback('Admins', `gadmins_${groupId}`)]
        ];
        await ctx.reply(`Group: ${title}\nID: ${groupId}`, Markup.inlineKeyboard(buttons));
    } catch (error) {
        await reportError('groupmenu action failed', error);
        await ctx.reply('Unable to open group menu right now.');
    } finally {
        try { await ctx.answerCbQuery(); } catch {}
    }
});

bot.command('announce', async (ctx) => {
    try {
        if (ctx.chat.type !== 'private') {
            return ctx.reply('Please use /announce in a private chat with the bot.');
        }
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const uid = String(ctx.from.id);
        const rooms = await getAccessibleClassrooms(uid);
        const buttons = [];
        if (isSuperAdminId(uid)) {
            buttons.push([Markup.button.callback('All groups', 'announce_all')]);
        }
        for (const r of rooms.slice(0, 20)) {
            buttons.push([Markup.button.callback(`${r.group_name || r.id}`, `announce_to_${r.id}`)]);
        }
        if (!buttons.length) return ctx.reply('No classroom groups found.');
        return ctx.reply('Select where to send the announcement:', Markup.inlineKeyboard(buttons));
    } catch (error) {
        await reportError('announce command failed', error);
        return ctx.reply('Unable to start announcement right now.');
    }
});

const setAnnouncementDraft = async (userId, payload) => {
    await db.collection('announcement_drafts').doc(String(userId)).set({
        user_id: String(userId),
        ...payload,
        updated_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
};

const clearAnnouncementDraft = async (userId) => {
    await db.collection('announcement_drafts').doc(String(userId)).delete().catch(() => {});
};

bot.action('announce_all', async (ctx) => {
    try {
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const uid = String(ctx.from.id);
        if (!isSuperAdminId(uid)) {
            await ctx.reply('Only super admin can announce to all groups.');
            return;
        }
        await setAnnouncementDraft(uid, { target: { mode: 'all' }, stage: 'await_text', created_at: admin.firestore.FieldValue.serverTimestamp() });
        await ctx.reply('Send the announcement text now (your next message will be sent to all groups).');
    } catch (error) {
        await reportError('announce_all action failed', error);
        await ctx.reply('Unable to start announcement right now.');
    } finally {
        try { await ctx.answerCbQuery(); } catch {}
    }
});

bot.action(/^announce_to_(.+)$/, async (ctx) => {
    try {
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const uid = String(ctx.from.id);
        const groupId = String(ctx.match[1]);
        const accessOk = await requireClassroomOwnerOrSuperAdmin(ctx, groupId);
        if (!accessOk) return;
        await setAnnouncementDraft(uid, { target: { mode: 'group', group_ids: [groupId] }, stage: 'await_text', created_at: admin.firestore.FieldValue.serverTimestamp() });
        await ctx.reply('Send the announcement text now (your next message will be posted to the selected group).');
    } catch (error) {
        await reportError('announce_to action failed', error);
        await ctx.reply('Unable to start announcement right now.');
    } finally {
        try { await ctx.answerCbQuery(); } catch {}
    }
});

bot.command('status', async (ctx) => {
    try {
        if (ctx.chat.type === 'private') {
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

            let response = `*Your schedule for today (${todayStr})*\n`;
            if (classesSnapshot.empty) {
                response += '\nNo live sessions are scheduled today.';
            } else {
                for (const classDoc of classesSnapshot.docs) {
                    const classData = classDoc.data();
                    response += `\nâ€¢ ${classData.group_name} at *${classData.time}*`;
                }
            }

            const groupsSnapshot = await db.collection('classrooms')
                .where('specialist_id', '==', specialistId)
                .get();
            const groupIds = groupsSnapshot.docs.map(d => String(d.id)).filter(Boolean);
            let pendingCount = 0;
            for (const gid of groupIds) {
                const settingsDoc = await db.collection('group_settings').doc(gid).get();
                const settings = settingsDoc.exists ? settingsDoc.data() : null;
                const stored = settings && settings.counters_initialized === true && Number.isFinite(Number(settings.pending_count)) ? Number(settings.pending_count) : null;
                if (stored != null) {
                    pendingCount += stored;
                } else {
                    const pendingSnapshot = await db.collection('group_verifications')
                        .where('group_id', '==', gid)
                        .where('verified', '==', false)
                        .where('timed_out', '==', false)
                        .where('removed', '==', false)
                        .get();
                    pendingCount += pendingSnapshot.size;
                }
            }
            response += `\n\nPending verifications in your groups: *${pendingCount}*`;
            return ctx.reply(response, { parse_mode: 'Markdown' });
        }

        const groupId = ctx.chat.id.toString();
        if (!(await requireGroupManager(ctx, groupId))) return;
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

        const settingsDoc = await db.collection('group_settings').doc(groupId).get();
        const settings = settingsDoc.exists ? settingsDoc.data() : null;
        const stored = settings && settings.counters_initialized === true && Number.isFinite(Number(settings.pending_count)) ? Number(settings.pending_count) : null;
        if (stored != null) {
            response += `\n\nPending verifications: *${stored}*`;
        } else {
            const pendingSnapshot = await db.collection('group_verifications')
                .where('group_id', '==', groupId)
                .where('verified', '==', false)
                .where('timed_out', '==', false)
                .where('removed', '==', false)
                .get();
            response += `\n\nPending verifications: *${pendingSnapshot.size}*`;
        }
        ctx.reply(response, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('Status command failed', error);
        ctx.reply('âŒ Unable to fetch status right now. Please try again later.');
    }
});

bot.action(/^gstatus_(.+)$/, async (ctx) => {
    try {
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const groupId = String(ctx.match[1]);
        const accessOk = await requireClassroomOwnerOrSuperAdmin(ctx, groupId);
        if (!accessOk) return;

        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            await ctx.reply('Group not found.');
            return;
        }
        const room = roomDoc.data() || {};

        const todayStr = getLagosDateString();
        const classesSnapshot = await db.collection('classes')
            .where('group_id', '==', groupId)
            .where('date', '==', todayStr)
            .where('status', '==', 'active')
            .get();

        let response = `*${room.group_name || groupId}* status for today (${todayStr}):\n`;
        if (classesSnapshot.empty) {
            response += '\nNo live sessions are scheduled today.';
        } else {
            for (const classDoc of classesSnapshot.docs) {
                const classData = classDoc.data();
                response += `\n• Live class at *${classData.time}*`;
            }
        }

        const settingsDoc = await db.collection('group_settings').doc(groupId).get();
        const settings = settingsDoc.exists ? settingsDoc.data() : null;
        const stored = settings && settings.counters_initialized === true && Number.isFinite(Number(settings.pending_count)) ? Number(settings.pending_count) : null;
        if (stored != null) {
            response += `\n\nPending verifications: *${stored}*`;
        } else {
            const pendingSnapshot = await db.collection('group_verifications')
                .where('group_id', '==', groupId)
                .where('verified', '==', false)
                .where('timed_out', '==', false)
                .where('removed', '==', false)
                .get();
            response += `\n\nPending verifications: *${pendingSnapshot.size}*`;
        }
        await ctx.reply(response, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('gstatus action failed', error);
        await ctx.reply('Unable to fetch status right now.');
    } finally {
        try { await ctx.answerCbQuery(); } catch {}
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
    const args = ctx.message.text.split(' ').slice(1);
    let dateStr = getLagosDateString();
    if (args.length > 0) {
        dateStr = args[0];
    }
    return await runAttendanceReport(ctx, dateStr);
});

// Weekly Report for Specialists (Available on Saturdays)
bot.command('weeklyreport', async (ctx) => {
    return await runWeeklyReport(ctx);
});

bot.command('setprogram', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!(await requireSpecialist(ctx))) return;

    const args = ctx.message.text.split(' ').slice(1);
    const specialistId = ctx.from.id.toString();
    let groupId;
    let startDateStr;

    if (args.length === 1) {
        startDateStr = args[0];
        const startDate = parseDateString(startDateStr);
        if (!startDate) {
            return ctx.reply('Usage: /setprogram <YYYY-MM-DD>\nExample: /setprogram 2026-05-05\n\nOr: /setprogram <group_id> <YYYY-MM-DD>');
        }

        const groupsSnapshot = await db.collection('classrooms')
            .where('specialist_id', '==', specialistId)
            .get();
        if (groupsSnapshot.empty) {
            return ctx.reply('You have no classroom groups linked yet. Use /claim in a group first.');
        }
        if (groupsSnapshot.size === 1) {
            groupId = groupsSnapshot.docs[0].id;
        } else {
            const buttons = groupsSnapshot.docs.map((doc) => {
                const room = doc.data() || {};
                return [Markup.button.callback(`${room.group_name || doc.id}`, `setprogram_pick_${doc.id}_${startDateStr}`)];
            });
            await ctx.reply('Select a group to set the program date:', Markup.inlineKeyboard(buttons));
            return;
        }
    } else if (args.length >= 2) {
        groupId = args[0];
        startDateStr = args[1];
    } else {
        return ctx.reply('Usage: /setprogram <YYYY-MM-DD>\nExample: /setprogram 2026-05-05\n\nOr: /setprogram <group_id> <YYYY-MM-DD>');
    }

    const startDate = parseDateString(startDateStr);
    if (!startDate) {
        return ctx.reply('Invalid date format. Use YYYY-MM-DD.');
    }

    const roomDoc = await db.collection('classrooms').doc(groupId).get();
    if (!roomDoc.exists) {
        return ctx.reply('That group is not linked to a classroom yet.');
    }

    const room = roomDoc.data();
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

bot.action(/^setprogram_pick_(.+)_([0-9]{4}-[0-9]{2}-[0-9]{2})$/, async (ctx) => {
    try {
        if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
        if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();

        const groupId = String(ctx.match[1]);
        const startDateStr = String(ctx.match[2]);
        const startDate = parseDateString(startDateStr);
        if (!startDate) {
            await ctx.reply('Invalid date format. Use YYYY-MM-DD.');
            return ctx.answerCbQuery();
        }

        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            await ctx.reply('That group is not linked to a classroom yet.');
            return ctx.answerCbQuery();
        }

        const room = roomDoc.data();
        const specialistId = ctx.from.id.toString();
        if (specialistId !== room.specialist_id) {
            await ctx.reply('Only the linked Specialist can set the course program.');
            return ctx.answerCbQuery();
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

        await ctx.reply(`✅ Course program saved for **${room.group_name}**.\nStart Date: ${dateToString(startDate)}\nEnd Date: ${dateToString(endDate)}\nExpected: ${sessionsPerWeek} sessions per week, ${expectedDurationMinutes} minutes each, for ${weeks} weeks.`, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('setprogram_pick failed', error);
        await ctx.reply('Unable to set program right now.');
    } finally {
        try { await ctx.answerCbQuery(); } catch {}
    }
});

bot.command('courseprogress', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!(await requireSpecialist(ctx))) return;

    const args = ctx.message.text.split(' ').slice(1);
    const specialistId = ctx.from.id.toString();
    if (args.length < 1) {
        const picked = await sendSpecialistGroupPicker(ctx, specialistId, 'Select a group to view course progress:', 'courseprogress_pick');
        if (picked) return await runCourseProgress(ctx, picked.groupId);
        return;
    }

    const groupId = args[0];
    return await runCourseProgress(ctx, groupId);
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

bot.action(/^review_start_(.+)$/, async (ctx) => {
    try {
        if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
        if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();

        const specialistId = ctx.from.id.toString();
        const sessionId = ctx.match[1];
        const sessionRef = db.collection('questionnaire_sessions').doc(sessionId);
        const sessionDoc = await sessionRef.get();
        if (!sessionDoc.exists) {
            await ctx.reply('I could not find that review session. Please start again with /questionnaire.');
            return ctx.answerCbQuery();
        }

        const session = sessionDoc.data();
        if (String(session.user_id || session.specialist_id || '') !== specialistId) {
            await ctx.reply('This review session does not belong to you.');
            return ctx.answerCbQuery();
        }

        if (session.status === 'completed') {
            await ctx.reply('This weekly review is already completed.');
            return ctx.answerCbQuery();
        }

        await sessionRef.set({
            status: 'in_progress',
            current_step: session.current_step ?? 0,
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        await db.collection('questionnaire_active').doc(specialistId).set({
            user_id: specialistId,
            session_id: String(sessionId),
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        await ctx.reply(`Question 1 of ${REVIEW_QUESTIONS.length}: ${REVIEW_QUESTIONS[0]}`);
        return ctx.answerCbQuery();
    } catch (error) {
        await reportError('review_start failed', error);
        try {
            await ctx.reply('❌ Unable to start the review right now. Please try again.');
        } catch {}
        return ctx.answerCbQuery();
    }
});

bot.action('report_weekly', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    try {
        await runWeeklyReport(ctx);
    } catch (error) {
        await reportError('report_weekly action failed', error);
        try {
            await ctx.reply('❌ Unable to generate weekly report right now. Please try /weeklyreport.');
        } catch {}
    }
    ctx.answerCbQuery();
});

bot.action('report_attendance', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    try {
        const dateStr = getLagosDateString();
        await runAttendanceReport(ctx, dateStr);
    } catch (error) {
        await reportError('report_attendance action failed', error);
        try {
            await ctx.reply('❌ Unable to generate attendance report right now. Please try /report.');
        } catch {}
    }
    ctx.answerCbQuery();
});

bot.action('report_progress', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    try {
        const specialistId = ctx.from.id.toString();
        const picked = await sendSpecialistGroupPicker(ctx, specialistId, 'Select a group to view course progress:', 'courseprogress_pick');
        if (picked) {
            await runCourseProgress(ctx, picked.groupId);
        }
    } catch (error) {
        await reportError('report_progress action failed', error);
        try {
            await ctx.reply('❌ Unable to fetch course progress right now. Please try /courseprogress <group_id>.');
        } catch {}
    }
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

bot.action(/^daily_live_(yes|no)_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const answer = ctx.match[1];
    const dateStr = ctx.match[2];
    const specialistId = ctx.from.id.toString();
    const specialistDoc = await db.collection('specialists').doc(specialistId).get();
    if (!specialistDoc.exists) return ctx.answerCbQuery();

    await db.collection('daily_live_session_confirmations').doc(`${specialistId}_${dateStr}`).set({
        specialist_id: specialistId,
        date: dateStr,
        answer,
        answered_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (answer === 'no') {
        await ctx.reply('Noted. No class scheduled for today.');
        return ctx.answerCbQuery();
    }

    const groupsSnapshot = await db.collection('classrooms')
        .where('specialist_id', '==', specialistId)
        .get();

    if (groupsSnapshot.empty) {
        await ctx.reply('You have no claimed groups. Please /claim a group first.');
        return ctx.answerCbQuery();
    }

    if (groupsSnapshot.size === 1) {
        const groupId = groupsSnapshot.docs[0].id;
        await beginScheduleSession(ctx, groupId, dateStr);
        return ctx.answerCbQuery();
    }

    const buttons = groupsSnapshot.docs.map((doc) => {
        const room = doc.data() || {};
        return [Markup.button.callback(`📅 ${room.group_name || doc.id}`, `daily_prompt_yes_${doc.id}_${dateStr}`)];
    });
    await ctx.reply('Select a group to schedule a class:', Markup.inlineKeyboard(buttons));
    return ctx.answerCbQuery();
});

bot.on('message', async (ctx, next) => {
    try {
        const chatType = ctx.chat?.type;
        if (chatType && (chatType === 'group' || chatType === 'supergroup')) {
            const groupId = ctx.chat.id.toString();
            const userId = ctx.from?.id ? String(ctx.from.id) : null;
            if (userId && ctx.from && shouldTrackUser(ctx.from)) {
                const bypassAdmins = await getBypassAdminIdSet(groupId);
                const isBypassed = bypassAdmins.has(userId);

                if (!isBypassed) {
                    const verification = await getGroupVerification(groupId, userId);
                    const isVerified = verification?.verified === true && !verification?.removed;
                    if (!isVerified) {
                        const entities = ctx.message?.entities || [];
                        const isCommand = entities.some((e) => e.type === 'bot_command' && e.offset === 0);
                        if (!isCommand) {
                            const label = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ? String(ctx.from.first_name) : userId);
                            try {
                                await ctx.telegram.deleteMessage(groupId, ctx.message.message_id);
                            } catch {}
                            const verifyLink = getVerifyLink(groupId);
                            await ctx.telegram.sendMessage(
                                groupId,
                                `👋 ${buildUserMentionHtml(userId, label)}, you need to verify your account before messaging in this group.\n\nTap below to verify:`,
                                {
                                    parse_mode: 'HTML',
                                    ...Markup.inlineKeyboard([[Markup.button.url('Verify Now ✅', verifyLink)]])
                                }
                            ).catch(() => {});
                            return;
                        }
                    }
                }

                const replyToMessageId = ctx.message?.reply_to_message?.message_id ? String(ctx.message.reply_to_message.message_id) : null;
                if (replyToMessageId) {
                    const fbDocId = `${groupId}_${userId}`;
                    const fbPendingDoc = await db.collection('feedback_pending').doc(fbDocId).get();
                    if (fbPendingDoc.exists) {
                        const pending = fbPendingDoc.data() || {};
                        if (String(pending.prompt_message_id || '') === replyToMessageId) {
                            const roomDoc = await db.collection('classrooms').doc(groupId).get();
                            const groupName = roomDoc.exists ? String(roomDoc.data()?.group_name || ctx.chat?.title || groupId) : String(ctx.chat?.title || groupId);
                            const text = String(ctx.message?.text || ctx.message?.caption || '').trim();
                            await db.collection('general_feedback').add({
                                group_id: groupId,
                                group_name: groupName,
                                user_id: userId,
                                feedback: text,
                                source: 'group',
                                created_at: admin.firestore.FieldValue.serverTimestamp()
                            });
                            const label = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ? String(ctx.from.first_name) : userId);
                            await logFeedback({ group_id: groupId, group_name: groupName, user_id: userId, user_label: label, text });
                            await db.collection('feedback_pending').doc(fbDocId).delete().catch(() => {});
                            await ctx.telegram.deleteMessage(groupId, ctx.message.message_id).catch(() => {});
                            await ctx.telegram.deleteMessage(groupId, Number(replyToMessageId)).catch(() => {});
                            await ctx.telegram.sendMessage(groupId, `✅ ${buildUserMentionHtml(userId, label)} feedback received. Thank you.`, { parse_mode: 'HTML' }).catch(() => {});
                            return;
                        }
                    }
                }

                if (!isBypassed) {
                    const entities = ctx.message?.entities || [];
                    const isCommand = entities.some((e) => e.type === 'bot_command' && e.offset === 0);
                    const text = String(ctx.message?.text || ctx.message?.caption || '').trim();
                    if (!isCommand && text) {
                        const disallowedLinks = await textHasDisallowedLinks(groupId, text);
                        const badWords = textHasBadWords(text);
                        let reason = null;
                        if (badWords) {
                            reason = 'profanity/insult';
                        } else if (textLooksLikeAdvert(text) && extractUrls(text).length) {
                            reason = 'advert/spam';
                        } else if (disallowedLinks.blocked) {
                            reason = 'disallowed link';
                        } else if (OPENAI_API_KEY) {
                            const m = await openaiModerateText(text);
                            if (m.ok && m.flagged) reason = 'abuse/harassment';
                        }

                        if (reason) {
                            try {
                                await ctx.telegram.deleteMessage(groupId, ctx.message.message_id);
                            } catch {}

                            const state = await loadModerationState(groupId, userId);
                            const strikes = Number(state?.strikes || 0);
                            const kicks = Number(state?.kicks || 0);
                            const bans = Number(state?.bans || 0);
                            const label = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ? String(ctx.from.first_name) : userId);
                            const groupName = String(ctx.chat?.title || groupId);

                            let action = 'warn';
                            if (bans > 0) {
                                action = 'ban';
                            } else if (kicks >= 1) {
                                action = 'ban';
                            } else if (strikes === 0) {
                                action = 'warn';
                            } else if (strikes === 1) {
                                action = 'timeout';
                            } else {
                                action = 'kick';
                            }

                            const nowSec = Math.floor(Date.now() / 1000);
                            if (action === 'warn') {
                                await ctx.telegram.sendMessage(groupId, `⚠️ ${buildUserMentionHtml(userId, label)} warning: please stop abusive language / adverts. Next offense = timeout.`, { parse_mode: 'HTML' }).catch(() => {});
                                await updateModerationState(groupId, userId, {
                                    strikes: strikes + 1,
                                    last_reason: reason,
                                    last_action: 'warn',
                                    last_message: text
                                });
                            } else if (action === 'timeout') {
                                const until = nowSec + 60 * 60;
                                await ctx.telegram.restrictChatMember(groupId, userId, { permissions: { can_send_messages: false }, until_date: until }).catch(() => {});
                                await ctx.telegram.sendMessage(groupId, `⏳ ${buildUserMentionHtml(userId, label)} has been timed out for 1 hour. Next offense = kick.`, { parse_mode: 'HTML' }).catch(() => {});
                                await updateModerationState(groupId, userId, {
                                    strikes: strikes + 1,
                                    timeouts: Number(state?.timeouts || 0) + 1,
                                    last_reason: reason,
                                    last_action: 'timeout',
                                    last_message: text
                                });
                            } else if (action === 'kick') {
                                await ctx.telegram.kickChatMember(groupId, userId).catch(() => {});
                                await ctx.telegram.unbanChatMember(groupId, userId).catch(() => {});
                                await ctx.telegram.sendMessage(groupId, `🚫 ${buildUserMentionHtml(userId, label)} has been kicked. Next offense = ban.`, { parse_mode: 'HTML' }).catch(() => {});
                                await updateModerationState(groupId, userId, {
                                    strikes: strikes + 1,
                                    kicks: Number(state?.kicks || 0) + 1,
                                    last_reason: reason,
                                    last_action: 'kick',
                                    last_message: text
                                });
                            } else {
                                await ctx.telegram.kickChatMember(groupId, userId).catch(() => {});
                                await ctx.telegram.sendMessage(groupId, `⛔️ ${buildUserMentionHtml(userId, label)} has been banned for repeated violations.`, { parse_mode: 'HTML' }).catch(() => {});
                                await updateModerationState(groupId, userId, {
                                    strikes: strikes + 1,
                                    bans: Number(state?.bans || 0) + 1,
                                    last_reason: reason,
                                    last_action: 'ban',
                                    last_message: text
                                });
                            }

                            await logModeration({
                                group_id: groupId,
                                group_name: groupName,
                                user_id: userId,
                                user_label: label,
                                action,
                                reason,
                                text
                            });
                            return;
                        }
                    }
                }
            }

            const entities = ctx.message?.entities || [];
            const isCommand = entities.some((e) => e.type === 'bot_command' && e.offset === 0);
            if (isCommand) {
                const userId = ctx.from?.id ? ctx.from.id.toString() : null;
                if (userId && !ctx.from.is_bot) {
                    const specialistDoc = await db.collection('specialists').doc(userId).get();
                    if (!specialistDoc.exists) {
                        const existing = await getGroupVerification(groupId, userId);
                        if (!existing) {
                            await setGroupVerification(groupId, userId, {
                                group_id: groupId,
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
                    }
                }
            }

            const replyToMessageId = ctx.message?.reply_to_message?.message_id ? String(ctx.message.reply_to_message.message_id) : null;
            let handledAnnouncementReply = false;
            if (replyToMessageId && ctx.from && shouldTrackUser(ctx.from)) {
                const mapDocId = `${groupId}_${replyToMessageId}`;
                const mapDoc = await db.collection('announcement_messages').doc(mapDocId).get();
                if (mapDoc.exists) {
                    handledAnnouncementReply = true;
                    const map = mapDoc.data() || {};
                    const announcerId = String(map.announcer_id || '');
                    const announcementId = String(map.announcement_id || '');
                    if (announcerId && announcementId) {
                        const groupName = String(map.group_name || ctx.chat.title || groupId);
                        const traineeId = String(ctx.from.id);
                        const threadId = `${announcementId}_${groupId}_${traineeId}`;
                        const fromLabel = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name ? String(ctx.from.first_name) : traineeId);
                        const when = ctx.message?.date ? new Date(ctx.message.date * 1000) : new Date();
                        const text = ctx.message?.text || ctx.message?.caption || '';

                        await db.collection('announcement_threads').doc(threadId).set({
                            thread_id: threadId,
                            announcement_id: announcementId,
                            group_id: groupId,
                            group_name: groupName,
                            announcer_id: announcerId,
                            trainee_id: traineeId,
                            created_at: admin.firestore.FieldValue.serverTimestamp(),
                            last_message_at: admin.firestore.FieldValue.serverTimestamp()
                        }, { merge: true });

                        const header = `💬 <b>Announcement reply</b>\nGroup: <b>${escapeHtml(groupName)}</b>\nFrom: ${buildUserMentionHtml(traineeId, fromLabel)}\nAt: <b>${escapeHtml(when.toISOString())}</b>\n\n`;
                        const body = escapeHtml(text || '[non-text message]');
                        await bot.telegram.sendMessage(announcerId, `${header}${body}`, {
                            parse_mode: 'HTML',
                            ...Markup.inlineKeyboard([[Markup.button.callback('Reply', `thread_reply_${threadId}`)]])
                        });
                    }
                }
            }
            if (!handledAnnouncementReply && OPENAI_API_KEY) {
                const text = String(ctx.message?.text || '').trim();
                if (text) {
                    const botMention = `@${BOT_USERNAME_SAFE}`;
                    const hasMention = text.includes(botMention);
                    const replyTo = ctx.message?.reply_to_message;
                    const replyToBot = replyTo?.from?.username ? String(replyTo.from.username).replace(/^@/, '') === BOT_USERNAME_SAFE : false;
                    if (hasMention || replyToBot) {
                        if (!shouldReplyWithAiNow(`group:${groupId}`, 12_000)) return;
                        const cleaned = text.replaceAll(botMention, '').trim();
                        const userLabel = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ? String(ctx.from.first_name) : String(ctx.from.id));
                        const groupName = String(ctx.chat?.title || groupId);
                        const prompt = `Group: ${groupName}\nUser: ${userLabel}\nMessage: ${cleaned || text}`;
                        const r = await openaiChatReply([
                            { role: 'system', content: `You are ${REPORT_LOGOTAG}, the official Skillforge assistant inside Telegram. Be brief, helpful, and professional. If the user is asking for support, give actionable steps. Do not mention internal policies or secrets.` },
                            { role: 'user', content: prompt }
                        ], { max_tokens: 200, temperature: 0.4 });
                        if (r.ok && r.content) {
                            await ctx.reply(r.content).catch(() => {});
                            return;
                        }
                    }
                }
            }
        }
    } catch {}

    const wad = ctx.message?.web_app_data;
    if (!wad?.data) return next();
    try {
        const payload = JSON.parse(wad.data);
        const action = String(payload?.action || '').trim();
        if (!action) return;
        return await ctx.telegram.sendMessage(ctx.from.id, `/start ${action}`);
    } catch (error) {
        await reportError('web_app_data parse failed', error);
        return;
    }
});

const setAnnouncementReplySession = async (userId, payload) => {
    await db.collection('announcement_reply_sessions').doc(String(userId)).set({
        user_id: String(userId),
        ...payload,
        updated_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
};

const clearAnnouncementReplySession = async (userId) => {
    await db.collection('announcement_reply_sessions').doc(String(userId)).delete().catch(() => {});
};

bot.action(/^thread_reply_(.+)$/, async (ctx) => {
    try {
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const uid = String(ctx.from.id);
        const threadId = String(ctx.match[1]);
        const threadDoc = await db.collection('announcement_threads').doc(threadId).get();
        if (!threadDoc.exists) {
            await ctx.reply('Thread not found.');
            return;
        }
        const thread = threadDoc.data() || {};
        if (!isSuperAdminId(uid) && String(thread.announcer_id || '') !== uid) {
            await ctx.reply('You do not have access to this thread.');
            return;
        }
        await setAnnouncementReplySession(uid, { stage: 'await_text', role: 'announcer', thread_id: threadId });
        await ctx.reply('Send your reply message now (your next message will be delivered).');
    } catch (error) {
        await reportError('thread_reply action failed', error);
        await ctx.reply('Unable to start reply right now.');
    } finally {
        try { await ctx.answerCbQuery(); } catch {}
    }
});

bot.action(/^thread_user_(.+)$/, async (ctx) => {
    try {
        const uid = String(ctx.from.id);
        const threadId = String(ctx.match[1]);
        const threadDoc = await db.collection('announcement_threads').doc(threadId).get();
        if (!threadDoc.exists) {
            await ctx.reply('Thread not found.');
            return;
        }
        const thread = threadDoc.data() || {};
        if (String(thread.trainee_id || '') !== uid) {
            await ctx.reply('You do not have access to this thread.');
            return;
        }
        await setAnnouncementReplySession(uid, { stage: 'await_text', role: 'trainee', thread_id: threadId });
        await ctx.reply('Send your reply message now (your next message will be delivered).');
    } catch (error) {
        await reportError('thread_user action failed', error);
        await ctx.reply('Unable to start reply right now.');
    } finally {
        try { await ctx.answerCbQuery(); } catch {}
    }
});

// Handle feedback messages in private chat and active review sessions
bot.on('text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();

    const userId = ctx.from.id.toString();
    const messageText = ctx.message.text;

    if (!messageText || messageText.startsWith('/')) {
        return next();
    }

    try {
        const fbSessDoc = await db.collection('feedback_sessions').doc(userId).get();
        if (fbSessDoc.exists && String(fbSessDoc.data()?.status || '') === 'awaiting_feedback') {
            await db.collection('general_feedback').add({
                group_id: null,
                group_name: null,
                user_id: userId,
                feedback: String(messageText || '').trim(),
                source: 'dm',
                created_at: admin.firestore.FieldValue.serverTimestamp()
            });
            const label = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ? String(ctx.from.first_name) : userId);
            await logFeedback({ group_id: null, group_name: null, user_id: userId, user_label: label, text: messageText });
            await db.collection('feedback_sessions').doc(userId).delete().catch(() => {});
            await ctx.reply('✅ Feedback received. Thank you.');
            return;
        }

        const replySessionDoc = await db.collection('announcement_reply_sessions').doc(userId).get();
        if (replySessionDoc.exists) {
            const sess = replySessionDoc.data() || {};
            if (String(sess.stage || '') === 'await_text' && sess.thread_id) {
                const threadId = String(sess.thread_id);
                const threadDoc = await db.collection('announcement_threads').doc(threadId).get();
                if (!threadDoc.exists) {
                    await clearAnnouncementReplySession(userId);
                    await ctx.reply('Thread not found.');
                    return;
                }
                const thread = threadDoc.data() || {};
                const role = String(sess.role || '');
                const text = String(messageText || '').trim();
                if (!text) return;

                if (role === 'announcer') {
                    const toId = String(thread.trainee_id || '');
                    const groupName = String(thread.group_name || thread.group_id || '');
                    const fromName = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name ? String(ctx.from.first_name) : userId);
                    try {
                        await bot.telegram.sendMessage(toId, `📩 <b>Reply from ${escapeHtml(fromName)}</b>\nGroup: <b>${escapeHtml(groupName)}</b>\n\n${escapeHtml(text)}`, {
                            parse_mode: 'HTML',
                            ...Markup.inlineKeyboard([[Markup.button.callback('Reply', `thread_user_${threadId}`)]])
                        });
                        await ctx.reply('Delivered.');
                    } catch (error) {
                        await ctx.reply('Failed to deliver (user may not have started the bot or has blocked it).');
                    }
                    await db.collection('announcement_threads').doc(threadId).set({ last_message_at: admin.firestore.FieldValue.serverTimestamp(), last_sender: 'announcer' }, { merge: true });
                    await clearAnnouncementReplySession(userId);
                    return;
                }

                if (role === 'trainee') {
                    const toId = String(thread.announcer_id || '');
                    const groupName = String(thread.group_name || thread.group_id || '');
                    const fromLabel = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name ? String(ctx.from.first_name) : userId);
                    await bot.telegram.sendMessage(toId, `💬 <b>Reply</b>\nGroup: <b>${escapeHtml(groupName)}</b>\nFrom: ${buildUserMentionHtml(userId, fromLabel)}\n\n${escapeHtml(text)}`, {
                        parse_mode: 'HTML',
                        ...Markup.inlineKeyboard([[Markup.button.callback('Reply', `thread_reply_${threadId}`)]])
                    });
                    await db.collection('announcement_threads').doc(threadId).set({ last_message_at: admin.firestore.FieldValue.serverTimestamp(), last_sender: 'trainee' }, { merge: true });
                    await clearAnnouncementReplySession(userId);
                    await ctx.reply('Delivered.');
                    return;
                }
            }
        }
    } catch {}

    try {
        const draftDoc = await db.collection('announcement_drafts').doc(userId).get();
        if (draftDoc.exists) {
            const draft = draftDoc.data() || {};
            if (String(draft.stage || '') === 'await_text') {
                const target = draft.target || {};
                const uid = String(ctx.from.id);
                const announcerName = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name ? String(ctx.from.first_name) : uid);

                let rooms = [];
                if (String(target.mode || '') === 'all') {
                    if (!isSuperAdminId(uid)) {
                        await clearAnnouncementDraft(uid);
                        await ctx.reply('Only super admin can announce to all groups.');
                        return;
                    }
                    rooms = await getAccessibleClassrooms(uid);
                } else {
                    const ids = Array.isArray(target.group_ids) ? target.group_ids.map(String) : [];
                    const items = [];
                    for (const gid of ids) {
                        const accessOk = await requireClassroomOwnerOrSuperAdmin(ctx, gid);
                        if (!accessOk) continue;
                        const roomDoc = await db.collection('classrooms').doc(String(gid)).get();
                        if (roomDoc.exists) items.push({ id: String(roomDoc.id), ...(roomDoc.data() || {}) });
                    }
                    rooms = items;
                }

                if (!rooms.length) {
                    await clearAnnouncementDraft(uid);
                    await ctx.reply('No target groups found.');
                    return;
                }

                const annRef = await db.collection('announcements').add({
                    announcer_id: uid,
                    announcer_name: announcerName,
                    text: String(messageText),
                    target_count: rooms.length,
                    created_at: admin.firestore.FieldValue.serverTimestamp()
                });
                const announcementId = annRef.id;

                let sent = 0;
                for (const room of rooms) {
                    const groupId = String(room.group_id || room.id);
                    if (!groupId) continue;
                    const payload = `📢 <b>Announcement</b>\nFrom: <b>${escapeHtml(announcerName)}</b>\n\n${escapeHtml(String(messageText))}\n\nReply to this message to respond.`;
                    try {
                        const msg = await bot.telegram.sendMessage(groupId, payload, { parse_mode: 'HTML' });
                        await db.collection('announcement_messages').doc(`${groupId}_${String(msg.message_id)}`).set({
                            announcement_id: announcementId,
                            group_id: groupId,
                            group_name: String(room.group_name || groupId),
                            announcer_id: uid,
                            announcer_name: announcerName,
                            message_id: String(msg.message_id),
                            created_at: admin.firestore.FieldValue.serverTimestamp()
                        }, { merge: true });
                        sent += 1;
                    } catch (error) {}
                }

                await clearAnnouncementDraft(uid);
                await ctx.reply(`Announcement sent to ${sent} group(s).`);
                return;
            }
        }
    } catch {}

    let activeSessionId = null;
    try {
        const activeDoc = await db.collection('questionnaire_active').doc(userId).get();
        if (activeDoc.exists) {
            const sid = activeDoc.data()?.session_id;
            if (sid) activeSessionId = String(sid);
        }
    } catch {}

    let activeSessionDoc = null;
    if (activeSessionId) {
        const doc = await db.collection('questionnaire_sessions').doc(activeSessionId).get();
        if (doc.exists && doc.data()?.status === 'in_progress') {
            activeSessionDoc = doc;
        } else {
            await db.collection('questionnaire_active').doc(userId).delete().catch(() => {});
        }
    }

    if (!activeSessionDoc) {
        const activeSessionSnapshot = await db.collection('questionnaire_sessions')
            .where('user_id', '==', userId)
            .where('status', '==', 'in_progress')
            .limit(1)
            .get();
        if (!activeSessionSnapshot.empty) {
            activeSessionDoc = activeSessionSnapshot.docs[0];
            await db.collection('questionnaire_active').doc(userId).set({
                user_id: userId,
                session_id: String(activeSessionDoc.id),
                updated_at: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
    }

    if (activeSessionDoc) {
        try {
            const sessionId = activeSessionDoc.id;
            const session = activeSessionDoc.data();
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
            await db.collection('questionnaire_active').doc(userId).delete().catch(() => {});

            await ctx.reply('✅ Response received. Finalizing your weekly review now...');

            const completedSession = { id: sessionId, ...session, ...completedPayload };
            let pdfBuffer = null;
            try {
                pdfBuffer = await buildReviewPdf(completedSession);
            } catch (error) {
                await reportError('buildReviewPdf failed', error);
            }

            if (pdfBuffer) {
                await ctx.replyWithDocument({ source: pdfBuffer, filename: `weekly_review_${session.group_name}_${session.week_start}_to_${session.week_end}.pdf` });
                if (SERVER_URL) {
                    await ctx.reply(`Download: ${SERVER_URL}/review/${sessionId}\nPrint: ${SERVER_URL}/review/${sessionId}/print\n\nSubmit the PDF to your head of units.`);
                }
            } else {
                await ctx.reply('✅ Weekly review saved successfully. I could not generate the PDF right now. Please try /weeklyreport later.');
            }
            return;
        } catch (error) {
            await reportError('weekly review dm handler failed', error);
            await ctx.reply('✅ Response received. I ran into an error finishing your weekly review. Please try /weeklyreport later.');
            return;
        }
    }

    try {
        const scheduleSessionDoc = await db.collection('schedule_sessions').doc(userId).get();
        if (scheduleSessionDoc.exists) {
            const scheduleSession = scheduleSessionDoc.data() || {};
            const status = String(scheduleSession.status || '');
            if (status === 'awaiting_time' || status === 'awaiting_topic') {
                const expiresAt = scheduleSession.expires_at?.toDate ? scheduleSession.expires_at.toDate() : null;
                if (expiresAt && expiresAt.getTime() <= Date.now()) {
                    await db.collection('schedule_sessions').doc(userId).update({
                        status: 'expired',
                        expired_at: admin.firestore.FieldValue.serverTimestamp()
                    });
                    await ctx.reply('Your scheduling session has expired. Please tap Yes again to start scheduling.');
                    return;
                }

                const normalized = String(messageText || '').trim();
                const lowered = normalized.toLowerCase();
                if (lowered === 'cancel') {
                    await db.collection('schedule_sessions').doc(userId).set({
                        ...scheduleSession,
                        status: 'canceled',
                        canceled_at: admin.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                    await ctx.reply('✅ Scheduling canceled.');
                    return;
                }

                if (status === 'awaiting_time') {
                    const [timeInput, ...topicParts] = normalized.split(/\s+/);
                    if (!CLASS_TIME_REGEX.test(timeInput)) {
                        await ctx.reply('❌ Time must be HH:MM (24-hour). Example: 19:30');
                        return;
                    }

                    const topicInline = topicParts.join(' ') || null;
                    if (topicInline) {
                        await ctx.reply('✅ Received. Scheduling now...');
                        await scheduleLiveClass({
                            groupId: scheduleSession.group_id,
                            specialistId: userId,
                            timeInput,
                            topic: topicInline,
                            dateStr: scheduleSession.date || null,
                            telegram: ctx.telegram,
                            reply: (text, extra) => ctx.reply(text, extra)
                        });

                        await db.collection('schedule_sessions').doc(userId).set({
                            ...scheduleSession,
                            status: 'completed',
                            scheduled_time: timeInput,
                            topic: topicInline,
                            completed_at: admin.firestore.FieldValue.serverTimestamp()
                        }, { merge: true });
                        return;
                    }

                    await db.collection('schedule_sessions').doc(userId).set({
                        ...scheduleSession,
                        status: 'awaiting_topic',
                        scheduled_time: timeInput,
                        updated_at: admin.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });

                    await ctx.reply('✅ Time received. Now send the topic (or reply with "skip").');
                    return;
                }

                if (status === 'awaiting_topic') {
                    const timeInput = String(scheduleSession.scheduled_time || '').trim();
                    if (!CLASS_TIME_REGEX.test(timeInput)) {
                        await ctx.reply('❌ I lost the time for this scheduling session. Please tap Yes again to restart scheduling.');
                        return;
                    }

                    const topic = (lowered === 'skip' || lowered === 'none' || lowered === 'no' || lowered === '-') ? null : normalized;
                    await ctx.reply('✅ Topic received. Scheduling now...');

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
                        topic,
                        completed_at: admin.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                    return;
                }
            }
        }
    } catch (error) {
        await reportError('Schedule session handler failed', error);
        await ctx.reply('❌ I could not process your scheduling message right now. Please try again.');
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
        if (!verifiedGroupsSnapshot.empty) {
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
                const groupId = String(bestClass.data?.group_id || '');
                const groupName = String(bestClass.data?.group_name || groupId);
                const label = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ? String(ctx.from.first_name) : userId);
                await logFeedback({ group_id: groupId, group_name: groupName, user_id: userId, user_label: label, text: messageText });
                await ctx.reply('✅ Thank you for your feedback!');
                return;
            }
        }
    }

    if (OPENAI_API_KEY) {
        const canReply = shouldReplyWithAiNow(`dm:${userId}`, 3_000);
        if (canReply) {
            const label = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ? String(ctx.from.first_name) : userId);
            const r = await openaiChatReply([
                {
                    role: 'system',
                    content: 'You are the Skillforge Principal Bot — the official AI assistant for Skillforge Digital Academy. You help trainees and specialists with class schedules, verification, attendance, and general questions. Be helpful, brief, and warm. If you are unsure, tell the user to contact their specialist or head of units.'
                },
                { role: 'user', content: `User: ${label}\nMessage: ${String(messageText || '').trim()}` }
            ], { max_tokens: 300, temperature: 0.6 });
            if (r.ok && r.content) {
                await ctx.reply(r.content);
                return;
            }
            await ctx.reply("I'm here to help! Use /help to see what I can do, or type your question and I'll do my best.");
            return;
        }
    }

    await ctx.reply("I'm not sure how to help with that. Use /help to see available commands.");
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
    ctx.reply(
        'Choose a report type:',
        Markup.inlineKeyboard([
            [Markup.button.callback('📊 Weekly Stats Report', 'report_weekly')],
            [Markup.button.callback('📝 Weekly Review Questionnaire', 'start_report')]
        ])
    );
    ctx.answerCbQuery();
});

bot.action('start_report', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
    try {
        const specialistId = ctx.from.id.toString();
        const picked = await sendSpecialistGroupPicker(ctx, specialistId, 'Select a group to start the weekly review questionnaire:', 'questionnaire_pick');
        if (picked) {
            await startWeeklyQuestionnaire(ctx, specialistId, picked.groupId);
        }
    } catch (error) {
        await reportError('start_report action failed', error);
        try {
            await ctx.reply('❌ Unable to start weekly review right now. Please try /questionnaire.');
        } catch {}
    }
    ctx.answerCbQuery();
});

bot.action(/^courseprogress_pick_(.+)$/, async (ctx) => {
    const groupId = ctx.match[1];
    try {
        await runCourseProgress(ctx, groupId);
    } catch (error) {
        await reportError('courseprogress_pick failed', error);
        try {
            await ctx.reply('❌ Unable to fetch course progress right now.');
        } catch {}
    }
    ctx.answerCbQuery();
});

bot.action(/^questionnaire_pick_(.+)$/, async (ctx) => {
    const groupId = ctx.match[1];
    const specialistId = ctx.from.id.toString();
    try {
        await startWeeklyQuestionnaire(ctx, specialistId, groupId);
    } catch (error) {
        await reportError('questionnaire_pick failed', error);
        try {
            await ctx.reply('❌ Unable to start weekly review right now.');
        } catch {}
    }
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
                `📅 /setclass HH:MM [topic] - Schedule class\n` +
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
        `⏰ *Schedule Class for ${room.group_name}*\n\nSend the time in HH:MM format (24-hour).\n\nExample:\n14:30`,
        { parse_mode: 'Markdown' }
    );
    return true;
};

const beginScheduleTopicSession = async (ctx, groupId, dateStr, timeInput) => {
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

    if (!CLASS_TIME_REGEX.test(String(timeInput || '').trim())) {
        await ctx.reply('❌ Time must be HH:MM (24-hour). Example: 19:30');
        return false;
    }

    const effectiveDate = dateStr || getLagosDateString();
    const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + (2 * 60 * 60 * 1000)));
    await db.collection('schedule_sessions').doc(specialistId).set({
        specialist_id: specialistId,
        group_id: groupId,
        group_name: room.group_name,
        date: effectiveDate,
        status: 'awaiting_topic',
        scheduled_time: String(timeInput).trim(),
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        expires_at: expiresAt
    }, { merge: true });

    await ctx.reply(
        `✅ Time received: *${String(timeInput).trim()}*\n\nNow send the topic (or reply with "skip").`,
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
            const message = `Good morning Specialist ${room.specialist_name}! ☀️\n\nWill there be a live session for **${room.group_name}** today?`;
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
        throw new Error('❌ That group is not linked to a classroom. Have the Specialist claim the group first.');
    }

    const room = roomDoc.data();
    if (specialistId !== room.specialist_id) {
        throw new Error('❌ Only the linked Specialist can schedule this group.');
    }

    if (!room.course_start_date) {
        if (reply) {
            await reply(`⚠️ I recommend setting the first course date for this group with:\n/setprogram ${groupId} YYYY-MM-DD\nThis allows the performance meter and weekly tracking to work correctly.`);
        }
    }

    const todayStr = dateStr || getLagosDateString();
    const classId = getClassDocId(groupId, todayStr, timeInput);
    await db.collection('classes').doc(classId).set({
        date: todayStr,
        time: timeInput,
        topic: topic,
        reminder_30_sent: false,
        reminder_10_sent: false,
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
    const announcementText = `📢 **Live Session Scheduled**\n\nA live session for **${room.group_name}** is confirmed at **${timeInput}** on ${todayStr}.${topicText}\n\nI will pin this announcement and send personal reminders to the Specialist and verified trainees at 30, 15, 10, and 5 minutes before class.`;
    try {
        const sentMessage = await telegram.sendMessage(groupId, announcementText, { parse_mode: 'Markdown' });
        await telegram.pinChatMessage(groupId, sentMessage.message_id, { disable_notification: true });
    } catch (error) {
        await reportError('Could not announce or pin the class message', error);
    }

    if (reply) {
        await reply(`✅ Locked in! Class for **${room.group_name}** is set for ${timeInput} on ${todayStr}. I have announced it and will send reminders. 🚀`, { parse_mode: 'Markdown' });
    }

    const verifiedTrainees = await getVerifiedTraineeIds(groupId);
    const reminderText = `✅ Live session for **${room.group_name}** is scheduled at **${timeInput}** on ${todayStr}.${topic ? ` Topic: ${topic}` : ''} I will remind you 30, 15, 10, and 5 minutes before the class.`;
    await sendDmUsers(normalizeUserIds([room.specialist_id, ...verifiedTrainees]), reminderText, { parse_mode: 'Markdown' });

    return { room, todayStr, classId };
};

const sendCancelClassPicker = async (ctx, groupId) => {
    const specialistId = ctx.from.id.toString();
    const roomDoc = await db.collection('classrooms').doc(String(groupId)).get();
    if (!roomDoc.exists) {
        await ctx.reply('That group is not linked to a classroom.');
        return false;
    }
    const room = roomDoc.data() || {};
    if (String(room.specialist_id || '') !== String(specialistId)) {
        await ctx.reply('Only the linked Specialist can cancel classes for this group.');
        return false;
    }

    const todayStr = getLagosDateString();
    const snapshot = await db.collection('classes')
        .where('group_id', '==', String(groupId))
        .where('date', '==', todayStr)
        .where('status', '==', 'active')
        .get();

    if (snapshot.empty) {
        await ctx.reply(`No active classes found for **${room.group_name || groupId}** today.`, { parse_mode: 'Markdown' });
        return true;
    }

    const items = snapshot.docs.map((d) => d.data()).filter(Boolean).sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
    const buttons = items.slice(0, 12).map((c) => {
        const label = `${String(c.time || '').trim()}${c.topic ? ` — ${String(c.topic).trim().slice(0, 24)}` : ''}`;
        return [Markup.button.callback(`Cancel ${label}`, `cancelclass_pick_${groupId}_${String(c.time || '').trim()}`)];
    });
    buttons.push([Markup.button.callback('Cancel all today', `cancelclass_pick_${groupId}_all`)]);

    await ctx.reply(`Select which class to cancel for **${room.group_name || groupId}**:`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
    });
    return true;
};

bot.command('setclass', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return;
    try {
        if (ctx.chat.type !== 'private') {
            return ctx.reply('Please use /setclass in a private chat with the bot.');
        }

        const specialistId = ctx.from.id.toString();
        const args = ctx.message.text.split(' ').slice(1);

        let groupId;
        let timeInput;
        let topic;

        if (args.length === 0) {
            const groupsSnapshot = await db.collection('classrooms')
                .where('specialist_id', '==', specialistId)
                .get();

            if (groupsSnapshot.empty) {
                return ctx.reply('❌ You have no claimed groups. Use /claim in a group first.');
            }

            if (groupsSnapshot.size === 1) {
                groupId = groupsSnapshot.docs[0].id;
                await beginScheduleSession(ctx, groupId);
                return;
            }

            await sendScheduleGroupPicker(ctx, specialistId);
            return;
        }

        if (args.length >= 1 && CLASS_TIME_REGEX.test(args[0])) {
            timeInput = args[0];
            topic = args.slice(1).join(' ') || null;

            const groupsSnapshot = await db.collection('classrooms')
                .where('specialist_id', '==', specialistId)
                .get();

            if (groupsSnapshot.empty) {
                return ctx.reply('❌ You have no claimed groups. Use /claim in a group first.');
            }

            if (groupsSnapshot.size === 1) {
                groupId = groupsSnapshot.docs[0].id;
            } else {
                await sendScheduleGroupPicker(ctx, specialistId);
                return;
            }
        } else if (args.length >= 2) {
            groupId = args[0];
            timeInput = args[1];
            topic = args.slice(2).join(' ') || null;
        } else {
            return ctx.reply(
                '❌ Format: /setclass <HH:MM> [topic]\nExample: /setclass 19:30 Introduction to Synthetics\n\nOr with group: /setclass -100123456 19:30 Introduction to Synthetics'
            );
        }

        if (!CLASS_TIME_REGEX.test(timeInput)) {
            return ctx.reply('❌ Time must be HH:MM (24-hour). Example: 19:30');
        }

        if (!topic) {
            await beginScheduleTopicSession(ctx, groupId, null, timeInput);
            return;
        }

        await ctx.reply('✅ Received. Scheduling now...');
        await scheduleLiveClass({
            groupId,
            specialistId,
            timeInput,
            topic,
            telegram: ctx.telegram,
            reply: (text, extra) => ctx.reply(text, extra)
        });
    } catch (error) {
        const msg = String(error?.message || '');
        if (msg.startsWith('❌') || msg.startsWith('âŒ')) return ctx.reply(msg);
        await reportError('setclass command failed', error);
        return ctx.reply('❌ Failed to schedule the class. Please try again.');
    }
});

bot.command('cancelclass', async (ctx) => {
    if (!(await requireSpecialist(ctx))) return;
    try {
        if (ctx.chat.type !== 'private') {
            return ctx.reply('Please use /cancelclass in a private chat with the bot.');
        }

        const specialistId = ctx.from.id.toString();
        const args = ctx.message.text.split(' ').slice(1);
        let groupId;
        let timeInput;

        if (args.length >= 1 && CLASS_TIME_REGEX.test(args[0])) {
            timeInput = args[0];
            const groupsSnapshot = await db.collection('classrooms')
                .where('specialist_id', '==', specialistId)
                .get();
            if (groupsSnapshot.empty) {
                return ctx.reply('You have no classroom groups linked yet. Use /claim in a group first.');
            }
            if (groupsSnapshot.size === 1) {
                groupId = groupsSnapshot.docs[0].id;
            } else {
                const token = timeInput || 'all';
                const buttons = groupsSnapshot.docs.map((doc) => {
                    const room = doc.data() || {};
                    return [Markup.button.callback(`${room.group_name || doc.id}`, `cancelclass_pick_${doc.id}_${token}`)];
                });
                await ctx.reply('Select a group to cancel today’s class:', Markup.inlineKeyboard(buttons));
                return;
            }
        } else if (args.length >= 1) {
            groupId = args[0];
            timeInput = args[1] || null;
        } else {
            const groupsSnapshot = await db.collection('classrooms')
                .where('specialist_id', '==', specialistId)
                .get();
            if (groupsSnapshot.empty) {
                return ctx.reply('You have no classroom groups linked yet. Use /claim in a group first.');
            }
            if (groupsSnapshot.size === 1) {
                groupId = groupsSnapshot.docs[0].id;
            } else {
                const buttons = groupsSnapshot.docs.map((doc) => {
                    const room = doc.data() || {};
                    return [Markup.button.callback(`${room.group_name || doc.id}`, `cancelclass_group_${doc.id}`)];
                });
                await ctx.reply('Select a group to cancel today’s class:', Markup.inlineKeyboard(buttons));
                return;
            }
        }

        if (!groupId) return;

        if (!timeInput) {
            await sendCancelClassPicker(ctx, groupId);
            return;
        }

        if (!CLASS_TIME_REGEX.test(timeInput)) {
            return ctx.reply('❌ Time must be HH:MM (24-hour). Example: 19:30');
        }

        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            return ctx.reply('That group is not linked to a classroom.');
        }
        const room = roomDoc.data() || {};
        if (String(room.specialist_id || '') !== String(specialistId)) {
            return ctx.reply('Only the linked Specialist can cancel the class.');
        }

        await ctx.reply(`Cancel today’s class for **${room.group_name || groupId}** at **${timeInput}**?`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('Yes, cancel', `cancelclass_pick_${groupId}_${timeInput}`)],
                [Markup.button.callback('No', 'cancelclass_no')]
            ])
        });
        return;
    } catch (error) {
        await reportError('cancelclass command failed', error);
        ctx.reply('âŒ Failed to cancel the class. Please try again.');
    }
});

bot.action('cancelclass_no', async (ctx) => {
    try { await ctx.reply('Okay. No changes made.'); } catch {}
    try { await ctx.answerCbQuery(); } catch {}
});

bot.action(/^cancelclass_group_(.+)$/, async (ctx) => {
    try {
        if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
        const groupId = String(ctx.match[1]);
        await sendCancelClassPicker(ctx, groupId);
    } catch (error) {
        await reportError('cancelclass_group failed', error);
        await ctx.reply('Unable to load classes right now.');
    } finally {
        try { await ctx.answerCbQuery(); } catch {}
    }
});

bot.action(/^cancelclass_pick_(.+)_(all|([0-9]{2}:[0-9]{2}))$/, async (ctx) => {
    try {
        if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
        const groupId = String(ctx.match[1]);
        const token = String(ctx.match[2]);
        const timeInput = token === 'all' ? null : token;

        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            await ctx.reply('That group is not linked to a classroom.');
            return ctx.answerCbQuery();
        }
        const room = roomDoc.data();
        const specialistId = ctx.from.id.toString();
        if (specialistId !== room.specialist_id) {
            await ctx.reply('Only the linked Specialist can cancel the class.');
            return ctx.answerCbQuery();
        }

        const todayStr = getLagosDateString();
        let canceledCount = 0;

        if (timeInput) {
            if (!CLASS_TIME_REGEX.test(timeInput)) {
                await ctx.reply('Time format should be HH:MM in 24-hour format.');
                return ctx.answerCbQuery();
            }
            const classId = getClassDocId(groupId, todayStr, timeInput);
            const classDoc = await db.collection('classes').doc(classId).get();
            if (!classDoc.exists || classDoc.data().status !== 'active') {
                await ctx.reply('No active class scheduled at that time.');
                return ctx.answerCbQuery();
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
                await ctx.reply('No active classes scheduled for today to cancel.');
                return ctx.answerCbQuery();
            }
            for (const classDoc of snapshot.docs) {
                await db.collection('classes').doc(classDoc.id).update({ status: 'canceled', canceled_at: admin.firestore.FieldValue.serverTimestamp() });
                canceledCount += 1;
            }
        }

        const cancelMessage = `⚠️ The live session${timeInput ? ` at ${timeInput}` : ''} for **${room.group_name}** has been canceled.`;
        await ctx.telegram.sendMessage(groupId, cancelMessage, { parse_mode: 'Markdown' }).catch(() => {});
        await ctx.reply(`✅ Canceled ${canceledCount} scheduled class(es).`);
    } catch (error) {
        await reportError('cancelclass_pick failed', error);
        await ctx.reply('Failed to cancel the class. Please try again.');
    } finally {
        try { await ctx.answerCbQuery(); } catch {}
    }
});

bot.command('rescheduleclass', async (ctx) => {
    try {
        if (!(await requireSpecialist(ctx))) return;
        const specialistId = ctx.from.id.toString();
        const args = ctx.message.text.split(' ').slice(1);
        let groupId;
        let oldTime;
        let newTime;

        if (args.length >= 2 && CLASS_TIME_REGEX.test(args[0]) && CLASS_TIME_REGEX.test(args[1])) {
            oldTime = args[0];
            newTime = args[1];

            const groupsSnapshot = await db.collection('classrooms')
                .where('specialist_id', '==', specialistId)
                .get();
            if (groupsSnapshot.empty) {
                return ctx.reply('You have no classroom groups linked yet. Use /claim in a group first.');
            }
            if (groupsSnapshot.size === 1) {
                groupId = groupsSnapshot.docs[0].id;
            } else {
                const buttons = groupsSnapshot.docs.map((doc) => {
                    const room = doc.data() || {};
                    return [Markup.button.callback(`${room.group_name || doc.id}`, `rescheduleclass_pick_${doc.id}_${oldTime}_${newTime}`)];
                });
                await ctx.reply('Select a group to reschedule today’s class:', Markup.inlineKeyboard(buttons));
                return;
            }
        } else if (args.length >= 3) {
            groupId = args[0];
            oldTime = args[1];
            newTime = args[2];
        } else {
            return ctx.reply('❌ Format: /rescheduleclass <old_time> <new_time>\nExample: /rescheduleclass 14:00 15:00\n\nOr: /rescheduleclass <group_id> <old_time> <new_time>');
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
            reminder_10_sent: false,
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

bot.action(/^rescheduleclass_pick_(.+)_([0-9]{2}:[0-9]{2})_([0-9]{2}:[0-9]{2})$/, async (ctx) => {
    try {
        if (!(await requireSpecialist(ctx))) return ctx.answerCbQuery();
        const groupId = String(ctx.match[1]);
        const oldTime = String(ctx.match[2]);
        const newTime = String(ctx.match[3]);
        const specialistId = ctx.from.id.toString();

        if (!CLASS_TIME_REGEX.test(oldTime) || !CLASS_TIME_REGEX.test(newTime)) {
            await ctx.reply('Time format should be HH:MM in 24-hour format.');
            return ctx.answerCbQuery();
        }
        if (oldTime === newTime) {
            await ctx.reply('The new time must be different from the old time.');
            return ctx.answerCbQuery();
        }

        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            await ctx.reply('That group is not linked to a classroom.');
            return ctx.answerCbQuery();
        }
        const room = roomDoc.data();
        if (specialistId !== room.specialist_id) {
            await ctx.reply('Only the linked Specialist can reschedule this class.');
            return ctx.answerCbQuery();
        }

        const todayStr = getLagosDateString();
        const oldClassId = getClassDocId(groupId, todayStr, oldTime);
        const oldClassDoc = await db.collection('classes').doc(oldClassId).get();
        if (!oldClassDoc.exists || oldClassDoc.data().status !== 'active') {
            await ctx.reply('No active class exists at the old time.');
            return ctx.answerCbQuery();
        }

        const newClassId = getClassDocId(groupId, todayStr, newTime);
        const existingNewClass = await db.collection('classes').doc(newClassId).get();
        if (existingNewClass.exists && existingNewClass.data().status === 'active') {
            await ctx.reply('A class is already scheduled at the new time.');
            return ctx.answerCbQuery();
        }

        await db.collection('classes').doc(oldClassId).update({ status: 'rescheduled', canceled_at: admin.firestore.FieldValue.serverTimestamp() });
        await db.collection('classes').doc(newClassId).set({
            date: todayStr,
            time: newTime,
            topic: oldClassDoc.data().topic || null,
            reminder_30_sent: false,
            reminder_10_sent: false,
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
        const sentMessage = await ctx.telegram.sendMessage(groupId, announcementText, { parse_mode: 'Markdown' });
        await ctx.telegram.pinChatMessage(groupId, sentMessage.message_id, { disable_notification: true }).catch(() => {});

        await ctx.reply(`✅ Rescheduled class from ${oldTime} to ${newTime}.`);

        const verifiedTrainees = await getVerifiedTraineeIds(groupId);
        const reminderText = `🔄 The live session for **${room.group_name}** has been rescheduled to **${newTime}** today.${oldClassDoc.data().topic ? ` Topic: ${oldClassDoc.data().topic}` : ''}`;
        await sendDmUsers(normalizeUserIds([room.specialist_id, ...verifiedTrainees]), reminderText, { parse_mode: 'Markdown' });
    } catch (error) {
        await reportError('rescheduleclass_pick failed', error);
        await ctx.reply('Failed to reschedule the class. Please try again.');
    } finally {
        try { await ctx.answerCbQuery(); } catch {}
    }
});

cron.schedule('* * * * *', async () => {
    try {
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
            const [classHour, classMin] = String(classData.time || '').split(':').map(Number);
            const classTotalMins = (classHour * 60) + classMin;
            const minutesUntil = classTotalMins - currentTotalMins;
            const minutesAfter = currentTotalMins - classTotalMins;

            const roomDoc = await db.collection('classrooms').doc(classData.group_id).get();
            if (!roomDoc.exists) continue;
            const room = roomDoc.data();

            let reminderType = null;
            if (minutesUntil === 30 && !classData.reminder_30_sent) reminderType = '30';
        if (minutesUntil === 10 && !classData.reminder_10_sent) reminderType = '10';
            if (minutesUntil === 15 && !classData.reminder_15_sent) reminderType = '15';
            if (minutesUntil === 5 && !classData.reminder_5_sent) reminderType = '5';
            if (minutesUntil === 0 && !classData.reminder_0_sent) reminderType = '0';

            if (reminderType) {
                const usersToMessage = normalizeUserIds([room.specialist_id, ...await getVerifiedTraineeIds(classData.group_id)]);
                const topicText = classData.topic ? `\n\n**Topic:** ${classData.topic}` : '';

                let reminderText;
                let groupReminder;
                if (reminderType === '0') {
                    reminderText = `🚨 **Class Starting Now** 🚨\n\nLive session for **${room.group_name}** is starting now at **${classData.time}**.${topicText} Please join immediately.`;
                    groupReminder = reminderText;
                } else {
                    reminderText = `⏰ **Class Reminder** (${reminderType} minutes)\n\nLive session for **${room.group_name}** starts at **${classData.time}**.${topicText}\n\nPlease prepare and join on time.`;
                    groupReminder = reminderText;
                }

                await sendDmUsers(usersToMessage, reminderText, { parse_mode: 'Markdown' });
                await bot.telegram.sendMessage(classData.group_id, groupReminder, { parse_mode: 'Markdown' }).catch(async (error) => {
                    await reportError('Could not send group reminder', error);
                });

                await db.collection('classes').doc(doc.id).update({ [`reminder_${reminderType}_sent`]: true });

                if (reminderType === '0') {
                    const attendancePrompt = `📊 **Attendance Check**\n\nDid you attend the live session for **${room.group_name}**?${topicText}\n\nReply with /attended or /missed in a private chat with me.`;
                    await sendDmUsers(await getVerifiedTraineeIds(classData.group_id), attendancePrompt, { parse_mode: 'Markdown' });
                }
            }

            if (minutesAfter === 60 && !classData.feedback_sent) {
                const verifiedTrainees = await getVerifiedTraineeIds(classData.group_id);
                const feedbackText = `📝 **Session Feedback**\n\nHow was the live session for **${room.group_name}**?${classData.topic ? ` Topic: ${classData.topic}` : ''}\n\nRate 1-5 stars or share your thoughts.`;
                await sendDmUsers(verifiedTrainees, feedbackText, { parse_mode: 'Markdown' });
                await db.collection('classes').doc(doc.id).update({ feedback_sent: true });
            }
        }
    } catch (error) {
        await reportError('Minute cron failed', error);
    }
}, { timezone: 'Africa/Lagos' });

cron.schedule('30 7 * * *', async () => {
    try {
        const todayStr = getLagosDateString();
        const specialistsSnapshot = await db.collection('specialists').get();
        if (specialistsSnapshot.empty) return;

        for (const specialistDoc of specialistsSnapshot.docs) {
            const specialistId = specialistDoc.id;
            const groupsSnapshot = await db.collection('classrooms')
                .where('specialist_id', '==', specialistId)
                .get();
            if (groupsSnapshot.empty) continue;

            if (groupsSnapshot.size === 1) {
                const groupId = groupsSnapshot.docs[0].id;
                const room = groupsSnapshot.docs[0].data() || {};
                await bot.telegram.sendMessage(
                    specialistId,
                    `Good morning. Do you have a live session for **${room.group_name || groupId}** today (${todayStr})?`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('Yes', `daily_prompt_yes_${groupId}_${todayStr}`)],
                            [Markup.button.callback('No', `daily_prompt_no_${groupId}_${todayStr}`)]
                        ])
                    }
                );
                continue;
            }

            await bot.telegram.sendMessage(
                specialistId,
                `Good morning. Do you have any live session scheduled for today (${todayStr})?`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('Yes', `daily_live_yes_${todayStr}`)],
                    [Markup.button.callback('No', `daily_live_no_${todayStr}`)]
                ])
            );
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
            if (!shouldTrackUser(member)) continue;
            const userId = member.id.toString();
            const profile = getUserProfileFields(member);
            await upsertUserProfile(member);
            const existing = await getGroupVerification(groupId, userId);
            if (!existing) {
                await setGroupVerification(groupId, userId, {
                    group_id: groupId,
                    user_id: userId,
                    ...profile,
                    joined_at: admin.firestore.FieldValue.serverTimestamp(),
                    verified: false,
                    verified_at: null,
                    timed_out: false,
                    timed_out_at: null,
                    removed: false,
                    removed_at: null
                });
                await adjustGroupCounters(db, groupId, { unverified_count: 1, pending_count: 1 });
            } else if (existing.removed) {
                const wasVerified = Boolean(existing.verified);
                await setGroupVerification(groupId, userId, {
                    ...profile,
                    joined_at: admin.firestore.FieldValue.serverTimestamp(),
                    removed: false,
                    removed_at: null,
                    timed_out: false,
                    timed_out_at: null
                });
                if (wasVerified) {
                    await adjustGroupCounters(db, groupId, { verified_count: 1 });
                } else {
                    await adjustGroupCounters(db, groupId, { unverified_count: 1, pending_count: 1 });
                }
            } else {
                await setGroupVerification(groupId, userId, { ...profile, removed: false, removed_at: null });
            }
        }

        const membersToTag = (newMembers || []).filter(shouldTrackUser).slice(0, 10);
        const mentions = membersToTag.map((m) => {
            const label = m.username ? `@${m.username}` : (m.first_name ? String(m.first_name) : `user ${m.id}`);
            return buildUserMentionHtml(m.id, label);
        }).join(' ');

        const base = `Welcome to Skillforge Digital.\n\nTo receive class reminders in private messages, you must verify by messaging the bot.\n\n⏳ You have 24 hours to verify. If you do not verify, you will be muted, and later removed.\n\nTap Verify Now, then press Start (or send /verify in private chat).`;
        const message = mentions ? `${mentions}\n\n${base}` : base;
        const settings = await getGroupSettings(groupId);
        await deleteLastVerifyTagMessage(groupId, settings);
        const msg = await ctx.telegram.sendMessage(groupId, message, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([Markup.button.url('Verify Now ✅', getVerifyLink(groupId))])
        });
        await updateVerifyTagMessageId(groupId, msg?.message_id || null);
    } catch (error) {
        console.log("Could not send welcome message (Bot might have been kicked):", error.message);
    }
});

bot.on('chat_member', async (ctx) => {
    try {
        const update = ctx.update?.chat_member;
        const chat = update?.chat;
        if (!chat || !['group', 'supergroup'].includes(chat.type)) return;
        const groupId = String(chat.id);
        const member = update?.new_chat_member;
        const user = member?.user;
        if (!shouldTrackUser(user)) return;
        const userId = String(user.id);
        const status = member?.status ? String(member.status) : '';
        const profile = getUserProfileFields(user);
        await upsertUserProfile(user);

        if (status === 'left' || status === 'kicked') {
            const existing = await getGroupVerification(groupId, userId);
            if (existing && !existing.removed) {
                if (Boolean(existing.verified)) {
                    await adjustGroupCounters(db, groupId, { verified_count: -1 });
                } else {
                    const pendingDelta = existing.timed_out ? 0 : -1;
                    const timedOutDelta = existing.timed_out ? -1 : 0;
                    await adjustGroupCounters(db, groupId, { unverified_count: -1, pending_count: pendingDelta, timed_out_count: timedOutDelta });
                }
            }
            await setGroupVerification(groupId, userId, {
                ...profile,
                removed: true,
                removed_at: admin.firestore.FieldValue.serverTimestamp()
            });
            return;
        }

        if (status) {
            await setGroupVerification(groupId, userId, {
                group_id: groupId,
                user_id: userId,
                ...profile,
                removed: false,
                removed_at: null
            });
        }
    } catch (error) {
        await reportError('chat_member handler failed', error);
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
        const message = `✅ Verification Required\n\nTo receive class reminders in private messages, trainees must verify.\n\nTap the button below to verify:`;
        await ctx.telegram.sendMessage(groupId, message, Markup.inlineKeyboard([
            [Markup.button.url('Verify Now ✅', getVerifyLink(groupId))]
        ]));
    } catch (error) {
        await reportError('my_chat_member handler failed', error);
    }
});

const handleVerification = async (ctx, groupIdHint = null) => {
    if (ctx.chat.type !== 'private') {
        const groupId = ctx.chat?.id ? String(ctx.chat.id) : null;
        const link = groupId ? getVerifyLink(groupId) : getBotDirectMessageLink();
        try {
            const fromUser = ctx.from;
            const userId = fromUser?.id ? String(fromUser.id) : null;
            if (groupId && userId && shouldTrackUser(fromUser)) {
                const specialistDoc = await db.collection('specialists').doc(userId).get();
                if (!specialistDoc.exists) {
                    const existing = await getGroupVerification(groupId, userId);
                    if (!existing) {
                        const profile = getUserProfileFields(fromUser);
                        await upsertUserProfile(fromUser);
                        await setGroupVerification(groupId, userId, {
                            group_id: groupId,
                            user_id: userId,
                            ...profile,
                            joined_at: admin.firestore.FieldValue.serverTimestamp(),
                            verified: false,
                            verified_at: null,
                            timed_out: false,
                            timed_out_at: null,
                            removed: false,
                            removed_at: null
                        });
                        await adjustGroupCounters(db, groupId, { unverified_count: 1, pending_count: 1 });
                    }
                }
            }
        } catch {}
        return ctx.reply('Please verify in a private chat with the bot:', Markup.inlineKeyboard([Markup.button.url('Open Private Chat ✅', link)]));
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
            return ctx.reply('You are already verified! 🎓 Thank you.');
        }

        if (!existing) {
            const profile = getUserProfileFields(ctx.from);
            await upsertUserProfile(ctx.from);
            await setGroupVerification(groupId, userId, {
                group_id: String(groupId),
                user_id: userId,
                ...profile,
                joined_at: admin.firestore.FieldValue.serverTimestamp(),
                verified: false,
                verified_at: null,
                timed_out: false,
                timed_out_at: null,
                removed: false,
                removed_at: null
            });
        }

        if (!existing) {
            await adjustGroupCounters(db, groupId, { verified_count: 1 });
        } else if (!existing.verified && !existing.removed) {
            const pendingDelta = existing.timed_out ? 0 : -1;
            const timedOutDelta = existing.timed_out ? -1 : 0;
            await adjustGroupCounters(db, groupId, { verified_count: 1, unverified_count: -1, pending_count: pendingDelta, timed_out_count: timedOutDelta });
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

        try {
            const label = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ? String(ctx.from.first_name) : `user ${userId}`);
            await ctx.telegram.sendMessage(groupId, `✅ ${buildUserMentionHtml(userId, label)} verified successfully. Thank you.`, { parse_mode: 'HTML' });
        } catch (error) {
            console.log('Verification thank-you error:', error.message);
        }

        return ctx.reply('Verification successful! ✅ Thank you. You now have full access.');
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

    if (groupsSnapshot.size === 1) {
        const groupId = groupsSnapshot.docs[0].id;
        return beginScheduleSession(ctx, groupId);
    }

    const buttons = groupsSnapshot.docs.map((doc) => {
        const room = doc.data() || {};
        return [Markup.button.callback(`📅 ${room.group_name || doc.id}`, `schedule_${doc.id}`)];
    });

    return ctx.reply('Select a group to schedule a class:', Markup.inlineKeyboard(buttons));
};

const sendRosterGroupPicker = async (ctx, specialistId) => {
    const rooms = await getAccessibleClassrooms(String(specialistId));
    if (!rooms.length) {
        return ctx.reply('You have no classroom groups linked yet. Use /claim in a group first.');
    }

    const buttons = rooms.slice(0, 20).map((room) => [Markup.button.callback(`${room.group_name || room.id}`, `roster_${room.id}`)]);

    return ctx.reply('Select a group to view trainee roster:', Markup.inlineKeyboard(buttons));
};

bot.command('roster', async (ctx) => {
    if (ctx.chat.type !== 'private') {
        return ctx.reply('Please use /roster in a private chat with the bot.');
    }
    const ok = await requireStaff(ctx);
    if (!ok) return;
    return await sendRosterGroupPicker(ctx, String(ctx.from.id));
});

bot.action(/^roster_(.+)$/, async (ctx) => {
    try {
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const groupId = String(ctx.match[1]);
        const accessOk = await requireClassroomOwnerOrSuperAdmin(ctx, groupId);
        if (!accessOk) return;

        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            await ctx.reply('Group not found.');
            return;
        }
        const room = roomDoc.data() || {};

        const verifiedSnapshot = await db.collection('group_verifications')
            .where('group_id', '==', groupId)
            .where('verified', '==', true)
            .where('removed', '==', false)
            .get();
        const unverifiedSnapshot = await db.collection('group_verifications')
            .where('group_id', '==', groupId)
            .where('verified', '==', false)
            .where('removed', '==', false)
            .get();

        const unverifiedUsers = unverifiedSnapshot.docs
            .map(d => d.data())
            .filter((u) => u && !u.is_bot && !EXCLUDED_SYSTEM_USER_IDS.has(String(u.user_id)));

        const mentionLimit = 30;
        const mentions = unverifiedUsers.slice(0, mentionLimit).map((u) => {
            const label = u.username ? `@${u.username}` : (u.display_name || `user ${u.user_id}`);
            return buildUserMentionHtml(u.user_id, label);
        }).join('\n');

        const remaining = unverifiedUsers.length - Math.min(unverifiedUsers.length, mentionLimit);
        const remainingLine = remaining > 0 ? `\n...and ${remaining} more.` : '';
        const header = `<b>${escapeHtml(room.group_name || groupId)}</b>\nVerified: ${verifiedSnapshot.size}\nUnverified: ${unverifiedUsers.length}\n\n`;
        const body = unverifiedUsers.length ? `Unverified trainees:\n${mentions}${remainingLine}` : 'No unverified trainees found.';
        await ctx.reply(`${header}${body}`, { parse_mode: 'HTML' });
    } catch (error) {
        await reportError('roster action failed', error);
        await ctx.reply('Unable to load roster right now.');
    } finally {
        try { await ctx.answerCbQuery(); } catch {}
    }
});

bot.command('feedback', async (ctx) => {
    const userId = ctx.from?.id ? String(ctx.from.id) : null;
    if (!userId) return;
    const msgText = String(ctx.message?.text || '');
    const parts = msgText.trim().split(/\s+/);
    const inline = parts.length > 1 ? msgText.slice(msgText.indexOf(' ') + 1).trim() : '';
    const userLabel = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ? String(ctx.from.first_name) : userId);

    if (ctx.chat?.type === 'private') {
        if (inline) {
            await db.collection('general_feedback').add({
                group_id: null,
                group_name: null,
                user_id: userId,
                feedback: inline,
                source: 'dm',
                created_at: admin.firestore.FieldValue.serverTimestamp()
            });
            await logFeedback({ group_id: null, group_name: null, user_id: userId, user_label: userLabel, text: inline });
            await ctx.reply('✅ Feedback received. Thank you.');
            return;
        }
        await db.collection('feedback_sessions').doc(userId).set({
            user_id: userId,
            status: 'awaiting_feedback',
            created_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        await ctx.reply('Send your feedback now (your next message will be saved).');
        return;
    }

    const groupId = String(ctx.chat.id);
    const roomDoc = await db.collection('classrooms').doc(groupId).get();
    const groupName = roomDoc.exists ? String(roomDoc.data()?.group_name || ctx.chat?.title || groupId) : String(ctx.chat?.title || groupId);

    if (inline) {
        await db.collection('general_feedback').add({
            group_id: groupId,
            group_name: groupName,
            user_id: userId,
            feedback: inline,
            source: 'group',
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
        await logFeedback({ group_id: groupId, group_name: groupName, user_id: userId, user_label: userLabel, text: inline });
        await ctx.telegram.deleteMessage(groupId, ctx.message.message_id).catch(() => {});
        await ctx.telegram.sendMessage(groupId, `✅ ${buildUserMentionHtml(userId, userLabel)} feedback received. Thank you.`, { parse_mode: 'HTML' }).catch(() => {});
        return;
    }

    const prompt = await ctx.reply(`Reply to this message with your feedback.`, { reply_markup: { force_reply: true } }).catch(() => null);
    if (!prompt?.message_id) return;
    await db.collection('feedback_pending').doc(`${groupId}_${userId}`).set({
        group_id: groupId,
        group_name: groupName,
        user_id: userId,
        prompt_message_id: String(prompt.message_id),
        created_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
});

bot.command('recount', async (ctx) => {
    try {
        if (ctx.chat.type !== 'private') {
            return ctx.reply('Please use /recount in a private chat with the bot.');
        }
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const parts = String(ctx.message?.text || '').trim().split(/\s+/).filter(Boolean);
        const groupId = parts[1] ? String(parts[1]) : null;
        if (!groupId) {
            const rooms = await getAccessibleClassrooms(String(ctx.from.id));
            if (!rooms.length) return ctx.reply('No classroom groups found.');
            const buttons = rooms.slice(0, 20).map((r) => [Markup.button.callback(`${r.group_name || r.id}`, `recount_${r.id}`)]);
            return ctx.reply('Select a group to recount:', Markup.inlineKeyboard(buttons));
        }

        const accessOk = await requireClassroomOwnerOrSuperAdmin(ctx, groupId);
        if (!accessOk) return;
        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) return ctx.reply('Group not found.');
        const room = roomDoc.data() || {};

        const snap = await db.collection('group_verifications').where('group_id', '==', groupId).get();
        const docs = snap.docs.map((d) => d.data()).filter(Boolean);
        const counters = computeCountersFromVerificationDocs(docs);
        await db.collection('group_settings').doc(groupId).set({
            group_id: groupId,
            ...counters,
            counters_initialized: true,
            counters_recalculated_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return ctx.reply(`Counters updated for ${room.group_name || groupId}.`);
    } catch (error) {
        await reportError('recount command failed', error);
        return ctx.reply('Unable to recount right now.');
    }
});

bot.action(/^recount_(.+)$/, async (ctx) => {
    try {
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const groupId = String(ctx.match[1]);
        const accessOk = await requireClassroomOwnerOrSuperAdmin(ctx, groupId);
        if (!accessOk) return;
        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            await ctx.reply('Group not found.');
            return;
        }
        const room = roomDoc.data() || {};
        const snap = await db.collection('group_verifications').where('group_id', '==', groupId).get();
        const docs = snap.docs.map((d) => d.data()).filter(Boolean);
        const counters = computeCountersFromVerificationDocs(docs);
        await db.collection('group_settings').doc(groupId).set({
            group_id: groupId,
            ...counters,
            counters_initialized: true,
            counters_recalculated_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        await ctx.reply(`Counters updated for ${room.group_name || groupId}.`);
    } catch (error) {
        await reportError('recount action failed', error);
        await ctx.reply('Unable to recount right now.');
    } finally {
        try { await ctx.answerCbQuery(); } catch {}
    }
});

bot.command('addadmin', async (ctx) => {
    try {
        if (ctx.chat.type !== 'private') {
            return ctx.reply('Please use /addadmin in a private chat with the bot.');
        }
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const parts = String(ctx.message?.text || '').trim().split(/\s+/).filter(Boolean);
        const groupId = parts[1] ? String(parts[1]) : null;
        const targetId = parts[2] ? String(parts[2]) : null;
        if (!groupId || !targetId) return ctx.reply('Usage: /addadmin <group_id> <user_id>');
        const accessOk = await requireClassroomOwnerOrSuperAdmin(ctx, groupId);
        if (!accessOk) return;
        const specialistId = String(ctx.from.id);
        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) return ctx.reply('Group not found.');

        await setGroupAdmin(db, groupId, targetId, {
            added_by: specialistId,
            added_at: admin.firestore.FieldValue.serverTimestamp()
        });
        return ctx.reply('Admin added.');
    } catch (error) {
        await reportError('addadmin command failed', error);
        return ctx.reply('Unable to add admin right now.');
    }
});

bot.command('removeadmin', async (ctx) => {
    try {
        if (ctx.chat.type !== 'private') {
            return ctx.reply('Please use /removeadmin in a private chat with the bot.');
        }
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const parts = String(ctx.message?.text || '').trim().split(/\s+/).filter(Boolean);
        const groupId = parts[1] ? String(parts[1]) : null;
        const targetId = parts[2] ? String(parts[2]) : null;
        if (!groupId || !targetId) return ctx.reply('Usage: /removeadmin <group_id> <user_id>');
        const accessOk = await requireClassroomOwnerOrSuperAdmin(ctx, groupId);
        if (!accessOk) return;
        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) return ctx.reply('Group not found.');

        await removeGroupAdmin(db, groupId, targetId);
        return ctx.reply('Admin removed.');
    } catch (error) {
        await reportError('removeadmin command failed', error);
        return ctx.reply('Unable to remove admin right now.');
    }
});

bot.command('listadmins', async (ctx) => {
    try {
        if (ctx.chat.type !== 'private') {
            return ctx.reply('Please use /listadmins in a private chat with the bot.');
        }
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const parts = String(ctx.message?.text || '').trim().split(/\s+/).filter(Boolean);
        const groupId = parts[1] ? String(parts[1]) : null;
        if (!groupId) {
            const rooms = await getAccessibleClassrooms(String(ctx.from.id));
            if (!rooms.length) return ctx.reply('No classroom groups found.');
            const buttons = rooms.slice(0, 20).map((r) => [Markup.button.callback(`${r.group_name || r.id}`, `gadmins_${r.id}`)]);
            return ctx.reply('Select a group:', Markup.inlineKeyboard(buttons));
        }
        const accessOk = await requireClassroomOwnerOrSuperAdmin(ctx, groupId);
        if (!accessOk) return;
        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) return ctx.reply('Group not found.');
        const room = roomDoc.data() || {};
        const admins = await listGroupAdmins(db, groupId, 80);
        if (!admins.length) return ctx.reply('No stored admins for this group.');
        const lines = admins.map((a) => `• ${a.user_id}`).join('\n');
        return ctx.reply(`Admins for ${room.group_name || groupId}:\n${lines}`);
    } catch (error) {
        await reportError('listadmins command failed', error);
        return ctx.reply('Unable to list admins right now.');
    }
});

bot.action(/^gadmins_(.+)$/, async (ctx) => {
    try {
        const ok = await requireStaff(ctx);
        if (!ok) return;
        const groupId = String(ctx.match[1]);
        const accessOk = await requireClassroomOwnerOrSuperAdmin(ctx, groupId);
        if (!accessOk) return;
        const roomDoc = await db.collection('classrooms').doc(groupId).get();
        if (!roomDoc.exists) {
            await ctx.reply('Group not found.');
            return;
        }
        const room = roomDoc.data() || {};
        const admins = await listGroupAdmins(db, groupId, 80);
        if (!admins.length) {
            await ctx.reply(`No stored admins for ${room.group_name || groupId}.`);
            return;
        }
        const lines = admins.map((a) => `• ${a.user_id}`).join('\n');
        await ctx.reply(`Admins for ${room.group_name || groupId}:\n${lines}`);
    } catch (error) {
        await reportError('gadmins action failed', error);
        await ctx.reply('Unable to list admins right now.');
    } finally {
        try { await ctx.answerCbQuery(); } catch {}
    }
});

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

bot.command('start', async (ctx) => {
    try {
        const messageText = String(ctx.message?.text || '');
        const payloadText = messageText.replace(/^\/start(@\w+)?\s*/i, '').trim();
        const payload = payloadText || null;
        const userId = ctx.from.id.toString();
        const normalizedPayload = payload === 'start' || payload === 'menu' ? null : payload;

        if (ctx.chat.type !== 'private') {
            const groupId = ctx.chat?.id ? String(ctx.chat.id) : null;
            const link = groupId ? getVerifyLink(groupId) : getBotDirectMessageLink();
            try {
                const specialistDoc = await db.collection('specialists').doc(userId).get();
                if (!specialistDoc.exists && groupId && shouldTrackUser(ctx.from)) {
                    const existing = await getGroupVerification(groupId, userId);
                    if (!existing) {
                        const profile = getUserProfileFields(ctx.from);
                        await upsertUserProfile(ctx.from);
                        await setGroupVerification(groupId, userId, {
                            group_id: groupId,
                            user_id: userId,
                            ...profile,
                            joined_at: admin.firestore.FieldValue.serverTimestamp(),
                            verified: false,
                            verified_at: null,
                            timed_out: false,
                            timed_out_at: null,
                            removed: false,
                            removed_at: null
                        });
                        await adjustGroupCounters(db, groupId, { unverified_count: 1, pending_count: 1 });
                    }
                }
            } catch {}
            return ctx.reply('Please verify in a private chat with the bot:', Markup.inlineKeyboard([Markup.button.url('Open Private Chat ✅', link)]));
        }

        if (normalizedPayload === 'verify' || (normalizedPayload && normalizedPayload.startsWith('verify_'))) {
            const groupId = normalizedPayload && normalizedPayload.startsWith('verify_') ? decodeURIComponent(normalizedPayload.slice('verify_'.length)) : null;
            return await handleVerification(ctx, groupId);
        }

        let roleInfo;
        try {
            roleInfo = await getUserRole(userId);
        } catch (error) {
            await reportError('getUserRole failed', error);
            roleInfo = { role: 'trainee_unverified' };
        }
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
    } catch (error) {
        await reportError('start handler failed', error);
        try {
            return await ctx.reply('❌ I could not process that. Please try again or use /help.');
        } catch {
            return;
        }
    }
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

    const roomDoc = await db.collection('classrooms').doc(groupId).get();
    if (!roomDoc.exists) {
        return ctx.reply('That group is not linked to a classroom.');
    }

    const room = roomDoc.data();
    if (room.specialist_id !== specialistId) {
        return ctx.reply('You are not the linked specialist for that group.');
    }

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
    return ctx.reply(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([Markup.button.callback('Yes, start review', `review_start_${sessionId}`)])
    });
});

bot.hears('Schedule Class', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    const specialistId = ctx.from.id.toString();
    await sendScheduleGroupPicker(ctx, specialistId);
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

            try {
                const unverifiedSnapshot = await db.collection('group_verifications')
                    .where('group_id', '==', groupId)
                    .where('verified', '==', false)
                    .where('timed_out', '==', false)
                    .where('removed', '==', false)
                    .get();

                if (unverifiedSnapshot.empty) {
                    await stopVerifyCampaign(groupId);
                    continue;
                }

                const bypassAdmins = await getBypassAdminIdSet(groupId);
                const allUnverified = unverifiedSnapshot.docs
                    .map((d) => ({ id: d.id, ...d.data() }))
                    .filter((u) => u && !u.is_bot && !EXCLUDED_SYSTEM_USER_IDS.has(String(u.user_id)));

                const tagCandidates = [];
                for (const u of allUnverified) {
                    const uid = String(u.user_id);
                    if (bypassAdmins.has(uid)) {
                        await bypassVerificationForAdmin(groupId, u);
                        continue;
                    }
                    tagCandidates.push(u);
                }

                if (!tagCandidates.length) {
                    await stopVerifyCampaign(groupId);
                    continue;
                }

                const mentionLimit = 20;
                const mentions = tagCandidates.slice(0, mentionLimit).map((u) => {
                    const label = u.username ? `@${u.username}` : (u.display_name || `user ${u.user_id}`);
                    return buildUserMentionHtml(u.user_id, label);
                }).join(' ');

                const remaining = tagCandidates.length - Math.min(tagCandidates.length, mentionLimit);
                const remainingLine = remaining > 0 ? `\n\nAnd ${remaining} more unverified member(s).` : '';
                const message = `⚠️ <b>Verification Reminder</b>\n\n${mentions}${remainingLine}\n\n⏳ You have 24 hours to verify after joining. If you do not verify, you will be muted, and later removed.\n\nVerify now to receive class reminders in DM.\n\nIf you are not tagged here, send /verify in this group or message the bot privately with /verify.`;

                const currentSettings = settings || (await getGroupSettings(groupId));
                await deleteLastVerifyTagMessage(groupId, currentSettings);
                const msg = await bot.telegram.sendMessage(groupId, message, {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([Markup.button.url('Verify Now ✅', getVerifyLink(groupId))])
                });
                await updateVerifyReminderSent(groupId, msg?.message_id || null);
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
        const adminCache = new Map();
        if (!snapshot.empty) {
            for (const doc of snapshot.docs) {
                const data = doc.data();
                try {
                    const groupId = String(data.group_id);
                    const userId = String(data.user_id);
                    if (groupId && userId) {
                        if (!adminCache.has(groupId)) adminCache.set(groupId, await getBypassAdminIdSet(groupId));
                        const bypassSet = adminCache.get(groupId);
                        if (bypassSet && bypassSet.has(userId)) {
                            await bypassVerificationForAdmin(groupId, { id: doc.id, ...data });
                            continue;
                        }
                    }
                    await bot.telegram.restrictChatMember(data.group_id, data.user_id, { permissions: { can_send_messages: false } });
                    await db.collection('group_verifications').doc(doc.id).update({
                        timed_out: true,
                        timed_out_at: admin.firestore.FieldValue.serverTimestamp()
                    });
                    await adjustGroupCounters(db, data.group_id, { pending_count: -1, timed_out_count: 1 });
                    const displayName = data.username ? `@${data.username}` : (data.display_name || `${data.user_id}`);
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
                    const groupId = String(data.group_id);
                    const userId = String(data.user_id);
                    if (groupId && userId) {
                        if (!adminCache.has(groupId)) adminCache.set(groupId, await getBypassAdminIdSet(groupId));
                        const bypassSet = adminCache.get(groupId);
                        if (bypassSet && bypassSet.has(userId)) {
                            await bypassVerificationForAdmin(groupId, { id: doc.id, ...data });
                            continue;
                        }
                    }
                    await bot.telegram.kickChatMember(data.group_id, data.user_id);
                    await db.collection('group_verifications').doc(doc.id).update({ removed: true, removed_at: admin.firestore.FieldValue.serverTimestamp() });
                    await adjustGroupCounters(db, data.group_id, { unverified_count: -1, timed_out_count: -1 });
                    const displayName = data.username ? `@${data.username}` : (data.display_name || `${data.user_id}`);
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
app.get('/logo.jpg', (req, res) => res.sendFile(path.join(__dirname, 'logo.jpg')));

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
        if (!specialistDoc.exists && !isSuperAdminId(telegram_id)) return res.status(403).json({ error: 'not allowed' });

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
        const role = isSuperAdminId(telegram_id) ? 'super_admin' : 'specialist';
        await db.collection('admin_sessions').doc(sessionId).set({
            session_id: sessionId,
            telegram_id,
            role,
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
        const disposition = String(req.query?.inline || '') === '1' ? 'inline' : 'attachment';
        res.setHeader('Content-Disposition', `${disposition}; filename="weekly_review_${session.group_name}_${session.week_start}_to_${session.week_end}.pdf"`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('Review route error:', error);
        res.status(500).send('Unable to generate review PDF.');
    }
});

app.get('/review/:id/print', async (req, res) => {
    const id = String(req.params.id || '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Weekly Review Print</title>
  <style>
    html, body { height: 100%; margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
    header { display: flex; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid #e5e7eb; }
    header img { height: 34px; width: auto; border-radius: 4px; }
    header .spacer { flex: 1; }
    button { appearance: none; border: 1px solid #111827; background: #111827; color: #fff; padding: 8px 12px; border-radius: 8px; cursor: pointer; }
    button.secondary { background: #fff; color: #111827; }
    main { height: calc(100% - 58px); }
    iframe { width: 100%; height: 100%; border: 0; }
    @media print { header { display: none; } main { height: 100%; } }
  </style>
</head>
<body>
  <header>
    <img src="/logo.jpg" alt="Logo">
    <strong>Weekly Review Report</strong>
    <div class="spacer"></div>
    <button class="secondary" onclick="location.href='/review/${encodeURIComponent(id)}'">Download PDF</button>
    <button onclick="document.getElementById('pdf').contentWindow.print()">Print</button>
  </header>
  <main>
    <iframe id="pdf" src="/review/${encodeURIComponent(id)}?inline=1"></iframe>
  </main>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
const isWebhookMode = Boolean(SERVER_URL && WEBHOOK_SECRET);
const WEBHOOK_PATH = isWebhookMode ? `/webhook/${WEBHOOK_SECRET}` : null;

app.listen(PORT, '0.0.0.0', () => console.log(`Web server listening on port ${PORT}`));

const botRuntime = {
    started_at: new Date().toISOString(),
    launched: false,
    launch_error: null,
    telegram_me: null,
    polling: {
        state: 'init',
        launch_attempt: 0,
        last_error: null,
        last_error_at: null
    },
    polling_lock: {
        enabled: true,
        acquired: false,
        owner: null,
        expires_at: null
    }
};

app.get('/_diag', async (req, res) => {
    try {
        return res.json({
            ok: true,
            server_time: new Date().toISOString(),
            bot_username_env: BOT_USERNAME_SAFE,
            mode: isWebhookMode ? 'webhook' : 'polling',
            launched: botRuntime.launched,
            launch_error: botRuntime.launch_error,
            telegram_me: botRuntime.telegram_me,
            polling: botRuntime.polling,
            polling_lock: botRuntime.polling_lock
        });
    } catch {
        return res.status(500).json({ ok: false });
    }
});

bot.catch(async (err, ctx) => {
    console.error('Bot update failed:', err?.message || err, 'Update type:', ctx?.updateType);
    await reportError('Unhandled bot error', err);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const POLLING_LOCK_DOC = db.collection('runtime').doc('polling_lock');
const POLLING_LOCK_TTL_MS = 90_000;
const POLLING_LOCK_REFRESH_MS = 30_000;
const INSTANCE_ID = require('crypto').randomBytes(12).toString('hex');
let pollingLockInterval = null;

const readPollingLockDoc = async () => {
    try {
        const snap = await POLLING_LOCK_DOC.get();
        if (!snap.exists) return null;
        const data = snap.data() || {};
        const expiresAt = data.expires_at?.toDate ? data.expires_at.toDate().toISOString() : null;
        return { owner: data.owner || null, expires_at: expiresAt };
    } catch {
        return null;
    }
};

const acquirePollingLock = async () => {
    const now = Date.now();
    const expiresAt = admin.firestore.Timestamp.fromDate(new Date(now + POLLING_LOCK_TTL_MS));
    const acquired = await db.runTransaction(async (tx) => {
        const snap = await tx.get(POLLING_LOCK_DOC);
        if (snap.exists) {
            const data = snap.data() || {};
            const currentExpires = data.expires_at?.toDate ? data.expires_at.toDate().getTime() : 0;
            const currentOwner = data.owner || null;
            if (currentExpires > now && currentOwner && currentOwner !== INSTANCE_ID) return false;
        }
        tx.set(POLLING_LOCK_DOC, {
            owner: INSTANCE_ID,
            expires_at: expiresAt,
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return true;
    });

    botRuntime.polling_lock.acquired = acquired;
    botRuntime.polling_lock.owner = acquired ? INSTANCE_ID : null;
    botRuntime.polling_lock.expires_at = expiresAt.toDate().toISOString();

    if (!acquired) {
        const current = await readPollingLockDoc();
        if (current) {
            botRuntime.polling_lock.owner = current.owner;
            botRuntime.polling_lock.expires_at = current.expires_at;
        }
        return false;
    }

    pollingLockInterval = setInterval(async () => {
        try {
            const snap = await POLLING_LOCK_DOC.get();
            const data = snap.exists ? snap.data() : null;
            if (!data || data.owner !== INSTANCE_ID) {
                botRuntime.polling_lock.acquired = false;
                botRuntime.polling_lock.owner = null;
                if (botRuntime.launched) {
                    try { await bot.stop('lost_lock'); } catch {}
                }
                clearInterval(pollingLockInterval);
                pollingLockInterval = null;
                return;
            }
            const refreshExpires = admin.firestore.Timestamp.fromDate(new Date(Date.now() + POLLING_LOCK_TTL_MS));
            await POLLING_LOCK_DOC.set({
                owner: INSTANCE_ID,
                expires_at: refreshExpires,
                updated_at: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            botRuntime.polling_lock.expires_at = refreshExpires.toDate().toISOString();
        } catch {}
    }, POLLING_LOCK_REFRESH_MS);

    return true;
};

const startBot = async () => {
    try {
        console.log('Starting Telegram bot (polling mode)...');
        botRuntime.polling.state = 'getMe';
        try {
            botRuntime.telegram_me = await bot.telegram.getMe();
            console.log(`Bot token is for @${botRuntime.telegram_me?.username || 'unknown'}`);
        } catch (error) {
            botRuntime.launch_error = String(error?.message || error || 'getMe failed');
            botRuntime.polling.last_error = botRuntime.launch_error;
            botRuntime.polling.last_error_at = new Date().toISOString();
            throw error;
        }

        const BOT_COMMANDS_FULL = [
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
        ];

        const BOT_COMMANDS_GROUP = [
            { command: 'start', description: 'Start the bot' },
            { command: 'verify', description: 'Verify in DM (get reminders)' },
            { command: 'claim', description: 'Link this group (staff only)' },
            { command: 'status', description: 'View group status' },
            { command: 'help', description: 'Show help' }
        ];

        const syncBotCommands = async () => {
            try {
                await bot.telegram.setMyCommands(BOT_COMMANDS_FULL);
                await bot.telegram.setMyCommands(BOT_COMMANDS_FULL, { scope: { type: 'all_private_chats' } });
                await bot.telegram.setMyCommands(BOT_COMMANDS_GROUP, { scope: { type: 'all_group_chats' } });
            } catch (error) {
                console.error('setMyCommands failed:', error?.message || error);
            }
        };

        await syncBotCommands();

        if (isWebhookMode) {
            botRuntime.polling.state = 'webhook';
            const webhookUrl = `${SERVER_URL}${WEBHOOK_PATH}`;
            await bot.telegram.setWebhook(webhookUrl, { drop_pending_updates: true });
            app.use(bot.webhookCallback(WEBHOOK_PATH));
            botRuntime.launched = true;
            botRuntime.launch_error = null;
            console.log(`Bot webhook configured at ${webhookUrl}`);
            console.log('Skillforge Bot is fully operational!');
            return;
        }

        botRuntime.polling.state = 'lock_wait';
        for (let attempt = 1; attempt <= 60; attempt++) {
            const lockOk = await acquirePollingLock();
            if (lockOk) break;
            botRuntime.launch_error = 'polling lock not acquired (another instance active)';
            botRuntime.polling.last_error = botRuntime.launch_error;
            botRuntime.polling.last_error_at = new Date().toISOString();
            const owner = botRuntime.polling_lock.owner ? `owner=${botRuntime.polling_lock.owner}` : 'owner=unknown';
            const exp = botRuntime.polling_lock.expires_at ? `expires_at=${botRuntime.polling_lock.expires_at}` : 'expires_at=unknown';
            console.error(`Polling lock not acquired. Waiting... (${attempt}/60) ${owner} ${exp}`);
            await sleep(10_000);
        }
        if (!botRuntime.polling_lock.acquired) return;

        await bot.telegram.deleteWebhook({ drop_pending_updates: true });

        botRuntime.polling.state = 'launching';
        for (let attempt = 1; attempt <= 360; attempt++) {
            try {
                botRuntime.polling.launch_attempt = attempt;
                await bot.launch({ dropPendingUpdates: true });
                botRuntime.launched = true;
                botRuntime.launch_error = null;
                botRuntime.polling.state = 'running';
                console.log('Skillforge Bot launched in polling mode');
                break;
            } catch (error) {
                const message = String(error?.message || error || '');
                const isConflict = message.includes('409') && message.toLowerCase().includes('getupdates');
                botRuntime.polling.last_error = message;
                botRuntime.polling.last_error_at = new Date().toISOString();
                botRuntime.launch_error = message;
                if (!isConflict) throw error;
                console.error(`Polling conflict (409). Another instance is using getUpdates. Retry ${attempt}/360 in 10s...`);
                await sleep(10_000);
            }
        }
        if (!botRuntime.launched) return;

        console.log('Skillforge Bot is fully operational!');
    } catch (error) {
        botRuntime.launched = false;
        botRuntime.launch_error = String(error?.message || error || 'startup failed');
        console.error('Failed to start Skillforge Bot:', error?.message || error);
        await reportError('Bot startup failure', error);
        process.exit(1);
    }
};

startBot();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
