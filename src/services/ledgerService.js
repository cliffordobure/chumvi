/**
 * Ledger service: single point for all balance changes (MongoDB).
 * Uses transactions when possible (replica set); ensures audit trail.
 */
import { getDb, connect } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';

const ACCOUNT_TYPE_CHAMA_WALLET = 'chama_wallet';

/**
 * Get or create the chama wallet account.
 * @param {string} chamaId
 * @param {object} [session] - optional MongoDB ClientSession for transaction
 * @returns {{ id: string, balance_cents: number, locked_balance_cents: number }}
 */
export async function getOrCreateChamaAccount(chamaId, session = null) {
  const coll = session ? getDb().collection('accounts') : getDb().collection('accounts');
  const opts = session ? { session } : {};

  let acc = await coll.findOne({ chama_id: chamaId, type: ACCOUNT_TYPE_CHAMA_WALLET }, opts);
  if (acc) {
    return {
      id: acc.id,
      balance_cents: acc.balance_cents ?? 0,
      locked_balance_cents: acc.locked_balance_cents ?? 0,
    };
  }

  const id = uuidv4();
  const doc = {
    id,
    chama_id: chamaId,
    type: ACCOUNT_TYPE_CHAMA_WALLET,
    currency: 'KES',
    balance_cents: 0,
    locked_balance_cents: 0,
    updated_at: new Date(),
  };
  await coll.insertOne(doc, opts);
  return { id, balance_cents: 0, locked_balance_cents: 0 };
}

/**
 * Record a ledger entry and update account balance. Use inside a transaction when session is provided.
 * @param {object|null} session - MongoDB ClientSession or null for standalone (no transaction)
 * @param {object} opts
 */
export async function recordEntry(session, opts) {
  const {
    accountId,
    amountCents,
    type,
    referenceType = null,
    referenceId = null,
    metadata = null,
    idempotencyKey = null,
  } = opts;

  const accColl = getDb().collection('accounts');
  const entryColl = getDb().collection('ledger_entries');
  const optsSession = session ? { session } : {};

  if (idempotencyKey) {
    const existing = await entryColl.findOne({ idempotency_key: idempotencyKey }, optsSession);
    if (existing) {
      return {
        ledgerEntryId: existing.id,
        balanceAfterCents: existing.balance_after_cents ?? 0,
      };
    }
  }

  const acc = await accColl.findOne({ id: accountId }, optsSession);
  if (!acc) throw new Error('Account not found');
  const balanceBefore = Number(acc.balance_cents ?? 0);
  const balanceAfter = balanceBefore + amountCents;
  if (balanceAfter < 0) throw new Error('Insufficient balance');

  const entryId = uuidv4();
  await entryColl.insertOne(
    {
      id: entryId,
      account_id: accountId,
      amount_cents: amountCents,
      type,
      reference_type: referenceType,
      reference_id: referenceId,
      balance_after_cents: balanceAfter,
      metadata: metadata || null,
      idempotency_key: idempotencyKey || null,
      created_at: new Date(),
    },
    optsSession
  );

  await accColl.updateOne(
    { id: accountId },
    { $set: { balance_cents: balanceAfter, updated_at: new Date() } },
    optsSession
  );

  return { ledgerEntryId: entryId, balanceAfterCents: balanceAfter };
}

/**
 * Run multiple operations in a single MongoDB transaction when possible.
 * On standalone MongoDB (no replica set), runs the same operations without a transaction.
 */
export async function withTransaction(fn) {
  await connect();
  const client = getDb().client;
  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    const isStandaloneTxnError =
      err.message && (
        err.message.includes('replica set') ||
        err.message.includes('Transaction numbers are only allowed')
      );
    if (isStandaloneTxnError) {
      return fn(null);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

/**
 * Credit chama wallet (e.g. contribution, loan repayment).
 */
export async function creditChamaWallet(chamaId, amountCents, type, referenceType = null, referenceId = null, idempotencyKey = null) {
  return withTransaction(async (session) => {
    const account = await getOrCreateChamaAccount(chamaId, session);
    return recordEntry(session, {
      accountId: account.id,
      amountCents: Math.abs(Number(amountCents)),
      type,
      referenceType,
      referenceId,
      idempotencyKey,
    });
  });
}

/**
 * Debit chama wallet (e.g. loan disbursement, withdrawal).
 */
export async function debitChamaWallet(chamaId, amountCents, type, referenceType = null, referenceId = null, idempotencyKey = null) {
  return withTransaction(async (session) => {
    const account = await getOrCreateChamaAccount(chamaId, session);
    return recordEntry(session, {
      accountId: account.id,
      amountCents: -Math.abs(Number(amountCents)),
      type,
      referenceType,
      referenceId,
      idempotencyKey,
    });
  });
}

/**
 * Get current balance for a chama wallet.
 */
export async function getChamaBalance(chamaId) {
  await connect();
  const account = await getOrCreateChamaAccount(chamaId);
  const coll = getDb().collection('accounts');
  const acc = await coll.findOne({ id: account.id });
  const balance_cents = Number(acc?.balance_cents ?? 0);
  const locked_balance_cents = Number(acc?.locked_balance_cents ?? 0);
  return {
    balance_cents,
    locked_balance_cents,
    available_cents: balance_cents - locked_balance_cents,
  };
}
