const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const https = require('https');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');
const pool = require('../config/db');
const { createNawabOrder, checkSmmOrderStatus, getSmmBalance } = require('../services/smm');
const {
    downloadInstagramVideo,
    downloadYouTubeVideo,
    downloadFacebookVideo,
    downloadUniversalVideo,
    fetchFromInstagramEmbed,
    extractInstagramShortcode,
    extractYouTubeId,
    getAudioInfo
} = require('../services/downloader');
const { adminBot, forwardReceiptToAdmin } = require('./adminBot');

const telegramAgent = new https.Agent({
    family: 4,
    keepAlive: true,
    maxSockets: 100,
    keepAliveMsecs: 30000
});

const bot = new Telegraf(process.env.BOT_TOKEN, {
    telegram: {
        agent: telegramAgent
    }
});

const userSessions = new Map();

// Narxlar va Tezkor Xizmatlar konfiguratsiyasi (so'mda)
const SERVICES_CONFIG = {
    // Instagram (Fast & Instant)
    ig_views: { id: 13, platform: 'instagram', name: 'Instagram Ko\'rishlar (Prasmotr)', qty: 100, price: 1000, speed: '0 - 10 daqiqa (Tezkor)' },
    ig_likes: { id: 89, platform: 'instagram', name: 'Instagram Layklar (Likes)', qty: 50, price: 2000, speed: '0 - 3 daqiqa (Ultra tez)' },
    ig_followers: { id: 108, platform: 'instagram', name: 'Instagram Obunachilar (Followers)', qty: 10, price: 3000, speed: '5 - 30 daqiqa' },

    // YouTube (Fast)
    yt_views: { id: 157, platform: 'youtube', name: 'YouTube Ko\'rishlar (Views)', qty: 50, price: 2000, speed: '15 - 30 daqiqa' },
    yt_subscribers: { id: 922, platform: 'youtube', name: 'YouTube Obunachilar (Subscribers)', qty: 10, price: 2000, speed: '0 - 5 daqiqa (Super tez)' },
    yt_likes: { id: 386, platform: 'youtube', name: 'YouTube Layklar (Likes)', qty: 10, price: 2000, speed: '0 - 10 daqiqa (Tezkor)' },

    // Facebook (Fast)
    fb_views: { id: 230, platform: 'facebook', name: 'Facebook Ko\'rishlar (Video Views)', qty: 100, price: 1500, speed: '0 - 20 daqiqa' },
    fb_likes: { id: 979, platform: 'facebook', name: 'Facebook Layklar (Reactions)', qty: 10, price: 1500, speed: 'Instant (Bir zumda)' }
};

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function extractUrl(text) {
    if (!text || typeof text !== 'string') return '';
    const match = text.match(/(https?:\/\/[^\s]+)/i);
    let url = match ? match[1].trim() : text.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        if (/^(www\.)?(instagram\.com|instagr\.am|youtube\.com|youtu\.be|facebook\.com|fb\.watch|fb\.com)/i.test(url)) {
            url = 'https://' + url;
        }
    }
    return url;
}

function isValidInstagramLink(input) {
    if (!input || typeof input !== 'string') return false;
    const url = extractUrl(input);
    const instagramRegex = /^https?:\/\/(www\.|m\.)?(instagram\.com|instagr\.am)\/[a-zA-Z0-9_./-]+(\?.*)?$/i;
    return instagramRegex.test(url);
}

function isValidYouTubeLink(input) {
    if (!input || typeof input !== 'string') return false;
    const url = extractUrl(input);
    return /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\/.+/i.test(url);
}

function isValidFacebookLink(input) {
    if (!input || typeof input !== 'string') return false;
    const url = extractUrl(input);
    return /^https?:\/\/(www\.|m\.|web\.|mbasic\.)?(facebook\.com|fb\.watch|fb\.com)\/.+/i.test(url);
}

function isValidPlatformLink(input, platform) {
    if (!input || typeof input !== 'string') return false;
    if (platform === 'instagram') return isValidInstagramLink(input);
    if (platform === 'facebook') return isValidFacebookLink(input);
    if (platform === 'youtube') return isValidYouTubeLink(input);
    return false;
}

// 🛡️ FOYDALANUVCHIDA KUTILAYOTGAN (PENDING) CHEK BOR-YO'QLIGINI TEKSHIRISH VA BLOKLASH
async function checkPendingReceiptAndAlert(ctx) {
    const telegramId = ctx.from.id;
    try {
        const res = await pool.query(
            "SELECT id FROM receipts WHERE telegram_id = $1 AND status = 'pending' LIMIT 1",
            [telegramId]
        );
        if (res.rows.length > 0) {
            const receiptId = res.rows[0].id;
            const text =
                `⏳ <b>Hurmatli foydalanuvchi!</b>\n\n` +
                `Siz yuborgan to'lov cheki hozirda administrator tomonidan tekshirilmoqda (#${receiptId}).\n\n` +
                `Administrator chekni tasdiqlab, balansingizga mablag' qo'shmaguncha boshqa nakrutka amallarini bajara olmaysiz.\n\n` +
                `<i>Iltimos, administrator tasdiqlashini kuting. Admin tasdiqlashi bilan barcha pullik xizmatlar avtomatik ochiladi va sizga xabar yetkaziladi!</i>`;

            if (ctx.callbackQuery) {
                await ctx.answerCbQuery('⏳ Chekingiz admin tekshiruvida!', { show_alert: true }).catch(() => {});
                await ctx.reply(text, { parse_mode: 'HTML' });
            } else {
                await ctx.reply(text, { parse_mode: 'HTML' });
            }
            return true;
        }
    } catch (_) {}
    return false;
}

// =========================================================
// 1-QADAM: /start va RO'YXATDAN O'TISH
// =========================================================
bot.start(async (ctx) => {
    try {
        const telegramId = ctx.from.id;
        const firstName = ctx.from.first_name || 'Foydalanuvchi';

        const result = await pool.query('SELECT phone, full_name FROM users WHERE telegram_id = $1', [telegramId]);

        if (result.rows.length === 0 || !result.rows[0].phone) {
            userSessions.set(telegramId, { step: 'WAIT_CONTACT' });
            return await ctx.reply(
                `Assalomu alaykum, ${firstName}! 🌟\nBotimizga xush kelibsiz.\n\n📞 Ro'yxatdan o'tish uchun pastdagi tugma orqali kontaktingizni ulashing:`,
                Markup.keyboard([
                    [Markup.button.contactRequest('📞 Kontaktni ulash')]
                ]).resize().oneTime()
            );
        }

        if (!result.rows[0].full_name) {
            userSessions.set(telegramId, { step: 'WAIT_FIO' });
            return await ctx.reply(
                '✍️ Iltimos, Ism va Familiyangizni yozib yuboring:',
                Markup.removeKeyboard()
            );
        }

        userSessions.set(telegramId, { step: 'MAIN_MENU' });
        await showMainMenu(ctx);
    } catch (err) {
        console.error('[/start log]:', err.message);
        await ctx.reply('⚠️ Iltimos, /start tugmasini qaytadan bosing.');
    }
});

