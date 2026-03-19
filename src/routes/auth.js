import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { col } from '../db/index.js';
import { requireAuth, loadUser } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function sanitizeUser(doc) {
  if (!doc) return null;
  const { password_hash, _id, ...rest } = doc;
  return rest;
}

router.post(
  '/register',
  [
    body('name').trim().isLength({ min: 2 }).withMessage('Name required (min 2 chars)'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password min 6 characters'),
    body('phone').optional().trim(),
    body('national_id').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { name, email, password, phone, national_id } = req.body;

      const existing = await col('users').findOne({ email });
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const id = uuidv4();
      const now = new Date();
      await col('users').insertOne({
        id,
        name,
        email,
        phone: phone || null,
        password_hash: passwordHash,
        national_id: national_id || null,
        role: 'member',
        created_at: now,
        updated_at: now,
      });

      const token = jwt.sign({ userId: id, role: 'member' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      const user = await col('users').findOne({ id }, { projection: { password_hash: 0 } });

      res.status(201).json({
        message: 'Registration successful',
        token,
        expiresIn: JWT_EXPIRES_IN,
        user: sanitizeUser(user),
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty().withMessage('Password required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { email, password } = req.body;

      const user = await col('users').findOne({ email });
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      if (user.is_suspended) {
        return res.status(403).json({ error: 'Account suspended' });
      }
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      const profile = await col('users').findOne(
        { id: user.id },
        { projection: { password_hash: 0 } }
      );

      res.json({
        token,
        expiresIn: JWT_EXPIRES_IN,
        user: sanitizeUser(profile),
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/me', requireAuth, loadUser, (req, res) => {
  res.json(sanitizeUser(req.user));
});

router.patch(
  '/me',
  requireAuth,
  loadUser,
  [
    body('name').optional().trim().isLength({ min: 2 }),
    body('phone').optional().trim(),
    body('national_id').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { name, phone, national_id } = req.body;
      const updates = {};
      if (name !== undefined) updates.name = name;
      if (phone !== undefined) updates.phone = phone;
      if (national_id !== undefined) updates.national_id = national_id;
      if (Object.keys(updates).length === 0) {
        return res.json({ message: 'No updates', user: sanitizeUser(req.user) });
      }
      updates.updated_at = new Date();
      await col('users').updateOne({ id: req.user.id }, { $set: updates });
      const u = await col('users').findOne({ id: req.user.id }, { projection: { password_hash: 0 } });
      res.json({ user: sanitizeUser(u) });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/change-password',
  requireAuth,
  [
    body('currentPassword').notEmpty().withMessage('Current password required'),
    body('newPassword').isLength({ min: 6 }).withMessage('New password min 6 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const user = await col('users').findOne({ id: req.user.id }, { projection: { password_hash: 1 } });
      if (!user) return res.status(401).json({ error: 'User not found' });
      const valid = await bcrypt.compare(req.body.currentPassword, user.password_hash);
      if (!valid) return res.status(400).json({ error: 'Current password incorrect' });
      const hash = await bcrypt.hash(req.body.newPassword, 12);
      await col('users').updateOne(
        { id: req.user.id },
        { $set: { password_hash: hash, updated_at: new Date() } }
      );
      res.json({ message: 'Password updated' });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/logout', requireAuth, (req, res) => {
  res.json({ message: 'Logged out' });
});

export default router;
