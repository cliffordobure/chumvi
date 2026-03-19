/**
 * Create MongoDB indexes for Chama Wallet.
 * Run: node src/db/setup.js
 */
import { connect, col } from './index.js';

async function setup() {
  await connect();

  await col('users').createIndexes([
    { key: { id: 1 }, unique: true },
    { key: { email: 1 }, unique: true },
    { key: { phone: 1 } },
    { key: { role: 1 } },
  ]);

  await col('chamas').createIndexes([
    { key: { id: 1 }, unique: true },
    { key: { founder_id: 1 } },
    { key: { is_active: 1 } },
  ]);

  await col('chama_members').createIndexes([
    { key: { chama_id: 1, user_id: 1 }, unique: true },
    { key: { chama_id: 1 } },
    { key: { user_id: 1 } },
  ]);

  await col('accounts').createIndexes([
    { key: { chama_id: 1, type: 1 }, unique: true },
    { key: { chama_id: 1 } },
  ]);

  await col('ledger_entries').createIndexes([
    { key: { account_id: 1 } },
    { key: { created_at: -1 } },
    { key: { idempotency_key: 1 }, unique: true, sparse: true },
  ]);

  await col('contributions').createIndexes([
    { key: { chama_id: 1 } },
    { key: { user_id: 1 } },
    { key: { contribution_date: -1 } },
  ]);

  await col('loans').createIndexes([
    { key: { chama_id: 1 } },
    { key: { borrower_id: 1 } },
    { key: { status: 1 } },
  ]);

  await col('loan_votes').createIndexes([
    { key: { loan_id: 1, member_id: 1 }, unique: true },
    { key: { loan_id: 1 } },
  ]);

  await col('transactions').createIndexes([
    { key: { chama_id: 1 } },
    { key: { user_id: 1 } },
    { key: { created_at: -1 } },
  ]);

  await col('invitations').createIndexes([
    { key: { token: 1 }, unique: true },
    { key: { chama_id: 1 } },
    { key: { chama_id: 1, email: 1 }, unique: true, sparse: true },
    { key: { chama_id: 1, phone: 1 }, unique: true, sparse: true },
  ]);

  await col('distributions').createIndexes([
    { key: { chama_id: 1 } },
    { key: { status: 1 } },
  ]);

  await col('distribution_shares').createIndexes([
    { key: { distribution_id: 1 } },
  ]);

  await col('notifications').createIndexes([
    { key: { user_id: 1 } },
    { key: { read_at: 1 } },
  ]);

  console.log('MongoDB indexes created.');
  process.exit(0);
}

setup().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
