import { Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import { col } from '../db/index.js';
import { requireAuth, loadUser, requireSuperAdmin } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth, loadUser, requireSuperAdmin);

router.get('/users', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const users = await col('users')
      .find({}, { projection: { password_hash: 0 } })
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();
    const total = await col('users').countDocuments();
    res.json({ users, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/users/:id/suspend',
  param('id').isUUID(),
  body('suspend').optional().isBoolean(),
  async (req, res, next) => {
    try {
      const suspended = req.body.suspend !== false;
      const r = await col('users').updateOne(
        { id: req.params.id },
        { $set: { is_suspended: suspended, updated_at: new Date() } }
      );
      if (r.matchedCount === 0) return res.status(404).json({ error: 'User not found' });
      const user = await col('users').findOne(
        { id: req.params.id },
        { projection: { id: 1, name: 1, email: 1, is_suspended: 1 } }
      );
      res.json({ user, message: suspended ? 'User suspended' : 'User unsuspended' });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/chamas', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const chamas = await col('chamas')
      .find({})
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();
    const founderIds = [...new Set(chamas.map((c) => c.founder_id))];
    const founders = await col('users').find({ id: { $in: founderIds } }).toArray();
    const founderMap = Object.fromEntries(founders.map((u) => [u.id, u]));
    const chamaIds = chamas.map((c) => c.id);
    const accounts = await col('accounts').find({ chama_id: { $in: chamaIds }, type: 'chama_wallet' }).toArray();
    const accountMap = Object.fromEntries(accounts.map((a) => [a.chama_id, a]));
    const result = chamas.map((c) => ({
      ...c,
      founder_name: founderMap[c.founder_id]?.name,
      founder_email: founderMap[c.founder_id]?.email,
      balance_cents: accountMap[c.id]?.balance_cents ?? 0,
      locked_balance_cents: accountMap[c.id]?.locked_balance_cents ?? 0,
    }));
    const total = await col('chamas').countDocuments();
    res.json({ chamas: result, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    const users = await col('users').countDocuments();
    const chamas = await col('chamas').countDocuments();
    const walletAgg = await col('accounts')
      .aggregate([
        { $match: { type: 'chama_wallet' } },
        { $group: { _id: null, total_balance: { $sum: '$balance_cents' }, total_locked: { $sum: '$locked_balance_cents' } } },
      ])
      .toArray();
    const total_balance_cents = walletAgg[0]?.total_balance ?? 0;
    const total_locked_cents = walletAgg[0]?.total_locked ?? 0;
    const loansAgg = await col('loans')
      .aggregate([
        { $match: { status: 'active' } },
        { $project: { diff: { $subtract: ['$amount_cents', { $ifNull: ['$repaid_cents', 0] }] } } },
        { $group: { _id: null, active_principal: { $sum: '$diff' } } },
      ])
      .toArray();
    const total_loans = await col('loans').countDocuments();
    const active_principal_cents = loansAgg[0]?.active_principal ?? 0;
    const contribAgg = await col('contributions')
      .aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount_cents' } } },
      ])
      .toArray();
    const total_contributions_cents = contribAgg[0]?.total ?? 0;
    res.json({
      users,
      chamas,
      total_balance_cents,
      total_locked_cents,
      total_loans,
      active_principal_cents,
      total_contributions_cents,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/settings', async (req, res, next) => {
  try {
    const rows = await col('platform_settings').find({}).toArray();
    const settings = {};
    rows.forEach((row) => {
      settings[row.key] = { value: row.value, updated_at: row.updated_at };
    });
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

router.put(
  '/settings/:key',
  param('key').notEmpty(),
  body('value').notEmpty(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const key = req.params.key;
      const value = req.body.value;
      const now = new Date();
      await col('platform_settings').updateOne(
        { key },
        { $set: { value, updated_at: now } },
        { upsert: true }
      );
      const row = await col('platform_settings').findOne({ key });
      res.json(row);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
