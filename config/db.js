require('dotenv').config();
const { Pool } = require('pg');

const isRemoteDb = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') && !process.env.DATABASE_URL.includes('127.0.0.1');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isRemoteDb ? { rejectUnauthorized: false } : false
});

// Bazaga ulanish, jadvallarni yaratish va xavfsizlik indekslarini o'rnatish
async function initDatabase() {
    let client;
    try {
        client = await pool.connect();
        console.log('✅ PostgreSQL bazasiga muvaffaqiyatli ulandi!');

        // 1. Foydalanuvchilar (users) jadvali
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                first_name VARCHAR(255),
                full_name VARCHAR(255),
                username VARCHAR(255),
                phone VARCHAR(50),
                balance NUMERIC(12, 2) DEFAULT 0.00,
                step VARCHAR(50) DEFAULT 'start',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(255);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC(12, 2) DEFAULT 0.00;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS step VARCHAR(50) DEFAULT 'start';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        `);

        // 2. Buyurtmalar (orders) jadvali
        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT NOT NULL,
                username VARCHAR(255),
                full_name VARCHAR(255),
                platform VARCHAR(50) DEFAULT 'instagram',
                service_id INTEGER DEFAULT 92,
                service_name VARCHAR(255),
                link TEXT NOT NULL,
                quantity INTEGER DEFAULT 100,
                price NUMERIC(12, 2) DEFAULT 0.00,
                status VARCHAR(50) DEFAULT 'completed',
                smm_order_id VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS telegram_id BIGINT;
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS username VARCHAR(255);
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS platform VARCHAR(50) DEFAULT 'instagram';
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_id INTEGER DEFAULT 92;
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_name VARCHAR(255);
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS link TEXT;
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 100;
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS price NUMERIC(12, 2) DEFAULT 0.00;
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'completed';
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS smm_order_id VARCHAR(100);
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        `);

        // 3. To'lovlar (transactions) jadvali
        await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT NOT NULL,
                amount NUMERIC(12, 2) NOT NULL,
                type VARCHAR(50) DEFAULT 'deposit', -- 'deposit' (kirim) yoki 'payment' (chiqim)
                click_trans_id VARCHAR(255),
                status VARCHAR(50) DEFAULT 'paid',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'deposit';
        `);

        // 4. Xavfsiz to'lov cheklari (receipts) jadvali — Takroriy chek ishlatishni bloklaydi!
        await client.query(`
            CREATE TABLE IF NOT EXISTS receipts (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT NOT NULL,
                file_id TEXT NOT NULL,
                file_unique_id VARCHAR(255) UNIQUE NOT NULL,
                amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
                status VARCHAR(50) DEFAULT 'pending',
                admin_id BIGINT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            ALTER TABLE receipts ADD COLUMN IF NOT EXISTS admin_id BIGINT;
            ALTER TABLE receipts ALTER COLUMN status SET DEFAULT 'pending';
        `);

        console.log('✅ PostgreSQL jadvallari (users, orders, transactions, receipts) tayyor!');
    } catch (err) {
        console.error('❌ PostgreSQL ulanish yoki jadval yangilashda xatolik:', err.message);
    } finally {
        if (client) client.release();
    }
}

initDatabase();

module.exports = pool;
