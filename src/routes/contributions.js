import { Router } from 'express';
import { body, param, query as q, validationResult } from 'express-validator';
import { col } from '../db/index.js';
import { requireAuth, loadUser } from '../middleware/auth.js';
import { creditChamaWallet } from '../services/ledgerService.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

router.post(
  '/',
  requireAuth,
  loadUser,
  [
    body('chama_id').isUUID().withMessage('Valid chama_id required'),
    body('amount_cents').isInt({ min: 1 }).withMessage('Amount must be positive'),
    body('contribution_date').optional().isISO8601(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const chamaId = req.body.chama_id;
      const amountCents = req.body.amount_cents;
      const contributionDate = req.body.contribution_date ? new Date(req.body.contribution_date) : new Date();

      const chama = await col('chamas').findOne({ id: chamaId });
      if (!chama) {
        return res.status(404).json({ error: 'Chama not found' });
      }
      const minCents = Number(chama.minimum_contribution_cents ?? 0);
      if (amountCents < minCents) {
        return res.status(400).json({ error: `Minimum contribution is ${minCents} cents` });
      }

      const member = await col('chama_members').findOne({
        chama_id: chamaId,
        user_id: req.user.id,
        status: 'active',
      });
      if (!member) {
        return res.status(403).json({ error: 'You are not a member of this chama' });
      }

      const contributionId = uuidv4();
      const idempotencyKey = `contribution-${chamaId}-${req.user.id}-${contributionDate.toISOString().slice(0, 10)}-${amountCents}`;

      await creditChamaWallet(chamaId, amountCents, 'contribution', 'contribution', contributionId, idempotencyKey);

      const now = new Date();
      await col('contributions').insertOne({
        id: contributionId,
        chama_id: chamaId,
        user_id: req.user.id,
        amount_cents: amountCents,
        contribution_date: contributionDate,
        status: 'completed',
        created_at: now,
        updated_at: now,
      });

      await col('transactions').insertOne({
        id: uuidv4(),
        chama_id: chamaId,
        user_id: req.user.id,
        type: 'contribution',
        amount_cents: amountCents,
        status: 'completed',
        reference_type: 'contribution',
        reference_id: contributionId,
        created_at: now,
      });

      const contribution = await col('contributions').findOne({ id: contributionId });
      res.status(201).json({ contribution });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:chamaId',
  requireAuth,
  loadUser,
  param('chamaId').isUUID(),
  q('from').optional().isISO8601(),
  q('to').optional().isISO8601(),
  q('user_id').optional().isUUID(),
  q('limit').optional().isInt({ min: 1, max: 100 }),
  q('offset').optional().isInt({ min: 0 }),
  async (req, res, next) => {
    try {
      const chamaId = req.params.chamaId;
      const member = await col('chama_members').findOne({
        chama_id: chamaId,
        user_id: req.user.id,
        status: 'active',
      });
      if (!member) {
        return res.status(404).json({ error: 'Chama not found or access denied' });
      }

      const filter = { chama_id: chamaId };
      if (req.query.from || req.query.to) {
        filter.contribution_date = {};
        if (req.query.from) filter.contribution_date.$gte = new Date(req.query.from);
        if (req.query.to) filter.contribution_date.$lte = new Date(req.query.to);
      }
      if (req.query.user_id) filter.user_id = req.query.user_id;

      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
      const offset = parseInt(req.query.offset, 10) || 0;

      const contributions = await col('contributions')
        .find(filter)
        .sort({ contribution_date: -1, created_at: -1 })
        .skip(offset)
        .limit(limit)
        .toArray();

      const userIds = [...new Set(contributions.map((c) => c.user_id))];
      const users = await col('users').find({ id: { $in: userIds } }).toArray();
      const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

      const result = contributions.map((c) => ({
        ...c,
        user_name: userMap[c.user_id]?.name,
        user_email: userMap[c.user_id]?.email,
      }));

      const total = await col('contributions').countDocuments({ chama_id: chamaId });

      res.json({
        contributions: result,
        total,
        limit,
        offset,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
