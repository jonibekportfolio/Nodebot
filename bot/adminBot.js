const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const https = require('https');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');
const pool = require('../config/db');
const { getSmmBalance } = require('../services/smm');

const telegramAgent = new https.Agent({
    family: 4,
    keepAlive: true,
    maxSockets: 50,
    keepAliveMsecs: 30000
});

const adminBotToken = process.env.ADMIN_BOT_TOKEN;
if (!adminBotToken) {
    console.error('❌ .env faylida ADMIN_BOT_TOKEN topilmadi!');
}

const adminBot = new Telegraf(adminBotToken, {
    telegram: {
        agent: telegramAgent
    }
});

const adminSessions = new Map();

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function isAdmin(telegramId) {
    const mainAdminId = process.env.ADMIN_TELEGRAM_ID || '';
    const adminList = mainAdminId.split(',').map(id => id.trim());
    return adminList.includes(String(telegramId));
}

let mainBotInstance = null;
function setMainBotInstance(mainBot) {
    mainBotInstance = mainBot;
}

// -------------------------------------------------------------
// 1. ADMIN BOT MENYUSI VA STATISTIKA
// -------------------------------------------------------------
adminBot.start(async (ctx) => {
    try {
        const fromId = ctx.from.id;
        if (!isAdmin(fromId)) {
            return await ctx.reply('⛔ Kechirasiz, siz ushbu admin botdan foydalanish huquqiga ega emassiz.');
        }

        await ctx.reply(
            `👋 <b>Assalomu alaykum, Hurmatli Admin!</b>\n\n` +
            `Bu bot orqali siz asosiy botdan yuborilgan to'lov cheklarini ko'rib chiqishingiz, ` +
            `foydalanuvchilar balansini tasdiqlashingiz va SMM API hisobini nazorat qilishingiz mumkin.\n\n` +
            `👇 Quyidagi buyruqlardan foydalanishingiz mumkin:`,
            {
                parse_mode: 'HTML',
                ...Markup.keyboard([
                    ['🧾 Kutilayotgan cheklar', '📊 Statistika'],
                    ['💰 SMM API Balansi', 'ℹ️ Yordam']
                ]).resize()
            }
        );
    } catch (err) {
        console.error('[Admin start error]:', err.message);
    }
});

// SMM API Balansini ko'rish
adminBot.hears(['💰 SMM API Balansi', '/balance'], async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try {
        const waiting = await ctx.reply('⏳ NawabSMM balansi tekshirilmoqda...');
        const balData = await getSmmBalance();

        let text = '💰 <b>NawabSMM Server Balansi:</b>\n\n';
        if (balData.success) {
            text += `💵 <b>Mavjud balans:</b> $${balData.balance} ${balData.currency}\n`;
            text += `🟢 <b>Server holati:</b> Faol va buyurtmalarni qabul qilmoqda.`;
        } else {
            text += `❌ <b>Xatolik:</b> ${escapeHtml(balData.error)}`;
        }

        await ctx.telegram.editMessageText(ctx.chat.id, waiting.message_id, undefined, text, { parse_mode: 'HTML' });
    } catch (err) {
        console.error('[Admin smm balance error]:', err.message);
    }
});

// Bot statistikasi
adminBot.hears(['📊 Statistika', '/stats'], async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try {
        const [usersRes, ordersRes, pendingRes, incomeRes] = await Promise.all([
            pool.query('SELECT COUNT(*) FROM users'),
            pool.query('SELECT COUNT(*) as total, SUM(CASE WHEN status = \'done\' THEN 1 ELSE 0 END) as done FROM orders'),
            pool.query('SELECT COUNT(*) FROM receipts WHERE status = \'pending\''),
            pool.query('SELECT SUM(amount) FROM transactions WHERE type = \'deposit\' AND status = \'paid\'')
        ]);

        const totalUsers = usersRes.rows[0].count;
        const totalOrders = ordersRes.rows[0].total || 0;
        const doneOrders = ordersRes.rows[0].done || 0;
        const pendingCount = pendingRes.rows[0].count;
        const totalIncome = incomeRes.rows[0].sum ? Number(incomeRes.rows[0].sum).toLocaleString('uz-UZ') : '0';

        const text =
            `📊 <b>NAKRUTKA BOT STATISTIKASI:</b>\n\n` +
            `👥 <b>Jami foydalanuvchilar:</b> ${totalUsers} ta\n` +
            `📦 <b>Jami buyurtmalar:</b> ${totalOrders} ta (✅ ${doneOrders} ta bajarilgan)\n` +
            `🧾 <b>Kutilayotgan cheklar:</b> ${pendingCount} ta\n` +
            `💵 <b>Jami to'ldirilgan summa:</b> ${totalIncome} so'm`;

        await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (err) {
        console.error('[Admin stats error]:', err.message);
    }
});

