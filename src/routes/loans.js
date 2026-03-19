import { Router } from 'express';
import { body, param, query as q, validationResult } from 'express-validator';
import { col } from '../db/index.js';
import { requireAuth, loadUser } from '../middleware/auth.js';
import { debitChamaWallet, creditChamaWallet } from '../services/ledgerService.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

router.post(
  '/request',
  requireAuth,
  loadUser,
  [
    body('chama_id').isUUID().withMessage('Valid chama_id required'),
    body('amount_cents').isInt({ min: 1 }).withMessage('Amount must be positive'),
    body('repayment_period_months').optional().isInt({ min: 1, max: 60 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const chamaId = req.body.chama_id;
      const amountCents = req.body.amount_cents;
      const repaymentPeriodMonths = req.body.repayment_period_months || 1;

      const chama = await col('chamas').findOne({ id: chamaId });
      if (!chama) {
        return res.status(404).json({ error: 'Chama not found' });
      }
      const { loan_interest_percent, max_loan_amount_cents } = chama;
      if (max_loan_amount_cents != null && amountCents > Number(max_loan_amount_cents)) {
        return res.status(400).json({ error: 'Amount exceeds maximum loan amount' });
      }

      const member = await col('chama_members').findOne({
        chama_id: chamaId,
        user_id: req.user.id,
        status: 'active',
      });
      if (!member) {
        return res.status(403).json({ error: 'You are not a member of this chama' });
      }

      const interestPercent = Number(loan_interest_percent ?? 0);
      const totalRepaymentCents = Math.round(amountCents * (1 + interestPercent / 100));
      const dueAt = new Date();
      dueAt.setMonth(dueAt.getMonth() + repaymentPeriodMonths);

      const loanId = uuidv4();
      const now = new Date();
      await col('loans').insertOne({
        id: loanId,
        chama_id: chamaId,
        borrower_id: req.user.id,
        amount_cents: amountCents,
        interest_percent: interestPercent,
        total_repayment_cents: totalRepaymentCents,
        repaid_cents: 0,
        repayment_period_months: repaymentPeriodMonths,
        status: 'pending',
        approved_by_count: 0,
        rejected_by_count: 0,
        due_at: dueAt,
        created_at: now,
        updated_at: now,
      });

      const voters = await col('chama_members')
        .find({ chama_id: chamaId, user_id: { $ne: req.user.id }, status: 'active' })
        .toArray();
      const notifs = voters.map((v) => ({
        id: uuidv4(),
        user_id: v.user_id,
        title: 'New loan request',
        body: `Loan request of ${amountCents / 100} for your vote.`,
        type: 'loan_request',
        reference_type: 'loan',
        reference_id: loanId,
        created_at: now,
      }));
      if (notifs.length) await col('notifications').insertMany(notifs);

      const loan = await col('loans').findOne({ id: loanId });
      res.status(201).json({ loan });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/vote',
  requireAuth,
  loadUser,
  [
    body('loan_id').isUUID().withMessage('Valid loan_id required'),
    body('vote').isIn(['approve', 'reject']).withMessage('Vote must be approve or reject'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { loan_id, vote } = req.body;

      const loan = await col('loans').findOne({ id: loan_id });
      if (!loan) {
        return res.status(404).json({ error: 'Loan not found' });
      }
      const chama = await col('chamas').findOne({ id: loan.chama_id });
      if (!chama) return res.status(404).json({ error: 'Chama not found' });

      if (loan.status !== 'pending') {
        return res.status(400).json({ error: 'Loan is no longer pending' });
      }
      if (loan.borrower_id === req.user.id) {
        return res.status(400).json({ error: 'Borrower cannot vote on own loan' });
      }

      const member = await col('chama_members').findOne({
        chama_id: loan.chama_id,
        user_id: req.user.id,
        status: 'active',
      });
      if (!member) {
        return res.status(403).json({ error: 'You are not a member of this chama' });
      }

      const existingVote = await col('loan_votes').findOne({ loan_id, member_id: req.user.id });
      if (existingVote) {
        return res.status(400).json({ error: 'You have already voted' });
      }

      await col('loan_votes').insertOne({
        id: uuidv4(),
        loan_id,
        member_id: req.user.id,
        vote,
        created_at: new Date(),
      });

      const incApproved = vote === 'approve' ? 1 : 0;
      const incRejected = vote === 'reject' ? 1 : 0;
      await col('loans').updateOne(
        { id: loan_id },
        {
          $inc: { approved_by_count: incApproved, rejected_by_count: incRejected },
          $set: { updated_at: new Date() },
        }
      );

      const updated = await col('loans').findOne({ id: loan_id });
      const votesRequired = chama.loan_approval_votes_required ?? 1;
      if (updated.approved_by_count >= votesRequired) {
        await col('loans').updateOne(
          { id: loan_id },
          { $set: { status: 'approved', approved_at: new Date(), updated_at: new Date() } }
        );
        await col('notifications').insertOne({
          id: uuidv4(),
          user_id: loan.borrower_id,
          title: 'Loan approved',
          body: 'Your loan request has been approved.',
          type: 'loan_approved',
          reference_type: 'loan',
          reference_id: loan_id,
          created_at: new Date(),
        });
      }

      const loanAfter = await col('loans').findOne({ id: loan_id });
      res.json({ loan: loanAfter, message: 'Vote recorded' });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/disburse',
  requireAuth,
  loadUser,
  [body('loan_id').isUUID().withMessage('Valid loan_id required')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const loanId = req.body.loan_id;

      const loan = await col('loans').findOne({ id: loanId });
      if (!loan) return res.status(404).json({ error: 'Loan not found' });
      if (loan.status !== 'approved') {
        return res.status(400).json({ error: 'Loan must be in approved status to disburse' });
      }

      const member = await col('chama_members').findOne({
        chama_id: loan.chama_id,
        user_id: req.user.id,
        status: 'active',
      });
      if (!member) return res.status(403).json({ error: 'Not a member' });
      if (member.role !== 'founder' && member.role !== 'admin') {
        return res.status(403).json({ error: 'Only founder or admin can disburse' });
      }

      await debitChamaWallet(loan.chama_id, loan.amount_cents, 'loan_disbursement', 'loan', loanId);

      const now = new Date();
      await col('loans').updateOne(
        { id: loanId },
        { $set: { status: 'active', disbursed_at: now, updated_at: now } }
      );
      await col('transactions').insertOne({
        id: uuidv4(),
        chama_id: loan.chama_id,
        user_id: loan.borrower_id,
        type: 'loan_disbursement',
        amount_cents: loan.amount_cents,
        status: 'completed',
        reference_type: 'loan',
        reference_id: loanId,
        created_at: now,
      });
      await col('notifications').insertOne({
        id: uuidv4(),
        user_id: loan.borrower_id,
        title: 'Loan disbursed',
        body: 'Your loan has been disbursed.',
        type: 'loan_disbursed',
        reference_type: 'loan',
        reference_id: loanId,
        created_at: now,
      });

      const updatedLoan = await col('loans').findOne({ id: loanId });
      res.json({ loan: updatedLoan, message: 'Loan disbursed' });
    } catch (err) {
      if (err.message === 'Insufficient balance') {
        return res.status(400).json({ error: 'Insufficient chama wallet balance to disburse loan' });
      }
      next(err);
    }
  }
);

router.post(
  '/repay',
  requireAuth,
  loadUser,
  [
    body('loan_id').isUUID().withMessage('Valid loan_id required'),
    body('amount_cents').isInt({ min: 1 }).withMessage('Amount must be positive'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { loan_id, amount_cents } = req.body;

      const loan = await col('loans').findOne({ id: loan_id });
      if (!loan) return res.status(404).json({ error: 'Loan not found' });
      if (loan.borrower_id !== req.user.id) {
        return res.status(403).json({ error: 'You can only repay your own loan' });
      }
      if (loan.status !== 'active') {
        return res.status(400).json({ error: 'Loan is not active' });
      }
      const remaining = Number(loan.total_repayment_cents) - Number(loan.repaid_cents ?? 0);
      if (amount_cents > remaining) {
        return res.status(400).json({ error: `Maximum repayment is ${remaining} cents` });
      }

      await creditChamaWallet(loan.chama_id, amount_cents, 'loan_repayment', 'loan', loan_id);

      const newRepaid = Number(loan.repaid_cents ?? 0) + amount_cents;
      const newStatus = newRepaid >= Number(loan.total_repayment_cents) ? 'repaid' : 'active';
      const now = new Date();
      await col('loan_repayments').insertOne({
        id: uuidv4(),
        loan_id,
        amount_cents,
        repaid_at: now,
        created_at: now,
      });
      await col('loans').updateOne(
        { id: loan_id },
        { $set: { repaid_cents: newRepaid, status: newStatus, updated_at: now } }
      );
      await col('transactions').insertOne({
        id: uuidv4(),
        chama_id: loan.chama_id,
        user_id: req.user.id,
        type: 'loan_repayment',
        amount_cents,
        status: 'completed',
        reference_type: 'loan',
        reference_id: loan_id,
        created_at: now,
      });

      const updated = await col('loans').findOne({ id: loan_id });
      res.json({ loan: updated, message: 'Repayment recorded' });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/chama/:chamaId',
  requireAuth,
  loadUser,
  param('chamaId').isUUID(),
  q('status').optional().isIn(['pending', 'approved', 'active', 'rejected', 'repaid', 'defaulted']),
  q('borrower_id').optional().isUUID(),
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
      if (req.query.status) filter.status = req.query.status;
      if (req.query.borrower_id) filter.borrower_id = req.query.borrower_id;
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
      const offset = parseInt(req.query.offset, 10) || 0;

      const loans = await col('loans')
        .find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .toArray();

      const userIds = [...new Set(loans.map((l) => l.borrower_id))];
      const users = await col('users').find({ id: { $in: userIds } }).toArray();
      const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
      const result = loans.map((l) => ({
        ...l,
        borrower_name: userMap[l.borrower_id]?.name,
        borrower_email: userMap[l.borrower_id]?.email,
      }));

      res.json({ loans: result });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:loanId',
  requireAuth,
  loadUser,
  param('loanId').isUUID(),
  async (req, res, next) => {
    try {
      const loanId = req.params.loanId;
      const loan = await col('loans').findOne({ id: loanId });
      if (!loan) return res.status(404).json({ error: 'Loan not found' });
      const borrower = await col('users').findOne({ id: loan.borrower_id });
      const member = await col('chama_members').findOne({
        chama_id: loan.chama_id,
        user_id: req.user.id,
        status: 'active',
      });
      if (!member) return res.status(404).json({ error: 'Access denied' });
      const votes = await col('loan_votes').find({ loan_id: loanId }).toArray();
      const voterIds = [...new Set(votes.map((v) => v.member_id))];
      const voters = await col('users').find({ id: { $in: voterIds } }).toArray();
      const voterMap = Object.fromEntries(voters.map((u) => [u.id, u]));
      const votesWithNames = votes.map((v) => ({
        member_id: v.member_id,
        vote: v.vote,
        name: voterMap[v.member_id]?.name,
      }));
      res.json({
        loan: { ...loan, borrower_name: borrower?.name, borrower_email: borrower?.email },
        votes: votesWithNames,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