// =========================================================
// 2-QADAM: KONTAKT QABUL QILISH -> F.I.O SO'RASH
// =========================================================
bot.on('contact', async (ctx) => {
    try {
        const telegramId = ctx.from.id;
        const phone = ctx.message.contact.phone_number;
        const firstName = ctx.from.first_name || '';
        const username = ctx.from.username || '';

        userSessions.set(telegramId, { step: 'WAIT_FIO' });

        await Promise.all([
            pool.query(
                `INSERT INTO users (telegram_id, first_name, username, phone, balance, step) 
                 VALUES ($1, $2, $3, $4, 0.00, 'WAIT_FIO') 
                 ON CONFLICT (telegram_id) 
                 DO UPDATE SET first_name = $2, username = $3, phone = $4, step = 'WAIT_FIO'`,
                [telegramId, firstName, username, phone]
            ),
            ctx.reply(
                '✅ Kontaktingiz qabul qilindi!\n\n✍️ Endi Ism va Familiyangizni kiriting:',
                Markup.removeKeyboard()
            )
        ]);
    } catch (error) {
        console.error('[contact log]:', error.message);
    }
});

// =========================================================
// ASOSIY MENYU
// =========================================================
async function showMainMenu(ctx) {
    try {
        await ctx.reply(
            '📋 <b>Asosiy menyu</b>\n' +
            '📥 <b>Video yuklash — MUTLAQO BEPUL!</b>\n' +
            '🚀 Ijtimoiy tarmoqlar uchun xizmat turini tanlang:',
            {
                parse_mode: 'HTML',
                ...Markup.keyboard([
                    ['📥 Video yuklash (Bepul)', '📸 Instagram'],
                    ['📺 YouTube', '📘 Facebook'],
                    ['💰 Balans', '📦 Buyurtmalarim', '🌐 Web ilova']
                ]).resize()
            }
        );
    } catch (err) {
        console.error('[showMainMenu log]:', err.message);
    }
}

// =========================================================
// 📥 BEPUL VIDEO YUKLASH BO'LIMI (Instagram, YouTube, Facebook)
// =========================================================
bot.hears(['📥 Video yuklash', '📥 Video yuklash (Bepul)'], async (ctx) => {
    try {
        userSessions.set(ctx.from.id, { step: 'WAIT_DOWNLOAD_LINK' });
        await ctx.reply(
            '📥 <b>Video Yuklab Olish (100% BEPUL)</b>\n\n' +
            '🔗 <b>Instagram, YouTube yoki Facebook</b> video havolasini yuboring:\n' +
            '<i>Bot videoni toza sifatda yuklab beradi. Tagida esa faqat musiqani yuklab olish tugmasi chiqadi!</i>',
            { parse_mode: 'HTML' }
        );
    } catch (err) {
        console.error('[video menu log]:', err.message);
    }
});

// =========================================================
// XIZMATLAR BO'LIMI (PULLIK XIZMATLAR RO'YXATI VA NARXLARI)
// =========================================================

// 1. Instagram
bot.hears(['📸 Instagram', '🚀 Instagram'], async (ctx) => {
    try {
        if (await checkPendingReceiptAndAlert(ctx)) return;
        await ctx.reply(
            '📸 <b>Instagram xizmatlari (Pullik):</b>\n\n' +
            '👁 <b>Ko\'rishlar (100 ta)</b> — 1 000 so\'m\n' +
            '❤️ <b>Layklar (50 ta)</b> — 2 000 so\'m\n' +
            '👥 <b>Obunachilar (10 ta)</b> — 3 000 so\'m\n\n' +
            'Kerakli xizmatni tanlang:',
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('👁 Ko\'rishlar (+100) — 1,000 so\'m', 'srv_ig_views')],
                    [Markup.button.callback('❤️ Layklar (+50) — 2,000 so\'m', 'srv_ig_likes')],
                    [Markup.button.callback('👥 Obunachilar (+10) — 3,000 so\'m', 'srv_ig_followers')],
                    [Markup.button.callback('📥 Videoni bepul yuklab olish', 'mode_ig_download')]
                ])
            }
        );
    } catch (err) {
        console.error('[ig menu log]:', err.message);
    }
});

// 2. YouTube
bot.hears('📺 YouTube', async (ctx) => {
    try {
        if (await checkPendingReceiptAndAlert(ctx)) return;
        await ctx.reply(
            '📺 <b>YouTube xizmatlari (Pullik):</b>\n\n' +
            '👁 <b>Ko\'rishlar (50 ta)</b> — 2 000 so\'m\n' +
            '👥 <b>Obunachilar (10 ta)</b> — 2 000 so\'m\n' +
            '❤️ <b>Layklar (10 ta)</b> — 2 000 so\'m\n\n' +
            'Kerakli xizmatni tanlang:',
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('👁 Ko\'rishlar (+50) — 2,000 so\'m', 'srv_yt_views')],
                    [Markup.button.callback('👥 Obunachilar (+10) — 2,000 so\'m', 'srv_yt_subscribers')],
                    [Markup.button.callback('❤️ Layklar (+10) — 2,000 so\'m', 'srv_yt_likes')],
                    [Markup.button.callback('📥 Videoni bepul yuklab olish', 'mode_yt_download')]
                ])
            }
        );
    } catch (err) {
        console.error('[yt menu log]:', err.message);
    }
});

// 3. Facebook
bot.hears('📘 Facebook', async (ctx) => {
    try {
        if (await checkPendingReceiptAndAlert(ctx)) return;
        await ctx.reply(
            '📘 <b>Facebook xizmatlari (Pullik):</b>\n\n' +
            '👁 <b>Video Ko\'rishlar (100 ta)</b> — 1 500 so\'m\n' +
            '👍 <b>Post Layklar (10 ta)</b> — 1 500 so\'m\n\n' +
            'Kerakli xizmatni tanlang:',
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('👁 Video Ko\'rishlar (+100) — 1,500 so\'m', 'srv_fb_views')],
                    [Markup.button.callback('👍 Post Layklar (+10) — 1,500 so\'m', 'srv_fb_likes')],
                    [Markup.button.callback('📥 Videoni bepul yuklab olish', 'mode_fb_download')]
                ])
            }
        );
    } catch (err) {
        console.error('[fb menu log]:', err.message);
    }
});