// Kutilayotgan cheklar (Rasmlar va tasdiqlash tugmalari bilan birga chiqarish!)
adminBot.hears(['🧾 Kutilayotgan cheklar', '/pending'], async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try {
        const res = await pool.query(
            `SELECT r.id, r.telegram_id, r.file_id, r.amount, r.created_at, u.full_name, u.username 
             FROM receipts r
             LEFT JOIN users u ON r.telegram_id = u.telegram_id
             WHERE r.status = 'pending' 
             ORDER BY r.id ASC LIMIT 10`
        );

        if (res.rows.length === 0) {
            return await ctx.reply('✅ Hozirda kutilayotgan to\'lov cheklari yo\'q!');
        }

        await ctx.reply(`🧾 <b>Kutilayotgan to'lov cheklari (${res.rows.length} ta):</b>\nQuyidagi tugmalar orqali tasdiqlang yoki rad eting:`, { parse_mode: 'HTML' });

        for (const row of res.rows) {
            await forwardReceiptToAdmin({
                receiptId: row.id,
                telegramId: row.telegram_id,
                fullName: row.full_name || 'Foydalanuvchi',
                username: row.username,
                fileId: row.file_id,
                caption: ''
            });
        }
    } catch (err) {
        console.error('[Admin pending error]:', err.message);
    }
});

adminBot.hears(['ℹ️ Yordam', '/help'], async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.reply(
        `ℹ️ <b>Admin bot qo'llanmasi:</b>\n\n` +
        `1. Foydalanuvchi asosiy botda to'lov chekini yuborganida, bu botga rasm va tezkor tasdiqlash tugmalari keladi.\n` +
        `2. Siz tugmani bosib 5 000, 10 000, 20 000, 50 000 yoki boshqa summani belgilaysiz.\n` +
        `3. Tasdiqlangach, foydalanuvchiga bir zumda xabar boradi va uning balansi to'ldiriladi.\n` +
        `4. Rad etish tugmasi orqali soxta cheklarni bekor qilishingiz mumkin.`,
        { parse_mode: 'HTML' }
    );
});

// -------------------------------------------------------------
// 2. RASM BUFERINI XAVFSIZ YUKLAB OLISH YORDAMCHISI
// -------------------------------------------------------------
async function getPhotoBuffer(fileId) {
    if (!mainBotInstance || !fileId) return null;
    try {
        const fileLink = await mainBotInstance.telegram.getFileLink(fileId);
        const url = fileLink.href || fileLink.toString();
        const resp = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 15000
        });
        return resp.data;
    } catch (e) {
        console.error('getPhotoBuffer error:', e.message);
        return null;
    }
}

