import { Router } from 'express';
import { body, param, query as q, validationResult } from 'express-validator';
import { col } from '../db/index.js';
import { requireAuth, loadUser } from '../middleware/auth.js';
import { getOrCreateChamaAccount, recordEntry, withTransaction } from '../services/ledgerService.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

router.post(
  '/',
  requireAuth,
  loadUser,
  [
    body('chama_id').isUUID().withMessage('Valid chama_id required'),
    body('total_amount_cents').isInt({ min: 1 }).withMessage('Amount must be positive'),
    body('type').optional().isIn(['dividend', 'penalty_share']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const chamaId = req.body.chama_id;
      const totalAmountCents = req.body.total_amount_cents;
      const type = req.body.type || 'dividend';

      const member = await col('chama_members').findOne({
        chama_id: chamaId,
        user_id: req.user.id,
        status: 'active',
      });
      if (!member) return res.status(404).json({ error: 'Chama not found or access denied' });
      if (member.role !== 'founder' && member.role !== 'admin') {
        return res.status(403).json({ error: 'Only founder or admin can create distribution' });
      }

      const account = await col('accounts').findOne({ chama_id: chamaId, type: 'chama_wallet' });
      const balance_cents = account?.balance_cents ?? 0;
      const locked_balance_cents = account?.locked_balance_cents ?? 0;
      const available = balance_cents - locked_balance_cents;
      if (totalAmountCents > available) {
        return res.status(400).json({ error: 'Insufficient available balance for distribution' });
      }

      const contribAgg = await col('contributions')
        .aggregate([
          { $match: { chama_id: chamaId, status: 'completed' } },
          { $group: { _id: '$user_id', total_cents: { $sum: '$amount_cents' } } },
        ])
        .toArray();
      const totalContrib = contribAgg.reduce((s, r) => s + Number(r.total_cents), 0);
      if (totalContrib === 0) {
        return res.status(400).json({ error: 'No contributions to distribute from' });
      }

      const shares = contribAgg.map((r) => ({
        user_id: r._id,
        amount_cents: Math.floor((Number(r.total_cents) / totalContrib) * totalAmountCents),
      }));
      let allocated = shares.reduce((s, x) => s + x.amount_cents, 0);
      if (allocated < totalAmountCents && shares.length > 0) {
        shares[0].amount_cents += totalAmountCents - allocated;
      }

      const distId = uuidv4();
      const now = new Date();
      await col('distributions').insertOne({
        id: distId,
        chama_id: chamaId,
        total_amount_cents: totalAmountCents,
        type,
        status: 'pending',
        approval_votes: 0,
        created_at: now,
        updated_at: now,
      });

      for (const s of shares) {
        await col('distribution_shares').insertOne({
          id: uuidv4(),
          distribution_id: distId,
          user_id: s.user_id,
          amount_cents: s.amount_cents,
          created_at: now,
        });
      }

      const dist = await col('distributions').findOne({ id: distId });
      res.status(201).json({ distribution: dist, shares: shares.length });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/vote',
  requireAuth,
  loadUser,
  [body('distribution_id').isUUID().withMessage('Valid distribution_id required')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const distId = req.body.distribution_id;

      const dist = await col('distributions').findOne({ id: distId });
      if (!dist) return res.status(404).json({ error: 'Distribution not found' });
      if (dist.status !== 'pending') {
        return res.status(400).json({ error: 'Distribution is not pending' });
      }

      const chama = await col('chamas').findOne({ id: dist.chama_id });
      const member = await col('chama_members').findOne({
        chama_id: dist.chama_id,
        user_id: req.user.id,
        status: 'active',
      });
      if (!member) return res.status(403).json({ error: 'Not a member' });

      await col('distributions').updateOne(
        { id: distId },
        { $inc: { approval_votes: 1 }, $set: { updated_at: new Date() } }
      );
      const updated = await col('distributions').findOne({ id: distId });
      const votesRequired = chama?.distribution_approval_votes_required ?? 1;
      if (updated.approval_votes >= votesRequired) {
        await col('distributions').updateOne(
          { id: distId },
          { $set: { status: 'approved', approved_at: new Date(), updated_at: new Date() } }
        );
      }

      const d = await col('distributions').findOne({ id: distId });
      res.json({ distribution: d, message: 'Vote recorded' });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/execute',
  requireAuth,
  loadUser,
  [body('distribution_id').isUUID().withMessage('Valid distribution_id required')],
  async (req, res, next) => {
    try {
      const distId = req.body.distribution_id;

      const dist = await col('distributions').findOne({ id: distId });
      if (!dist) return res.status(404).json({ error: 'Distribution not found' });
      if (dist.status !== 'approved') {
        return res.status(400).json({ error: 'Distribution must be approved first' });
      }

      const member = await col('chama_members').findOne({
        chama_id: dist.chama_id,
        user_id: req.user.id,
        status: 'active',
      });
      if (!member) return res.status(403).json({ error: 'Not a member' });
      if (member.role !== 'founder' && member.role !== 'admin') {
        return res.status(403).json({ error: 'Only founder or admin can execute' });
      }

      const shares = await col('distribution_shares').find({ distribution_id: distId }).toArray();

      await withTransaction(async (session) => {
        const account = await getOrCreateChamaAccount(dist.chama_id, session);
        for (const s of shares) {
          await recordEntry(session, {
            accountId: account.id,
            amountCents: -Number(s.amount_cents),
            type: 'dividend',
            referenceType: 'distribution_share',
            referenceId: s.id,
          });
        }
        const now = new Date();
        await col('distributions').updateOne(
          { id: distId },
          { $set: { status: 'completed', completed_at: now, updated_at: now } },
          { session }
        );
        for (const s of shares) {
          await col('distribution_shares').updateOne(
            { id: s.id },
            { $set: { paid_at: now } },
            { session }
          );
          await col('transactions').insertOne(
            {
              id: uuidv4(),
              chama_id: dist.chama_id,
              user_id: s.user_id,
              type: 'dividend',
              amount_cents: s.amount_cents,
              status: 'completed',
              reference_type: 'distribution_share',
              reference_id: s.id,
              created_at: now,
            },
            { session }
          );
        }
      });

      const d = await col('distributions').findOne({ id: distId });
      res.json({ distribution: d, message: 'Distribution completed' });
    } catch (err) {
      if (err.message === 'Insufficient balance') {
        return res.status(400).json({ error: 'Insufficient wallet balance' });
      }
      next(err);
    }
  }
);

router.get(
  '/chama/:chamaId',
  requireAuth,
  loadUser,
  param('chamaId').isUUID(),
  q('status').optional().isIn(['pending', 'approved', 'completed']),
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
      if (req.query.status) filter.status = req.query.status;
      const distributions = await col('distributions')
        .find(filter)
        .sort({ created_at: -1 })
        .toArray();
      res.json({ distributions });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
