import { Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import { col } from '../db/index.js';
import { requireAuth, loadUser } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
const INVITE_EXPIRY_DAYS = 7;

router.post(
  '/',
  requireAuth,
  loadUser,
  [
    body('chama_id').isUUID().withMessage('Valid chama_id required'),
    body('email').optional().isEmail().normalizeEmail(),
    body('phone').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { chama_id, email, phone } = req.body;
      if (!email && !phone) {
        return res.status(400).json({ error: 'Provide email or phone' });
      }

      const member = await col('chama_members').findOne({
        chama_id,
        user_id: req.user.id,
        status: 'active',
      });
      if (!member) return res.status(404).json({ error: 'Chama not found or access denied' });
      if (member.role !== 'founder' && member.role !== 'admin') {
        return res.status(403).json({ error: 'Only founder or admin can invite' });
      }

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + INVITE_EXPIRY_DAYS);
      const token = uuidv4().replace(/-/g, '');

      if (email) {
        const existingMember = await col('users').findOne({ email });
        if (existingMember) {
          const inChama = await col('chama_members').findOne({
            chama_id,
            user_id: existingMember.id,
          });
          if (inChama) return res.status(409).json({ error: 'User already in chama' });
        }
        await col('invitations').updateOne(
          { chama_id, email },
          {
            $setOnInsert: { id: uuidv4() },
            $set: {
              inviter_id: req.user.id,
              token,
              status: 'pending',
              expires_at: expiresAt,
            },
          },
          { upsert: true }
        );
      }
      if (phone) {
        const existingMember = await col('users').findOne({ phone });
        if (existingMember) {
          const inChama = await col('chama_members').findOne({
            chama_id,
            user_id: existingMember.id,
          });
          if (inChama) return res.status(409).json({ error: 'User already in chama' });
        }
        await col('invitations').updateOne(
          { chama_id, phone },
          {
            $setOnInsert: { id: uuidv4() },
            $set: {
              inviter_id: req.user.id,
              token,
              status: 'pending',
              expires_at: expiresAt,
            },
          },
          { upsert: true }
        );
      }

      const inviteLink = `${process.env.WEB_URL || 'http://localhost:5173'}/invite/${token}`;
      res.status(201).json({
        message: 'Invitation sent',
        token,
        invite_link: inviteLink,
        expires_at: expiresAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/accept',
  requireAuth,
  loadUser,
  [body('token').notEmpty().trim().withMessage('Token required')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const token = req.body.token;

      const inv = await col('invitations').findOne({
        token,
        status: 'pending',
        expires_at: { $gt: new Date() },
      });
      if (!inv) {
        return res.status(400).json({ error: 'Invalid or expired invitation' });
      }
      let match = false;
      if (inv.email && req.user.email && inv.email.toLowerCase() === req.user.email.toLowerCase()) match = true;
      if (inv.phone && req.user.phone && inv.phone === req.user.phone) match = true;
      if (!match) {
        return res.status(403).json({ error: 'This invitation was sent to a different email or phone' });
      }

      const existing = await col('chama_members').findOne({
        chama_id: inv.chama_id,
        user_id: req.user.id,
      });
      if (existing) {
        await col('invitations').updateOne(
          { token },
          { $set: { status: 'accepted' } }
        );
        return res.status(409).json({ error: 'You are already a member' });
      }

      await col('chama_members').insertOne({
        id: uuidv4(),
        chama_id: inv.chama_id,
        user_id: req.user.id,
        role: 'member',
        status: 'active',
        joined_at: new Date(),
      });
      await col('invitations').updateOne(
        { token },
        { $set: { status: 'accepted' } }
      );

      const chama = await col('chamas').findOne(
        { id: inv.chama_id },
        { projection: { id: 1, name: 1 } }
      );
      res.json({ message: 'You have joined the chama', chama });
    } catch (err) {
      next(err);
    }
  }
);

function randomPassword(length = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < length; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/**
 * Add a member directly: create account (if needed) with email + optional password and add to chama.
 * Founder/admin only. If user exists, just add to chama; if not, create user (password optional—we generate one if missing).
 */
router.post(
  '/add-member',
  requireAuth,
  loadUser,
  [
    body('chama_id').isUUID().withMessage('Valid chama_id required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('name').trim().isLength({ min: 2 }).withMessage('Name required (min 2 chars)'),
    body('password').optional().isLength({ min: 6 }).withMessage('Password min 6 characters if provided'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      let { chama_id, email, name, password } = req.body;
      let temp_password = null;
      if (!password || password.length < 6) {
        password = randomPassword(12);
        temp_password = password;
      }

      const member = await col('chama_members').findOne({
        chama_id,
        user_id: req.user.id,
        status: 'active',
      });
      if (!member) return res.status(404).json({ error: 'Chama not found or access denied' });
      if (member.role !== 'founder' && member.role !== 'admin') {
        return res.status(403).json({ error: 'Only founder or admin can add members' });
      }

      const chama = await col('chamas').findOne({ id: chama_id });
      if (!chama) return res.status(404).json({ error: 'Chama not found' });

      let user = await col('users').findOne({ email });
      let createdUser = false;
      if (user) {
        const alreadyIn = await col('chama_members').findOne({ chama_id, user_id: user.id });
        if (alreadyIn) return res.status(409).json({ error: 'User is already a member' });
      } else {
        const passwordHash = await bcrypt.hash(password, 12);
        const userId = uuidv4();
        const now = new Date();
        await col('users').insertOne({
          id: userId,
          name: name.trim(),
          email,
          phone: null,
          password_hash: passwordHash,
          national_id: null,
          role: 'member',
          created_at: now,
          updated_at: now,
        });
        user = await col('users').findOne({ id: userId }, { projection: { password_hash: 0 } });
        createdUser = true;
      }

      await col('chama_members').insertOne({
        id: uuidv4(),
        chama_id,
        user_id: user.id,
        role: 'member',
        status: 'active',
        joined_at: new Date(),
      });

      const payload = {
        message: createdUser ? 'Account created and member added' : 'Member added',
        user: { id: user.id, name: user.name, email: user.email },
      };
      if (temp_password) payload.temp_password = temp_password;
      res.status(201).json(payload);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/by-token/:token', param('token').notEmpty(), async (req, res, next) => {
  try {
    const inv = await col('invitations').findOne({ token: req.params.token });
    if (!inv) return res.status(404).json({ error: 'Invitation not found' });
    if (inv.status !== 'pending' || new Date(inv.expires_at) <= new Date()) {
      return res.status(400).json({ error: 'Invitation expired or already used' });
    }
    const chama = await col('chamas').findOne(
      { id: inv.chama_id },
      { projection: { name: 1 } }
    );
    res.json({
      chama_name: chama?.name,
      chama_id: inv.chama_id,
      expires_at: inv.expires_at,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