// -------------------------------------------------------------
// 3. YANGI CHEKNI ADMINGA YUBORISH FUNKSIYASI (ASOSIY BOT CHAQIRADI)
// -------------------------------------------------------------
async function forwardReceiptToAdmin(receiptInfo) {
    try {
        const adminId = process.env.ADMIN_TELEGRAM_ID;
        if (!adminId) {
            console.error('❌ process.env.ADMIN_TELEGRAM_ID belgilanmagan!');
            return false;
        }

        const {
            receiptId,
            telegramId,
            fullName,
            username,
            fileId,
            photoBuffer,
            caption
        } = receiptInfo;

        const captionText =
            `🧾 <b>YANGI TO'LOV CHEKI (#${receiptId})</b>\n\n` +
            `👤 <b>Foydalanuvchi:</b> ${escapeHtml(fullName)}\n` +
            `📱 <b>Username:</b> ${username ? '@' + escapeHtml(username) : '<i>yo\'q</i>'}\n` +
            `🆔 <b>Telegram ID:</b> <code>${telegramId}</code>\n` +
            `📝 <b>Izoh / Summa:</b> ${caption ? escapeHtml(caption) : '<i>Kiritilmagan</i>'}\n` +
            `🕒 <b>Vaqt:</b> ${new Date().toLocaleString('uz-UZ')}\n\n` +
            `👇 <i>Qabul qilish summasini tanlang yoki rad eting:</i>`;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ 5,000 so\'m', `adm_appr_${receiptId}_5000`),
                Markup.button.callback('✅ 10,000 so\'m', `adm_appr_${receiptId}_10000`),
                Markup.button.callback('✅ 15,000 so\'m', `adm_appr_${receiptId}_15000`)
            ],
            [
                Markup.button.callback('✅ 20,000 so\'m', `adm_appr_${receiptId}_20000`),
                Markup.button.callback('✅ 50,000 so\'m', `adm_appr_${receiptId}_50000`),
                Markup.button.callback('✅ 100,000 so\'m', `adm_appr_${receiptId}_100000`)
            ],
            [
                Markup.button.callback('✍️ Boshqa summa', `adm_custom_${receiptId}`),
                Markup.button.callback('❌ Rad etish', `adm_reject_${receiptId}`)
            ]
        ]);

        let buf = photoBuffer;
        if (!buf && fileId) {
            buf = await getPhotoBuffer(fileId);
        }

        if (buf) {
            await adminBot.telegram.sendPhoto(adminId, { source: buf }, {
                caption: captionText,
                parse_mode: 'HTML',
                ...keyboard
            });
        } else {
            await adminBot.telegram.sendMessage(adminId, captionText, {
                parse_mode: 'HTML',
                ...keyboard
            });
        }

        console.log(`✅ [ADMIN BOT] Chek #${receiptId} adminga yetkazildi!`);
        return true;
    } catch (err) {
        console.error('❌ [ADMIN BOT forwardReceiptToAdmin xatosi]:', err.message);
        return false;
    }
}

// -------------------------------------------------------------
// 4. ADMIN TUGMALARINI QAYTA ISHLASH (TASDIQLASH / RAD ETISH)
// -------------------------------------------------------------

// A) Chekni tasdiqlash (Belgilangan summa bilan)
adminBot.action(/^adm_appr_(\d+)_(\d+)$/, async (ctx) => {
    try {
        if (!isAdmin(ctx.from.id)) {
            return await ctx.answerCbQuery('⛔ Siz admin emassiz!');
        }

        const receiptId = parseInt(ctx.match[1], 10);
        const amount = parseFloat(ctx.match[2]);

        await processReceiptApproval(ctx, receiptId, amount);
    } catch (err) {
        console.error('[adm_appr error]:', err.message);
        ctx.answerCbQuery('Xatolik yuz berdi').catch(() => {});
    }
});

// B) Maxsus summa kiritish
adminBot.action(/^adm_custom_(\d+)$/, async (ctx) => {
    try {
        if (!isAdmin(ctx.from.id)) {
            return await ctx.answerCbQuery('⛔ Siz admin emassiz!');
        }

        const receiptId = parseInt(ctx.match[1], 10);
        adminSessions.set(ctx.from.id, { step: 'WAIT_CUSTOM_AMOUNT', receiptId });

        await ctx.answerCbQuery();
        await ctx.reply(
            `✍️ <b>Chek #${receiptId} uchun summani kiriting:</b>\n` +
            `Faqat raqam yozing (Masalan: <code>12000</code> yoki <code>25000</code>):`,
            { parse_mode: 'HTML' }
        );
    } catch (err) {
        console.error('[adm_custom error]:', err.message);
    }
});

