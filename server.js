const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
require('dotenv').config();
const express = require('express');
const pool = require('./config/db');
const bot = require('./bot/index');
const { adminBot, setMainBotInstance } = require('./bot/adminBot');
const { isValidInstagramLink, extractUrl } = require('./bot/index');
const { createNawabOrder, checkSmmOrderStatus, getSmmBalance } = require('./services/smm');

// Admin botga asosiy bot nusxasini bog'lash (xabar yuborish uchun)
setMainBotInstance(bot);

const app = express();
app.use(express.json());

// Xavfsizlik: Unhandled xatoliklar jarayonni to'xtatib qo'ymasligi uchun
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ [Server Himoyasi] Unhandled Rejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ [Server Himoyasi] Uncaught Exception:', err.message);
});

// --- 1. BARCHA BUYURTMALARNI KO'RISH (GET /api/orders) ---
app.get('/api/orders', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 50');
        return res.json({
            success: true,
            count: result.rows.length,
            orders: result.rows
        });
    } catch (error) {
        console.error('GET /api/orders xatoligi:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// --- 2. BARCHA TO'LOVLARNI KO'RISH (GET /api/transactions) ---
app.get('/api/transactions', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM transactions ORDER BY id DESC LIMIT 50');
        return res.json({
            success: true,
            count: result.rows.length,
            transactions: result.rows
        });
    } catch (error) {
        console.error('GET /api/transactions xatoligi:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// --- 3. TO'LOV CHEKLARINI KO'RISH (GET /api/receipts) ---
app.get('/api/receipts', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM receipts ORDER BY id DESC LIMIT 50');
        return res.json({
            success: true,
            count: result.rows.length,
            receipts: result.rows
        });
    } catch (error) {
        console.error('GET /api/receipts xatoligi:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// --- 4. SMM API BALANSINI TEKSHIRISH ENDPOINTI ---
app.get('/api/smm-balance', async (req, res) => {
    try {
        const data = await getSmmBalance();
        return res.json({ success: true, data });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// --- 5. HAQIQIY SMM BUYURTMALARNI AVTOMATIK TEKSHIRUVCHI TIZIM ---
function startRealSmmStatusChecker() {
    setInterval(async () => {
        try {
            const activeOrders = await pool.query(
                `SELECT * FROM orders WHERE status = 'processing' AND smm_order_id IS NOT NULL ORDER BY id ASC LIMIT 10`
            );

            for (const ord of activeOrders.rows) {
                try {
                    const live = await checkSmmOrderStatus(ord.smm_order_id);
                    const cleanName = String(ord.service_name || 'Xizmat').replace(/\(ID:\s*\d+\)/gi, '').trim();
                    const st = (live && live.status ? live.status : '').toLowerCase();

                    if (live.success && st === 'completed') {
                        await pool.query(`UPDATE orders SET status = 'done' WHERE id = $1`, [ord.id]);
                        try {
                            await bot.telegram.sendMessage(
                                ord.telegram_id,
                                `🎉 <b>Buyurtmangiz (#${ord.id}) to'liq bajarildi! ✅</b>\n\n` +
                                `📦 <b>Xizmat:</b> ${cleanName}\n` +
                                `🔢 <b>Bajarildi:</b> +${ord.quantity} ta (100%)\n` +
                                `📊 <b>Holati:</b> ✅ Yakunlandi`,
                                { parse_mode: 'HTML', disable_web_page_preview: true }
                            );
                        } catch (_) {}

                    } else if (live.success && st === 'partial') {
                        await pool.query(`UPDATE orders SET status = 'done' WHERE id = $1`, [ord.id]);
                        try {
                            await bot.telegram.sendMessage(
                                ord.telegram_id,
                                `⚠️ <b>Buyurtmangiz (#${ord.id}) qisman bajarildi.</b>\n\n` +
                                `📦 <b>Xizmat:</b> ${cleanName}\n` +
                                `<i>NawabSMM serveri mumkin bo'lgan qismini bajarib to'xtatdi. ` +
                                `Qolgan qism uchun balans NawabSMM tomonidan qaytariladi.</i>`,
                                { parse_mode: 'HTML', disable_web_page_preview: true }
                            );
                        } catch (_) {}

                    } else if (live.success && (st === 'canceled' || st === 'cancelled')) {
                        await pool.query(`UPDATE orders SET status = 'canceled' WHERE id = $1`, [ord.id]);
                        // Balansni qaytarish
                        await pool.query(
                            'UPDATE users SET balance = balance + $1 WHERE telegram_id = $2',
                            [parseFloat(ord.price), ord.telegram_id]
                        );
                        try {
                            await bot.telegram.sendMessage(
                                ord.telegram_id,
                                `❌ <b>Buyurtmangiz (#${ord.id}) bekor qilindi.</b>\n\n` +
                                `📦 <b>Xizmat:</b> ${cleanName}\n` +
                                `💵 <b>${parseFloat(ord.price).toLocaleString('uz-UZ')} so'm balansingizga qaytarildi!</b>\n\n` +
                                `<i>Iltimos, boshqa link bilan qayta urinib ko'ring.</i>`,
                                { parse_mode: 'HTML', disable_web_page_preview: true }
                            );
                        } catch (_) {}
                    }
                } catch (innerErr) {
                    console.error(`[SMM checker order #${ord.id}]:`, innerErr.message);
                }
            }
        } catch (outerErr) {
            console.error('[SMM checker outer error]:', outerErr.message);
        }
    }, 20000);
}

// Server portini belgilash
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`🚀 Express server http://localhost:${PORT} manzilida ishga tushdi...`);
    startRealSmmStatusChecker();
});

// --- TELEGRAM BOTLARNI (ASOSIY VA ADMIN) ISHGA TUSHIRISH ---
bot.launch({ dropPendingUpdates: false })
    .then(() => console.log('🤖 Asosiy foydalanuvchi boti (@nacrutkabotsbot) to\'xtadi.'))
    .catch((err) => console.error('❌ Asosiy bot xatosi:', err.message));
console.log('🤖 Asosiy foydalanuvchi boti (@nacrutkabotsbot) muvaffaqiyatli ishga tushdi!');

adminBot.launch({ dropPendingUpdates: false })
    .then(() => console.log('👑 Maxsus Admin boti (@ad_minakrutkabot) to\'xtadi.'))
    .catch((err) => console.error('❌ Admin bot xatosi:', err.message));
console.log('👑 Maxsus Admin boti (@ad_minakrutkabot) muvaffaqiyatli ishga tushdi!');

const gracefulShutdown = (signal) => {
    console.log(`🛑 Server to'xtatilmoqda (${signal})...`);
    try { bot.stop(signal); } catch (_) {}
    try { adminBot.stop(signal); } catch (_) {}
    server.close(() => {
        pool.end().catch(() => {});
        process.exit(0);
    });
};

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = { app, pool };
