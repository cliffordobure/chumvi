import { Router } from 'express';
import { param, query as q, validationResult } from 'express-validator';
import { col } from '../db/index.js';
import { requireAuth, loadUser } from '../middleware/auth.js';

const router = Router();

router.get(
  '/:chamaId',
  requireAuth,
  loadUser,
  param('chamaId').isUUID(),
  q('type').optional().isIn(['contribution', 'loan_disbursement', 'loan_repayment', 'dividend', 'withdrawal']),
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
      if (req.query.type) filter.type = req.query.type;
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
      const offset = parseInt(req.query.offset, 10) || 0;

      const transactions = await col('transactions')
        .find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .toArray();

      res.json({ transactions });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