// C) Chekni rad etish
adminBot.action(/^adm_reject_(\d+)$/, async (ctx) => {
    try {
        if (!isAdmin(ctx.from.id)) {
            return await ctx.answerCbQuery('⛔ Siz admin emassiz!');
        }

        const receiptId = parseInt(ctx.match[1], 10);
        ctx.answerCbQuery('Rad etilmoqda...').catch(() => {});

        // Chekni tekshirish
        const checkRes = await pool.query(
            'SELECT * FROM receipts WHERE id = $1 AND status = \'pending\'',
            [receiptId]
        );

        if (checkRes.rows.length === 0) {
            return await ctx.reply('⚠️ Bu chek allaqachon ko\'rib chiqilgan!');
        }

        const receipt = checkRes.rows[0];

        // Statusni 'rejected' ga o'zgartirish
        await pool.query(
            'UPDATE receipts SET status = \'rejected\', admin_id = $1 WHERE id = $2',
            [ctx.from.id, receiptId]
        );

        // Admin bot xabarini yangilash
        try {
            await ctx.editMessageCaption(
                `🧾 <b>TO'LOV CHEKI (#${receiptId})</b>\n\n` +
                `🆔 Foydalanuvchi: <code>${receipt.telegram_id}</code>\n` +
                `❌ <b>RAD ETILDI!</b>\n` +
                `👨‍💻 Ko'rib chiqqan: @${escapeHtml(ctx.from.username || ctx.from.first_name)}\n` +
                `🕒 Vaqt: ${new Date().toLocaleString('uz-UZ')}`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('❌ Rad etilgan', 'noop')]
                    ])
                }
            );
        } catch (_) {}

        // Asosiy bot orqali foydalanuvchiga xabar berish
        if (mainBotInstance) {
            try {
                await mainBotInstance.telegram.sendMessage(
                    receipt.telegram_id,
                    `❌ <b>Siz yuborgan to'lov cheki admin tomonidan rad etildi.</b>\n\n` +
                    `<i>Sababi: Chek xira, noto'g'ri yoki hisobga pul tushmagan bo'lishi mumkin.</i>\n` +
                    `Iltimos, haqiqiy to'lov chekini qaytadan yuboring yoki administrator bilan bog'laning.`,
                    { parse_mode: 'HTML' }
                );
            } catch (userErr) {
                console.error('[Notify user reject error]:', userErr.message);
            }
        }
    } catch (err) {
        console.error('[adm_reject error]:', err.message);
    }
});

// D) Maxsus summani matn sifatida qabul qilish
adminBot.on('text', async (ctx) => {
    try {
        if (!isAdmin(ctx.from.id)) return;
        const session = adminSessions.get(ctx.from.id);

        if (session && session.step === 'WAIT_CUSTOM_AMOUNT') {
            const raw = ctx.message.text.trim().replace(/\s+/g, '');
            const parsed = parseFloat(raw);

            if (isNaN(parsed) || parsed < 1000) {
                return await ctx.reply('⚠️ Iltimos, to\'g\'ri summa kiriting (Kamida 1000 so\'m):');
            }

            const receiptId = session.receiptId;
            adminSessions.delete(ctx.from.id);

            // ctx.answerCbQuery text xabarida yo'q — processReceiptApproval buni o'zi hal qiladi
            await processReceiptApproval(ctx, receiptId, parsed);
        }
    } catch (err) {
        console.error('[Admin text error]:', err.message);
    }
});