bot.action(['mode_ig_download', 'mode_yt_download', 'mode_fb_download'], async (ctx) => {
    try {
        userSessions.set(ctx.from.id, { step: 'WAIT_DOWNLOAD_LINK' });
        ctx.answerCbQuery().catch(() => {});
        await ctx.reply('🔗 <b>Instagram, YouTube yoki Facebook video havolasini yuboring (100% Bepul):</b>', { parse_mode: 'HTML' });
    } catch (err) {
        console.error('[mode_download log]:', err.message);
    }
});

// Xizmat tanlanganda (Balans tekshiruvi va Havola so'rash)
bot.action(/^srv_([a-z]+)_([a-z]+)$/, async (ctx) => {
    try {
        if (await checkPendingReceiptAndAlert(ctx)) return;
        const serviceKey = `${ctx.match[1]}_${ctx.match[2]}`;
        const service = SERVICES_CONFIG[serviceKey];

        if (!service) {
            ctx.answerCbQuery('Xizmat topilmadi').catch(() => {});
            return;
        }

        ctx.answerCbQuery().catch(() => {});
        const telegramId = ctx.from.id;

        // Foydalanuvchi balansini tekshiramiz
        const userRes = await pool.query('SELECT balance FROM users WHERE telegram_id = $1', [telegramId]);
        const balance = userRes.rows.length > 0 ? parseFloat(userRes.rows[0].balance) : 0;

        if (balance < service.price) {
            return await ctx.reply(
                `❌ <b>Balansingizda mablag' yetarli emas!</b>\n\n` +
                `📦 <b>Xizmat:</b> ${escapeHtml(service.name)}\n` +
                `💵 <b>Xizmat narxi:</b> ${service.price.toLocaleString('uz-UZ')} so'm\n` +
                `💰 <b>Sizning balansingiz:</b> ${balance.toLocaleString('uz-UZ')} so'm\n\n` +
                `<i>Xizmatdan foydalanish uchun iltimos hisobingizni to'ldiring:</i>`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('💳 Hisobni to\'ldirish', 'open_topup_info')]
                    ])
                }
            );
        }

        userSessions.set(telegramId, {
            step: 'WAIT_PAID_LINK',
            serviceKey: serviceKey,
            service: service
        });

        let linkPrompt = `🔗 Marhamat, ${escapeHtml(service.platform.toUpperCase())} video yoki profil havolasini yuboring:`;
        if (serviceKey === 'yt_subscribers') {
            linkPrompt = `🔗 <b>YouTube kanal havolasini yuboring:</b>\n<i>Masalan: https://www.youtube.com/@kanalingiz</i>`;
        } else if (serviceKey === 'yt_views' || serviceKey === 'yt_likes') {
            linkPrompt = `🔗 <b>YouTube video yoki Shorts havolasini yuboring:</b>\n<i>Masalan: https://youtu.be/... yoki https://youtube.com/watch?v=...</i>`;
        } else if (serviceKey === 'fb_views') {
            linkPrompt = `🔗 <b>Facebook video yoki reel havolasini yuboring:</b>\n<i>Masalan: https://www.facebook.com/watch/?v=...</i>`;
        } else if (serviceKey === 'fb_likes') {
            linkPrompt = `🔗 <b>Facebook post havolasini yuboring:</b>\n<i>Masalan: https://www.facebook.com/.../posts/...</i>`;
        }

        await ctx.reply(
            `✅ <b>Tanlangan xizmat:</b> ${escapeHtml(service.name)}\n` +
            `🔢 <b>Miqdori:</b> +${service.qty} ta\n` +
            `💵 <b>Narxi:</b> ${service.price.toLocaleString('uz-UZ')} so'm\n` +
            `💰 <b>Balansingiz:</b> ${balance.toLocaleString('uz-UZ')} so'm\n\n` +
            linkPrompt,
            { parse_mode: 'HTML' }
        );
    } catch (err) {
        console.error('[srv select log]:', err.message);
    }
});

// To'g'ridan-to'g'ri yuborilgan havola uchun xizmat tanlanganda (YouTube / Facebook)
bot.action(/^direct_([a-z]+)_([a-z]+)$/, async (ctx) => {
    try {
        if (await checkPendingReceiptAndAlert(ctx)) return;
        const serviceKey = `${ctx.match[1]}_${ctx.match[2]}`;
        const service = SERVICES_CONFIG[serviceKey];
        const session = userSessions.get(ctx.from.id);

        if (!service || !session || !session.link) {
            ctx.answerCbQuery().catch(() => {});
            return await ctx.reply('⚠️ Havola topilmadi. Iltimos, havolani qaytadan yuboring.');
        }

        const link = session.link;
        userSessions.set(ctx.from.id, { step: 'MAIN_MENU' });
        ctx.answerCbQuery().catch(() => {});

        // Foydalanuvchi balansini tekshiramiz
        const userRes = await pool.query('SELECT balance FROM users WHERE telegram_id = $1', [ctx.from.id]);
        const balance = userRes.rows.length > 0 ? parseFloat(userRes.rows[0].balance) : 0;

        if (balance < service.price) {
            return await ctx.reply(
                `❌ <b>Balansingizda mablag' yetarli emas!</b>\n\n` +
                `📦 <b>Xizmat:</b> ${escapeHtml(service.name)}\n` +
                `💵 <b>Xizmat narxi:</b> ${service.price.toLocaleString('uz-UZ')} so'm\n` +
                `💰 <b>Sizning balansingiz:</b> ${balance.toLocaleString('uz-UZ')} so'm\n\n` +
                `<i>Xizmatdan foydalanish uchun iltimos hisobingizni to'ldiring:</i>`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('💳 Hisobni to\'ldirish', 'open_topup_info')]
                    ])
                }
            );
        }

        await executePaidSmmOrder(ctx, link, service);
    } catch (err) {
        console.error('[direct action error]:', err.message);
    }
});

// To'g'ridan-to'g'ri havoladan bepul video yuklab olish
bot.action(/^free_dl_([a-z]+)$/, async (ctx) => {
    try {
        const session = userSessions.get(ctx.from.id);
        if (!session || !session.link) {
            ctx.answerCbQuery().catch(() => {});
            return await ctx.reply('⚠️ Havola topilmadi. Iltimos, havolani qaytadan yuboring.');
        }
        const link = session.link;
        userSessions.set(ctx.from.id, { step: 'MAIN_MENU' });
        ctx.answerCbQuery().catch(() => {});
        await handleFreeVideoDownload(ctx, link);
    } catch (err) {
        console.error('[free_dl action error]:', err.message);
    }
});

