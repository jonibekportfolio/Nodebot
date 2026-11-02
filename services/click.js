const crypto = require('crypto');
const pool = require('../config/db');

// Click imzosini tekshirish (Xavfsizlik uchun)
function verifyClickSign(params, secretKey) {
    const { click_trans_id, service_id, merchant_trans_id, amount, action, sign_time, sign_string } = params;
    
    // Click talab qiladigan tartibda string hosil qilamiz
    const stringToHash = `${click_trans_id}${service_id}${secretKey}${merchant_trans_id}${amount}${action}${sign_time}`;
    const calculatedSign = crypto.createHash('md5').update(stringToHash).digest('hex');

    return calculatedSign === sign_string;
}

module.exports = { verifyClickSign };