// Tasdiqlashning asosiy logikasi (ham callback, ham text xabari holatida ishlaydi)
async function processReceiptApproval(ctx, receiptId, amount) {
    // 1. Chek bazada 'pending' holatdami tekshiramiz
    const checkRes = await pool.query(
        'SELECT * FROM receipts WHERE id = $1 AND status = \'pending\'',
        [receiptId]
    );

    if (checkRes.rows.length === 0) {
        if (ctx.answerCbQuery) {
            ctx.answerCbQuery('⚠️ Bu chek allaqachon ko\'rib chiqilgan!').catch(() => {});
        }
        return await ctx.reply('⚠️ Bu chek allaqachon tasdiqlangan yoki rad etilgan!');
    }

    // answerCbQuery faqat callback queryda mavjud
    if (ctx.answerCbQuery) {
        ctx.answerCbQuery(`✅ ${amount.toLocaleString('uz-UZ')} so'm tasdiqlandi!`).catch(() => {});
    }

    const receipt = checkRes.rows[0];
    const telegramId = receipt.telegram_id;

    // 2. Chek statusini 'approved' va summasini yangilaymiz
    await pool.query(
        'UPDATE receipts SET status = \'approved\', amount = $1, admin_id = $2 WHERE id = $3',
        [amount, ctx.from.id, receiptId]
    );

    // 3. Foydalanuvchi balansini bazada oshiramiz
    const userRes = await pool.query(
        `UPDATE users 
         SET balance = COALESCE(balance, 0) + $1 
         WHERE telegram_id = $2 
         RETURNING balance, full_name, first_name`,
        [amount, telegramId]
    );

    const newBalance = userRes.rows.length > 0
        ? Number(userRes.rows[0].balance).toLocaleString('uz-UZ')
        : amount.toLocaleString('uz-UZ');

    // 4. Tranzaksiyalar jadvaliga yozamiz
    await pool.query(
        `INSERT INTO transactions (telegram_id, amount, type, click_trans_id, status)
         VALUES ($1, $2, 'deposit', $3, 'paid')`,
        [telegramId, amount, `RECEIPT-${receiptId}`]
    );

    // 5. Admin botdagi xabarni yangilash (Tugmalarni qulflash)
    try {
        const approvedText =
            `🧾 <b>TO'LOV CHEKI (#${receiptId})</b>\n\n` +
            `🆔 Foydalanuvchi: <code>${telegramId}</code>\n` +
            `✅ <b>TASDIQLANDI!</b>\n` +
            `💵 <b>Berilgan summa:</b> +${amount.toLocaleString('uz-UZ')} so'm\n` +
            `💰 <b>Foydalanuvchining yangi balansi:</b> ${newBalance} so'm\n` +
            `👨‍💻 <b>Admin:</b> @${escapeHtml(ctx.from.username || ctx.from.first_name)}\n` +
            `🕒 <b>Vaqt:</b> ${new Date().toLocaleString('uz-UZ')}`;

        if (ctx.callbackQuery && ctx.editMessageCaption) {
            await ctx.editMessageCaption(approvedText, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(`✅ Tasdiqlandi (+${amount.toLocaleString('uz-UZ')} so'm)`, 'noop')]
                ])
            });
        } else {
            await ctx.reply(approvedText, { parse_mode: 'HTML' });
        }
    } catch (e) {
        console.error('[Edit caption error]:', e.message);
    }

    // 6. Asosiy bot orqali foydalanuvchiga xushxabarni yetkazish!
    if (mainBotInstance) {
        try {
            await mainBotInstance.telegram.sendMessage(
                telegramId,
                `🎉 <b>To'lov chekingiz muvaffaqiyatli tasdiqlandi!</b>\n\n` +
                `💵 <b>Hisobingizga qo'shildi:</b> +${amount.toLocaleString('uz-UZ')} so'm\n` +
                `💰 <b>Joriy balansingiz:</b> <b>${newBalance} so'm</b>\n\n` +
                `<i>Barcha cheklovlar yechildi! Endi menyudan xohlagan xizmatni tanlab buyurtma berishingiz mumkin.</i>`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('📸 Instagram xizmatlari', 'open_ig_menu')],
                        [Markup.button.callback('💰 Balansni ko\'rish', 'open_balance_btn')]
                    ])
                }
            );
        } catch (notifyErr) {
            console.error('[Notify user approval error]:', notifyErr.message);
        }
    }
}

adminBot.action('noop', (ctx) => ctx.answerCbQuery().catch(() => {}));

module.exports = {
    adminBot,
    forwardReceiptToAdmin,
    setMainBotInstance
};