// =========================================================
// 💰 TO'LOV TIZIMI (KARTA KO'RSATISH VA CHEKNI QABUL QILISH)
// =========================================================
bot.hears('💰 Balans', async (ctx) => {
    try {
        const result = await pool.query('SELECT balance, full_name FROM users WHERE telegram_id = $1', [ctx.from.id]);
        const balance = result.rows.length > 0 ? Number(result.rows[0].balance).toLocaleString('uz-UZ') : '0';
        const fullName = (result.rows.length > 0 && result.rows[0].full_name)
            ? result.rows[0].full_name
            : (ctx.from.first_name || 'Foydalanuvchi');

        await ctx.reply(
            `👤 <b>${escapeHtml(fullName)}</b>\n` +
            `💰 Joriy balansingiz: <b>${balance} so'm</b>\n\n` +
            `<i>Barcha xizmatlar (ko'rishlar, layklar, obunachilar) uchun to'lov balansingizdan yechiladi.</i>`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Hisobni to\'ldirish (Karta)', 'open_topup_info')],
                    [Markup.button.callback('📦 Buyurtmalarim', 'open_my_orders')]
                ])
            }
        );
    } catch (err) {
        console.error('[Balans log]:', err.message);
    }
});

bot.action(['open_topup_info', 'open_payment'], async (ctx) => {
    try {
        if (await checkPendingReceiptAndAlert(ctx)) return;
        ctx.answerCbQuery().catch(() => {});
        userSessions.set(ctx.from.id, { step: 'WAIT_RECEIPT' });

        const adminCard = process.env.ADMIN_CARD || '9860 1766 2185 8958';
        const cardHolder = process.env.ADMIN_CARD_HOLDER || 'Jonibek';
        const minAmount = parseInt(process.env.MIN_TOPUP_AMOUNT, 10) || 5000;

        await ctx.reply(
            `💳 <b>Hisobni to'ldirish (To'lov tizimi)</b>\n\n` +
            `Quyidagi karta raqamiga to'lovni amalga oshiring:\n\n` +
            `💳 <code>${adminCard}</code>\n` +
            `👤 Qabul qiluvchi: <b>${escapeHtml(cardHolder)}</b>\n` +
            `💵 Minimal to'lov: <b>${minAmount.toLocaleString('uz-UZ')} so'm</b>\n\n` +
            `📸 <b>To'lovni amalga oshirgach, to'lov cheki (kvitansiya) rasmini shu yerga yuboring!</b>\n` +
            `<i>To'lov chekingiz admin tomonidan tekshirilib, hisobingizga bir zumda pul qo'shiladi.</i>`,
            { parse_mode: 'HTML' }
        );
    } catch (err) {
        console.error('[open_topup_info log]:', err.message);
    }
});

// =========================================================
// 🛡️ XAVFSIZ CHEKNI TEKSHIRISH HANDLERI (Photo qabul qilish)
// =========================================================
bot.on('photo', async (ctx) => {
    try {
        const telegramId = ctx.from.id;

        // 1. Agar foydalanuvchida allaqachon ko'rib chiqilayotgan (pending) chek bo'lsa — bloklaymiz!
        const pendingCheck = await pool.query(
            "SELECT id FROM receipts WHERE telegram_id = $1 AND status = 'pending' LIMIT 1",
            [telegramId]
        );
        if (pendingCheck.rows.length > 0) {
            return await ctx.reply(
                `⏳ <b>Sizda allaqachon tekshirilayotgan to'lov cheki mavjud (#${pendingCheck.rows[0].id})!</b>\n\n` +
                `Iltimos, avvalgi to'lovingiz administrator tomonidan tasdiqlanishini kuting. ` +
                `Admin tasdiqlashi bilan balansingiz to'ldiriladi va barcha xizmatlar avtomatik ochiladi!`,
                { parse_mode: 'HTML' }
            );
        }

        const photos = ctx.message.photo;
        const highestPhoto = photos[photos.length - 1]; // Eng yuqori sifatli rasm
        const fileUniqueId = highestPhoto.file_unique_id;

        // 2. XAVFSIZLIK: Takroriy chek (Replay attack) tekshiruvi!
        const existingReceipt = await pool.query(
            'SELECT id, amount, created_at FROM receipts WHERE file_unique_id = $1',
            [fileUniqueId]
        );

        if (existingReceipt.rows.length > 0) {
            return await ctx.reply(
                '❌ <b>Xavfsizlik xatosi:</b> Ushbu to\'lov cheki avval hisobga olingan yoki yuborilgan!\n' +
                'Takroriy yoki soxta cheklar qabul qilinmaydi.',
                { parse_mode: 'HTML' }
            );
        }

        const waitingMsg = await ctx.reply(
            '⏳ <i>To\'lov cheki qabul qilinmoqda va adminga yuborilmoqda, iltimos kuting...</i>',
            { parse_mode: 'HTML' }
        );

        // 3. Bazaga kutilayotgan chek sifatida saqlaymiz (status = 'pending')
        const insertRes = await pool.query(
            `INSERT INTO receipts (telegram_id, file_id, file_unique_id, amount, status)
             VALUES ($1, $2, $3, 0.00, 'pending')
             RETURNING id`,
            [telegramId, highestPhoto.file_id, fileUniqueId]
        );
        const receiptId = insertRes.rows[0].id;

        // 4. Foydalanuvchi ma'lumotlarini olamiz
        const userRes = await pool.query('SELECT full_name, username FROM users WHERE telegram_id = $1', [telegramId]);
        const fullName = (userRes.rows[0] && userRes.rows[0].full_name) || ctx.from.first_name || 'Foydalanuvchi';
        const username = (userRes.rows[0] && userRes.rows[0].username) || ctx.from.username || '';

        // 5. Rasm buferini xavfsiz yuklab olamiz (Telegram HTTP URL xatosini oldini olish uchun)
        let photoBuffer = null;
        try {
            const fileLink = await ctx.telegram.getFileLink(highestPhoto.file_id);
            const resp = await axios.get(fileLink.href || fileLink.toString(), {
                responseType: 'arraybuffer',
                timeout: 15000
            });
            photoBuffer = resp.data;
        } catch (dlErr) {
            console.error('Download photo buffer error:', dlErr.message);
        }

        // 6. Maxsus Admin botga yuboramiz (@ad_minakrutkabot)
        await forwardReceiptToAdmin({
            receiptId,
            telegramId,
            fullName,
            username,
            fileId: highestPhoto.file_id,
            photoBuffer,
            caption: ctx.message.caption || ''
        });

        userSessions.set(telegramId, { step: 'PENDING_RECEIPT' });

        // 7. Foydalanuvchiga tasdiq xabari
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            waitingMsg.message_id,
            undefined,
            `⏳ <b>To'lov chekingiz qabul qilindi va administratorga yuborildi!</b>\n\n` +
            `🧾 <b>Chek raqami:</b> #${receiptId}\n` +
            `🕒 <b>Vaqt:</b> ${new Date().toLocaleString('uz-UZ')}\n\n` +
            `<i>Administrator chekni tekshirib tasdiqlashi bilan hisobingizga mablag' qo'shiladi va barcha pullik xizmatlar avtomatik ochiladi. Iltimos, ozgina kuting...</i>`,
            { parse_mode: 'HTML' }
        );
    } catch (error) {
        console.error('[Photo handler error]:', error.message);
        await ctx.reply('⚠️ Chekni qayta ishlashda xatolik bo\'ldi. Iltimos, qaytadan yuboring.');
    }
});

