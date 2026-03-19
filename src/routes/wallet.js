import { Router } from 'express';
import { param, body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import { col } from '../db/index.js';
import { requireAuth, loadUser } from '../middleware/auth.js';
import { getChamaBalance, debitChamaWallet } from '../services/ledgerService.js';

const router = Router();

router.get(
  '/balance/:chamaId',
  requireAuth,
  loadUser,
  param('chamaId').isUUID(),
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
      const balance = await getChamaBalance(chamaId);
      res.json(balance);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/withdraw',
  requireAuth,
  loadUser,
  [
    body('chama_id').isUUID().withMessage('Valid chama_id required'),
    body('amount_cents').isInt({ min: 1 }).withMessage('Amount must be positive'),
    body('reason').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { chama_id, amount_cents, reason } = req.body;

      const member = await col('chama_members').findOne({
        chama_id: chama_id,
        user_id: req.user.id,
        status: 'active',
      });
      if (!member) {
        return res.status(404).json({ error: 'Chama not found or access denied' });
      }
      if (member.role !== 'founder' && member.role !== 'admin') {
        return res.status(403).json({ error: 'Only founder or admin can withdraw' });
      }

      await debitChamaWallet(chama_id, amount_cents, 'withdrawal', 'withdrawal', null);

      await col('transactions').insertOne({
        id: uuidv4(),
        chama_id,
        user_id: req.user.id,
        type: 'withdrawal',
        amount_cents: amount_cents,
        status: 'completed',
        reference_type: 'withdrawal',
        metadata: reason ? { reason } : null,
        created_at: new Date(),
      });

      const balance = await getChamaBalance(chama_id);
      res.json({ message: 'Withdrawal successful', balance });
    } catch (err) {
      if (err.message === 'Insufficient balance') {
        return res.status(400).json({ error: 'Insufficient wallet balance' });
      }
      next(err);
    }
  }
);

export default router;
