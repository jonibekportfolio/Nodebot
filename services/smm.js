const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const https = require('https');
const axios = require('axios');

const httpsAgent = new https.Agent({
    family: 4,
    keepAlive: true
});

/**
 * 1. HAQIQIY SMM API BUYURTMA YARATISH (action: 'add')
 * Hech qanday yolg'on/demo raqam qaytarmaydi — faqat SMM serverdan kelgan haqiqiy natijani qaytaradi!
 */
async function createNawabOrder(serviceId = 740, quantity = 100, targetLink) {
    try {
        const apiKey = process.env.NAKRUTKA_API_KEY;
        const apiUrl = process.env.SMM_API_URL || 'https://nawabsmm.com/api/v2';

        if (!apiKey) {
            return {
                success: false,
                error: '.env faylida NAKRUTKA_API_KEY kiritilmagan!'
            };
        }

        const params = new URLSearchParams();
        params.append('key', apiKey);
        params.append('action', 'add');
        params.append('service', String(serviceId));
        params.append('link', targetLink);
        params.append('quantity', String(quantity));

        const response = await axios.post(apiUrl, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            httpsAgent,
            timeout: 12000
        });

        const data = response.data;

        if (data && data.order) {
            console.log(`✅ [REAL SMM API] Buyurtma qabul qilindi! SMM Order ID: ${data.order}`);
            return {
                success: true,
                orderId: String(data.order)
            };
        }

        const apiError = data && data.error ? String(data.error) : JSON.stringify(data);
        console.warn(`⚠️ [REAL SMM API] Provayder rad etdi: ${apiError}`);
        return {
            success: false,
            error: apiError
        };
    } catch (error) {
        const errMsg = error.response && error.response.data
            ? JSON.stringify(error.response.data)
            : error.message;
        console.error('❌ [REAL SMM API] Ulanish xatosi:', errMsg);
        return {
            success: false,
            error: errMsg
        };
    }
}

/**
 * 2. HAQIQIY BUYURTMA HOLATINI SMM SERVERDAN TEKSHIRISH (action: 'status')
 * Provayderdan start_count (boshlang'ich ko'rishlar), remains (qolgani) va status ni oladi
 */
async function checkSmmOrderStatus(smmOrderId) {
    try {
        const apiKey = process.env.NAKRUTKA_API_KEY;
        const apiUrl = process.env.SMM_API_URL || 'https://nawabsmm.com/api/v2';

        const params = new URLSearchParams();
        params.append('key', apiKey);
        params.append('action', 'status');
        params.append('order', String(smmOrderId));

        const response = await axios.post(apiUrl, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            httpsAgent,
            timeout: 10000
        });

        const data = response.data;
        if (data && data.status) {
            return {
                success: true,
                status: data.status, // Pending, In progress, Processing, Completed, Partial, Canceled
                startCount: data.start_count || '0',
                remains: data.remains || '0',
                charge: data.charge || '0',
                currency: data.currency || 'USD'
            };
        }

        return {
            success: false,
            error: data && data.error ? data.error : 'Buyurtma holati topilmadi'
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 3. SMM PANEL BALANSINI TEKSHIRISH (action: 'balance')
 */
async function getSmmBalance() {
    try {
        const apiKey = process.env.NAKRUTKA_API_KEY;
        const apiUrl = process.env.SMM_API_URL || 'https://nawabsmm.com/api/v2';

        const params = new URLSearchParams();
        params.append('key', apiKey);
        params.append('action', 'balance');

        const response = await axios.post(apiUrl, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            httpsAgent,
            timeout: 10000
        });

        return {
            connected: true,
            ...response.data
        };
    } catch (error) {
        return {
            connected: false,
            error: error.message
        };
    }
}

module.exports = {
    createNawabOrder,
    checkSmmOrderStatus,
    getSmmBalance
};