bot.action('open_balance_btn', async (ctx) => {
    try {
        ctx.answerCbQuery().catch(() => {});
        const result = await pool.query('SELECT balance, full_name FROM users WHERE telegram_id = $1', [ctx.from.id]);
        const balance = result.rows.length > 0 ? Number(result.rows[0].balance).toLocaleString('uz-UZ') : '0';
        const fullName = (result.rows.length > 0 && result.rows[0].full_name)
            ? result.rows[0].full_name
            : (ctx.from.first_name || 'Foydalanuvchi');

        await ctx.reply(
            `👤 <b>${escapeHtml(fullName)}</b>\n` +
            `💰 Joriy balansingiz: <b>${balance} so'm</b>\n\n` +
            `<i>Barcha xizmatlar uchun to'lov balansingizdan yechiladi.</i>`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Hisobni to\'ldirish (Karta)', 'open_topup_info')],
                    [Markup.button.callback('📦 Buyurtmalarim', 'open_my_orders')]
                ])
            }
        );
    } catch (err) {
        console.error('[open_balance_btn error]:', err.message);
    }
});

bot.action('open_ig_menu', async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
        '📸 <b>Instagram xizmatini tanlang:</b>',
        Markup.inlineKeyboard([
            [Markup.button.callback('👁 Ko\'rishlar (+100) — 1,000 so\'m', 'srv_ig_views')],
            [Markup.button.callback('❤️ Layklar (+50) — 2,000 so\'m', 'srv_ig_likes')],
            [Markup.button.callback('👥 Obunachilar (+10) — 3,000 so\'m', 'srv_ig_followers')]
        ])
    );
});

// =========================================================
// 🎵 MUSIQA YUKLAB OLISH HANDLERI (FAQAT SHU TUGMA BO'LADI!)
// =========================================================
bot.action(/^dl_audio_([a-zA-Z0-9_-]+)$/, async (ctx) => {
    try {
        const audioId = ctx.match[1];
        ctx.answerCbQuery('🎵 Musiqa yuklanmoqda...').catch(() => {});

        let info = getAudioInfo(audioId);

        // Agar bot qayta ishga tushgan bo'lsa va xotiradan o'chgan bo'lsa (Instagram fallback):
        if (!info && (audioId.startsWith('ig_') || !audioId.includes('_'))) {
            const shortcode = audioId.replace('ig_', '');
            const igInfo = await fetchFromInstagramEmbed(shortcode);
            if (igInfo && igInfo.videoUrl) {
                info = {
                    audioUrl: igInfo.videoUrl,
                    title: igInfo.music || `Instagram Audio (${shortcode})`,
                    performer: igInfo.author ? `@${igInfo.author}` : 'Instagram'
                };
            }
        }

        if (!info || !info.audioUrl) {
            return await ctx.reply('⚠️ Musiqani yuklab bo\'lmadi yoki havola muddati tugagan.');
        }

        await ctx.sendChatAction('upload_voice');

        const title = info.title ? info.title : 'Audio';
        const performer = info.performer ? info.performer : 'Musiqa';

        try {
            await ctx.replyWithAudio(info.audioUrl, {
                title: title,
                performer: performer,
                caption: `🎵 <b>Musiqa:</b> ${escapeHtml(title)}\n👤 <b>Ijrochi:</b> ${escapeHtml(performer)}`,
                parse_mode: 'HTML'
            });
        } catch (audioSendErr) {
            console.warn('[replyWithAudio URL error, trying buffer]:', audioSendErr.message);
            const audioResp = await axios.get(info.audioUrl, {
                responseType: 'arraybuffer',
                timeout: 20000
            });
            await ctx.replyWithAudio({ source: Buffer.from(audioResp.data), filename: `${title}.mp3` }, {
                title: title,
                performer: performer,
                caption: `🎵 <b>Musiqa:</b> ${escapeHtml(title)}\n👤 <b>Ijrochi:</b> ${escapeHtml(performer)}`,
                parse_mode: 'HTML'
            });
        }
    } catch (err) {
        console.error('[dl_audio log]:', err.message);
        await ctx.reply('⚠️ Musiqani yuklashda xatolik yuz berdi.');
    }
});

