import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { connect, col } from './index.js';

dotenv.config();

async function seed() {
  await connect();

  const email = process.env.SEED_ADMIN_EMAIL || 'admin@chamawallet.com';
  const password = process.env.SEED_ADMIN_PASSWORD || 'admin123';

  const existing = await col('users').findOne({ email });
  if (existing) {
    console.log('Admin user already exists:', email);
    process.exit(0);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const id = uuidv4();
  const now = new Date();
  await col('users').insertOne({
    id,
    name: 'Platform Admin',
    email,
    password_hash: passwordHash,
    role: 'super_admin',
    is_suspended: false,
    created_at: now,
    updated_at: now,
  });
  console.log('Created super_admin:', email);
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
