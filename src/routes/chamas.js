import { Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import { col } from '../db/index.js';
import { requireAuth, loadUser } from '../middleware/auth.js';
import { getOrCreateChamaAccount, getChamaBalance } from '../services/ledgerService.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

router.post(
  '/create',
  requireAuth,
  loadUser,
  [
    body('name').trim().isLength({ min: 2 }).withMessage('Chama name required'),
    body('description').optional().trim(),
    body('contribution_frequency').optional().isIn(['daily', 'weekly', 'monthly']),
    body('minimum_contribution_cents').optional().isInt({ min: 0 }),
    body('loan_interest_percent').optional().isFloat({ min: 0, max: 100 }),
    body('max_loan_amount_cents').optional().isInt({ min: 0 }),
    body('loan_approval_votes_required').optional().isInt({ min: 1 }),
    body('distribution_approval_votes_required').optional().isInt({ min: 1 }),
    body('locked_savings_months').optional().isInt({ min: 0 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const {
        name,
        description,
        contribution_frequency = 'monthly',
        minimum_contribution_cents = 0,
        loan_interest_percent = 0,
        max_loan_amount_cents,
        loan_approval_votes_required = 1,
        distribution_approval_votes_required = 1,
        locked_savings_months = 0,
      } = req.body;

      const chamaId = uuidv4();
      const now = new Date();
      await col('chamas').insertOne({
        id: chamaId,
        name,
        description: description || null,
        founder_id: req.user.id,
        contribution_frequency,
        minimum_contribution_cents,
        loan_interest_percent,
        max_loan_amount_cents: max_loan_amount_cents ?? null,
        loan_approval_votes_required,
        distribution_approval_votes_required,
        locked_savings_months,
        currency: 'KES',
        is_active: true,
        created_at: now,
        updated_at: now,
      });

      await col('chama_members').insertOne({
        id: uuidv4(),
        chama_id: chamaId,
        user_id: req.user.id,
        role: 'founder',
        status: 'active',
        joined_at: now,
      });

      await getOrCreateChamaAccount(chamaId);

      const chama = await col('chamas').findOne({ id: chamaId });
      res.status(201).json({ chama });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/', requireAuth, loadUser, async (req, res, next) => {
  try {
    const memberships = await col('chama_members')
      .find({ user_id: req.user.id, status: 'active' })
      .toArray();
    const chamaIds = memberships.map((m) => m.chama_id);
    const chamas = await col('chamas')
      .find({ id: { $in: chamaIds } })
      .sort({ created_at: -1 })
      .toArray();
    const byId = Object.fromEntries(memberships.map((m) => [m.chama_id, m]));
    const result = chamas.map((c) => ({
      ...c,
      member_role: byId[c.id]?.role,
      member_status: byId[c.id]?.status,
    }));
    res.json({ chamas: result });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/:id',
  requireAuth,
  loadUser,
  param('id').isUUID(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const chamaId = req.params.id;
      const member = await col('chama_members').findOne({
        chama_id: chamaId,
        user_id: req.user.id,
      });
      if (!member) {
        return res.status(404).json({ error: 'Chama not found or access denied' });
      }

      const chama = await col('chamas').findOne({ id: chamaId });
      if (!chama) {
        return res.status(404).json({ error: 'Chama not found' });
      }

      const wallet = await getChamaBalance(chamaId);
      res.json({
        chama: { ...chama, member_role: member.role },
        wallet: {
          balance_cents: wallet.balance_cents,
          locked_balance_cents: wallet.locked_balance_cents,
          available_cents: wallet.available_cents,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:id/members',
  requireAuth,
  loadUser,
  param('id').isUUID(),
  async (req, res, next) => {
    try {
      const chamaId = req.params.id;
      const member = await col('chama_members').findOne({
        chama_id: chamaId,
        user_id: req.user.id,
        status: 'active',
      });
      if (!member) {
        return res.status(404).json({ error: 'Chama not found or access denied' });
      }

      const members = await col('chama_members')
        .find({ chama_id: chamaId, status: 'active' })
        .sort({ joined_at: 1 })
        .toArray();
      const userIds = [...new Set(members.map((m) => m.user_id))];
      const users = await col('users').find({ id: { $in: userIds } }).toArray();
      const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
      const result = members.map((m) => ({
        id: m.id,
        chama_id: m.chama_id,
        user_id: m.user_id,
        role: m.role,
        status: m.status,
        joined_at: m.joined_at,
        name: userMap[m.user_id]?.name,
        email: userMap[m.user_id]?.email,
        phone: userMap[m.user_id]?.phone,
        profile_photo_url: userMap[m.user_id]?.profile_photo_url,
      }));
      res.json({ members: result });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