// =========================================================
// 📥 BEPUL VIDEO YUKLASH FUNKSIYASI (Instagram, YouTube, Facebook)
// (Inline tugmada FAQAT "🎵 Musiqani yuklab olish" chiqadi!)
// =========================================================
async function handleFreeVideoDownload(ctx, targetUrl) {
    let waitingMsg;
    try {
        waitingMsg = await ctx.reply('⏳ <i>Video yuklanmoqda, iltimos kuting...</i>', { parse_mode: 'HTML' });
    } catch (_) {}

    const dlResult = await downloadUniversalVideo(targetUrl);

    if (!dlResult || !dlResult.success || !dlResult.videoUrl) {
        const errorText = '⚠️ <b>Videoni yuklab bo\'lmadi.</b>\nProfil yoki video yopiq bo\'lishi mumkin, iltimos ochiq video havolasini yuboring.';
        if (waitingMsg) {
            return await ctx.telegram.editMessageText(ctx.chat.id, waitingMsg.message_id, undefined, errorText, { parse_mode: 'HTML' }).catch(() => ctx.reply(errorText, { parse_mode: 'HTML' }));
        } else {
            return await ctx.reply(errorText, { parse_mode: 'HTML' });
        }
    }

    let captionHtml = '';
    if (dlResult.platform === 'instagram') {
        captionHtml =
            `🎬 <b>Instagram Video</b>\n` +
            `👤 <b>Muallif:</b> @${escapeHtml(dlResult.author || 'Instagram')}\n` +
            (dlResult.views ? `👁 <b>Ko'rishlar:</b> ${dlResult.views}\n` : '') +
            (dlResult.likes ? `❤️ <b>Layklar:</b> ${dlResult.likes}\n` : '') +
            (dlResult.music ? `🎵 <b>Musiqa:</b> <i>${escapeHtml(dlResult.music)}</i>` : '');
    } else if (dlResult.platform === 'youtube') {
        captionHtml =
            `🎬 <b>YouTube:</b> ${escapeHtml(dlResult.title || 'Video')}\n` +
            `👤 <b>Kanal:</b> ${escapeHtml(dlResult.author || 'YouTube')}`;
    } else if (dlResult.platform === 'facebook') {
        captionHtml =
            `🎬 <b>Facebook Video</b>\n` +
            `👤 <b>Manba:</b> Facebook`;
    }

    const audioButton = Markup.inlineKeyboard([
        [Markup.button.callback('🎵 Musiqani yuklab olish (MP3)', `dl_audio_${dlResult.audioId}`)]
    ]);

    // Videoni yuborish (Avval URL orqali, agar Telegram qabul qilmasa — buffer orqali)
    try {
        await ctx.replyWithVideo(dlResult.videoUrl, {
            caption: captionHtml,
            parse_mode: 'HTML',
            ...audioButton
        });
    } catch (sendErr) {
        console.warn('[replyWithVideo URL failed, trying buffer]:', sendErr.message);
        try {
            const videoResp = await axios.get(dlResult.videoUrl, {
                responseType: 'arraybuffer',
                timeout: 30000,
                maxContentLength: 50 * 1024 * 1024 // 50MB
            });
            await ctx.replyWithVideo({ source: Buffer.from(videoResp.data) }, {
                caption: captionHtml,
                parse_mode: 'HTML',
                ...audioButton
            });
        } catch (bufErr) {
            console.error('[Video buffer send error]:', bufErr.message);
            return await ctx.reply('⚠️ Video hajmi juda katta yoki yuklab bo\'lmadi.');
        }
    }

    if (waitingMsg) {
        ctx.telegram.deleteMessage(ctx.chat.id, waitingMsg.message_id).catch(() => {});
    }

    // Bepul buyurtma sifatida bazaga yozish
    const telegramId = ctx.from.id;
    const username = ctx.from.username || 'foydalanuvchi';
    const fullName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || 'Foydalanuvchi';

    pool.query(
        `INSERT INTO orders (
            telegram_id, username, full_name, platform, service_id, service_name, link, quantity, price, status, smm_order_id
        ) VALUES ($1, $2, $3, $4, 500, $5, $6, 1, 0.00, 'done', $7)`,
        [telegramId, username, fullName, dlResult.platform, `${dlResult.platform.toUpperCase()} Video Yuklash (Bepul)`, targetUrl, dlResult.audioId]
    ).catch((err) => console.error('[DB bg log]:', err.message));
}

// Qadimgi funksiya nomi bilan moslik
const handleFreeInstagramVideoDownload = handleFreeVideoDownload;

// =========================================================
// 🚀 PULLIK XIZMATNI ISHGA TUSHIRISH (Instagram, YouTube, Facebook)
// =========================================================
async function executePaidSmmOrder(ctx, link, service) {
    const telegramId = ctx.from.id;

    // 1. XAVFSIZLIK: Atomik tarzda balansni tekshirish va mablag'ni yechish!
    const deductRes = await pool.query(
        'UPDATE users SET balance = balance - $1 WHERE telegram_id = $2 AND balance >= $1 RETURNING balance',
        [service.price, telegramId]
    );

    if (deductRes.rows.length === 0) {
        const userRes = await pool.query('SELECT balance FROM users WHERE telegram_id = $1', [telegramId]);
        const balance = userRes.rows.length > 0 ? parseFloat(userRes.rows[0].balance) : 0;
        return await ctx.reply(
            `❌ <b>Mablag' yetarli emas!</b>\n\n` +
            `📦 <b>Xizmat:</b> ${escapeHtml(service.name)}\n` +
            `💵 <b>Narxi:</b> ${service.price.toLocaleString('uz-UZ')} so'm\n` +
            `💰 <b>Balansingiz:</b> ${balance.toLocaleString('uz-UZ')} so'm\n\n` +
            `Iltimos, hisobingizni to'ldiring:`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Hisobni to\'ldirish', 'open_topup_info')]
                ])
            }
        );
    }

    const remainingBal = Number(deductRes.rows[0].balance).toLocaleString('uz-UZ');

    // DUPLICATE CHECK: Bir xil link + service allaqachon processing bo'lsa bloklash
    const dupCheck = await pool.query(
        `SELECT id FROM orders 
         WHERE telegram_id = $1 AND service_id = $2 AND link = $3 AND status = 'processing' 
         LIMIT 1`,
        [telegramId, service.id, link]
    );
    if (dupCheck.rows.length > 0) {
        await pool.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = $2', [service.price, telegramId]);
        return await ctx.reply(
            `⏳ <b>Bu link uchun buyurtma allaqachon bajarilmoqda!</b>\n\n` +
            `📦 <b>Buyurtma raqami:</b> #${dupCheck.rows[0].id}\n` +
            `<i>Xizmat tugashi bilan sizga xabar yetkaziladi. Boshqa link uchun yangi buyurtma bera olasiz.</i>`,
            { parse_mode: 'HTML' }
        );
    }

    const waitingMsg = await ctx.reply(
        `⏳ <i>${escapeHtml(service.name)} (+${service.qty} ta) buyurtmasi yuborilmoqda...</i>`,
        { parse_mode: 'HTML' }
    );

    // Agar Instagram Followers bo'lsa va video link tashlangan bo'lsa, profil linkini avtomatik ajratamiz
    let targetLink = link;
    if (service.id === 108) {
        const shortcode = extractInstagramShortcode(link);
        if (shortcode) {
            const info = await fetchFromInstagramEmbed(shortcode);
            if (info && info.author && info.author !== 'instagram') {
                targetLink = `https://www.instagram.com/${info.author}/`;
            }
        }
    }

    // 2. Tranzaksiyalar jadvaliga chiqimni yozamiz
    await pool.query(
        `INSERT INTO transactions (telegram_id, amount, type, click_trans_id, status)
         VALUES ($1, $2, 'payment', $3, 'paid')`,
        [telegramId, service.price, `ORDER-PAY-${Date.now()}`]
    );

    // 3. NawabSMM API ga buyurtma yuboramiz
    const smmResult = await createNawabOrder(service.id, service.qty, targetLink);

    // Agar SMM server buyurtmani qabul qilmasa — pulni qaytarib beramiz!
    if (!smmResult.success) {
        await pool.query(
            'UPDATE users SET balance = balance + $1 WHERE telegram_id = $2',
            [service.price, telegramId]
        );

        // "already in work" xatosi uchun maxsus user-friendly xabar
        const errMsg = (smmResult.error || '').toLowerCase();
        const isAlreadyInWork = errMsg.includes('already in work') || errMsg.includes('in work');
        const isDuplicate = errMsg.includes('duplicate') || errMsg.includes('already ordered');

        let userText;
        if (isAlreadyInWork || isDuplicate) {
            userText =
                `⏳ <b>Bu link hozirda boshqa buyurtma tomonidan band!</b>\n\n` +
                `<i>NawabSMM serveri ushbu link ustida allaqachon ishlayapti. ` +
                `Biroz kutib (10-15 daqiqa), yangi buyurtma bera olasiz.</i>\n\n` +
                `💵 <b>To'langan ${service.price.toLocaleString('uz-UZ')} so'm balansingizga qaytarildi!</b>`;
        } else {
            userText =
                `⚠️ <b>Buyurtma yuborishda xatolik yuz berdi.</b>\n` +
                `<i>Server vaqtinchalik ishlamayapti. Iltimos, biroz kutib qayta urinib ko'ring.</i>\n\n` +
                `💵 <b>To'langan ${service.price.toLocaleString('uz-UZ')} so'm balansingizga qaytarildi!</b>`;
        }

        if (errMsg.includes('out of balance') || errMsg.includes('balance')) {
            const adminId = process.env.ADMIN_TELEGRAM_ID;
            if (adminId && adminBot) {
                adminBot.telegram.sendMessage(
                    adminId,
                    `🚨 <b>DIQQAT ADMIN: NAWABSMM BALANSI TUGADI!</b>\n\n` +
                    `Foydalanuvchi buyurtma bermoqchi bo'ldi, lekin SMM panel balansingiz yetarli emas.\n` +
                    `📦 Xizmat: <b>${escapeHtml(service.name)}</b>\n\n` +
                    `👉 Buyurtmalar uzluksiz o'tishi uchun <a href="https://nawabsmm.com">nawabsmm.com</a> hisobingizni to'ldiring ($1-$2)!`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
            }
        }

        return await ctx.telegram.editMessageText(
            ctx.chat.id,
            waitingMsg.message_id,
            undefined,
            userText,
            { parse_mode: 'HTML' }
        );
    }

    // 4. Orders jadvaliga saqlaymiz
    const username = ctx.from.username || 'foydalanuvchi';
    const fullName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || 'Foydalanuvchi';

    const dbRes = await pool.query(
        `INSERT INTO orders (
            telegram_id, username, full_name, platform, service_id, service_name, link, quantity, price, status, smm_order_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
        [
            telegramId,
            username,
            fullName,
            service.platform,
            service.id,
            service.name,
            targetLink,
            service.qty,
            service.price,
            'processing',
            smmResult.orderId || null
        ]
    );
    const savedOrder = dbRes.rows[0];

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        waitingMsg.message_id,
        undefined,
        `✅ <b>Buyurtmangiz qabul qilindi va ishga tushirildi!</b>\n\n` +
        `🧾 <b>Buyurtma raqami:</b> #${savedOrder.id}\n` +
        `📦 <b>Xizmat:</b> ${escapeHtml(service.name)}\n` +
        `🔢 <b>Miqdori:</b> +${service.qty} ta\n` +
        `💵 <b>To'landi:</b> ${service.price.toLocaleString('uz-UZ')} so'm\n` +
        `💰 <b>Qolgan balansingiz:</b> ${remainingBal} so'm\n` +
        `⚡ <b>Boshlanish vaqti:</b> ${service.speed || '0 - 10 daqiqa'}\n` +
        `📊 <b>Holati:</b> 🚀 Bajarilmoqda\n\n` +
        `<i>Xizmat serverda navbatga qo'yildi va tez orada ko'rinadi!</i>`,
        { parse_mode: 'HTML', disable_web_page_preview: true }
    );
}

// =========================================================
// BUYURTMALARIM BO'LIMI
// =========================================================
bot.hears('📦 Buyurtmalarim', async (ctx) => {
    try {
        const res = await pool.query(
            'SELECT id, service_name, quantity, price, status FROM orders WHERE telegram_id = $1 ORDER BY id DESC LIMIT 5',
            [ctx.from.id]
        );

        if (res.rows.length === 0) {
            return await ctx.reply('📭 Sizda hozircha buyurtmalar mavjud emas.');
        }

        let text = '📦 <b>Oxirgi buyurtmalaringiz:</b>\n\n';
        for (const row of res.rows) {
            const cleanName = String(row.service_name || 'Xizmat')
                .replace(/\(ID:\s*\d+\)/gi, '')
                .trim();
            const statusLabel = row.status === 'done' ? '✅ Bajarildi' : '🚀 Bajarilmoqda';
            const priceText = parseFloat(row.price) > 0 ? `${parseFloat(row.price).toLocaleString('uz-UZ')} so'm` : 'Bepul';
            text += `🔹 <b>#${row.id}</b> — ${escapeHtml(cleanName)}\n`;
            text += `   Miqdor: +${row.quantity} ta | To'lov: ${priceText} | ${statusLabel}\n\n`;
        }

        await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (err) {
        console.error('[Buyurtmalarim log]:', err.message);
    }
});

bot.action('open_my_orders', async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const res = await pool.query(
        'SELECT id, service_name, quantity, status FROM orders WHERE telegram_id = $1 ORDER BY id DESC LIMIT 5',
        [ctx.from.id]
    );
    if (res.rows.length === 0) {
        return await ctx.reply('📭 Sizda hozircha buyurtmalar mavjud emas.');
    }
    let text = '📦 <b>Oxirgi buyurtmalaringiz:</b>\n\n';
    for (const row of res.rows) {
        const statusLabel = row.status === 'done' ? '✅ Bajarildi' : '🚀 Bajarilmoqda';
        text += `🔹 <b>#${row.id}</b> — ${escapeHtml(row.service_name)} | ${statusLabel}\n`;
    }
    await ctx.reply(text, { parse_mode: 'HTML' });
});

bot.hears(['🌐 Web ilova', '🌐 Bot Web orqali', '🌐 Web App ochish'], async (ctx) => {
    try {
        const webAppUrl = process.env.WEB_APP_URL || 'https://google.com';
        await ctx.reply(
            '🌐 <b>Web ilovaga kirish uchun tugmani bosing:</b>',
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.webApp('🌐 Ochish', webAppUrl)]
                ])
            }
        );
    } catch (err) {
        console.error('[webapp log]:', err.message);
    }
});

// =========================================================
// ASOSIY TEXT HANDLER (F.I.O, VIDEO YUKLASH, PULLIK BUYURTMA)
// =========================================================
bot.on('text', async (ctx) => {
    try {
        const telegramId = ctx.from.id;
        const rawText = ctx.message.text.trim();
        const session = userSessions.get(telegramId) || {};

        const extractedLink = extractUrl(rawText);
        const isUrl = rawText.includes('http://') || rawText.includes('https://') || rawText.includes('instagram.com') || rawText.includes('youtube.com') || rawText.includes('youtu.be') || rawText.includes('facebook.com');

        // 1) F.I.O kiritish
        if (session.step === 'WAIT_FIO' && !isUrl) {
            if (rawText.length < 3) {
                return await ctx.reply('⚠️ Iltimos, Ism va Familiyangizni to\'liqroq kiriting:');
            }

            userSessions.set(telegramId, { step: 'MAIN_MENU' });

            await Promise.all([
                pool.query(
                    `INSERT INTO users (telegram_id, first_name, full_name, username, balance, step)
                     VALUES ($1, $2, $3, $4, 0.00, 'MAIN_MENU')
                     ON CONFLICT (telegram_id)
                     DO UPDATE SET full_name = $3, username = $4, step = 'MAIN_MENU'`,
                    [telegramId, ctx.from.first_name || '', rawText, ctx.from.username || '']
                ),
                ctx.reply(
                    `✅ Rahmat, <b>${escapeHtml(rawText)}</b>! Ro'yxatdan muvaffaqiyatli o'tdingiz.`,
                    { parse_mode: 'HTML' }
                )
            ]);
            return await showMainMenu(ctx);
        }

        // 2) AGAR FOYDALANUVCHI "VIDEO YUKLASH (BEPUL)" BO'LIMIDAN HAVOLA YUBORAYOTGAN BO'LSA:
        if (session.step === 'WAIT_DOWNLOAD_LINK' && isUrl) {
            userSessions.set(telegramId, { step: 'MAIN_MENU' });
            return await handleFreeVideoDownload(ctx, extractedLink);
        }

        // 3) AGAR FOYDALANUVCHI PULLIK XIZMATNI TANLAB HAVOLA YUBORAYOTGAN BO'LSA:
        if (session.step === 'WAIT_PAID_LINK' && session.service && isUrl) {
            if (await checkPendingReceiptAndAlert(ctx)) return;
            const service = session.service;

            if (!isValidPlatformLink(extractedLink, service.platform)) {
                return await ctx.reply(
                    `⚠️ <b>Iltimos, to'g'ri ${escapeHtml(service.platform.toUpperCase())} havolasini yuboring.</b>`,
                    { parse_mode: 'HTML' }
                );
            }

            userSessions.set(telegramId, { step: 'MAIN_MENU' });
            return await executePaidSmmOrder(ctx, extractedLink, service);
        }

        // 4) AGAR FOYDALANUVCHI TO'G'RIDAN-TO'G'RI INSTAGRAM HAVOLA YUBORSA — BEPUL VIDEO YUKLASH!
        if (isValidInstagramLink(extractedLink)) {
            userSessions.set(telegramId, { step: 'MAIN_MENU' });
            return await handleFreeVideoDownload(ctx, extractedLink);
        }

        // 5) AGAR FOYDALANUVCHI TO'G'RIDAN-TO'G'RI YOUTUBE HAVOLA YUBORSA:
        if (isValidYouTubeLink(extractedLink)) {
            if (await checkPendingReceiptAndAlert(ctx)) return;
            userSessions.set(telegramId, {
                step: 'PENDING_DIRECT_LINK',
                link: extractedLink,
                platform: 'youtube'
            });
            return await ctx.reply(
                `📺 <b>YouTube havolasi qabul qilindi!</b>\n\n` +
                `🔗 <code>${escapeHtml(extractedLink)}</code>\n\n` +
                `👇 Videoni bepul yuklab olasizmi yoki xizmatlardan foydalanasizmi?`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('📥 Videoni bepul yuklab olish', 'free_dl_yt')],
                        [Markup.button.callback('👁 Ko\'rishlar (+50) — 2,000 so\'m', 'direct_yt_views')],
                        [Markup.button.callback('❤️ Layklar (+10) — 2,000 so\'m', 'direct_yt_likes')],
                        [Markup.button.callback('👥 Obunachilar (+10) — 2,000 so\'m', 'direct_yt_subscribers')]
                    ])
                }
            );
        }

        // 6) AGAR FOYDALANUVCHI TO'G'RIDAN-TO'G'RI FACEBOOK HAVOLA YUBORSA:
        if (isValidFacebookLink(extractedLink)) {
            if (await checkPendingReceiptAndAlert(ctx)) return;
            userSessions.set(telegramId, {
                step: 'PENDING_DIRECT_LINK',
                link: extractedLink,
                platform: 'facebook'
            });
            return await ctx.reply(
                `📘 <b>Facebook havolasi qabul qilindi!</b>\n\n` +
                `🔗 <code>${escapeHtml(extractedLink)}</code>\n\n` +
                `👇 Videoni bepul yuklab olasizmi yoki xizmatlardan foydalanasizmi?`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('📥 Videoni bepul yuklab olish', 'free_dl_fb')],
                        [Markup.button.callback('👁 Video Ko\'rishlar (+100) — 1,500 so\'m', 'direct_fb_views')],
                        [Markup.button.callback('👍 Post Layklar (+10) — 1,500 so\'m', 'direct_fb_likes')]
                    ])
                }
            );
        }

        // 7) Boshqa holatlar uchun menyu ko'rsatish
        await ctx.reply(
            '📥 <b>Video yuklash uchun havola yuboring (Instagram, YouTube, Facebook — Bepul)</b>\n' +
            'Yoki pullik xizmatlardan birini tanlang:',
            Markup.keyboard([
                ['📥 Video yuklash (Bepul)', '📸 Instagram'],
                ['📺 YouTube', '📘 Facebook'],
                ['💰 Balans', '📦 Buyurtmalarim', '🌐 Web ilova']
            ]).resize()
        );
    } catch (error) {
        console.error('[text handler log]:', error.message);
        await ctx.reply('⚠️ Iltimos, havolani qaytadan yuboring.');
    }
});

module.exports = bot;
module.exports.isValidInstagramLink = isValidInstagramLink;
module.exports.isValidYouTubeLink = isValidYouTubeLink;
module.exports.isValidFacebookLink = isValidFacebookLink;
module.exports.extractUrl = extractUrl;
