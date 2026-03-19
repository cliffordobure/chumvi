import jwt from 'jsonwebtoken';
import { col } from '../db/index.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: decoded.userId, role: decoded.role };
    return next();
  } catch {
    req.user = null;
    return next();
  }
}

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: decoded.userId, role: decoded.role };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

export async function loadUser(req, res, next) {
  if (!req.user?.id) return next();
  try {
    const u = await col('users').findOne(
      { id: req.user.id },
      { projection: { password_hash: 0 } }
    );
    if (!u) {
      return res.status(401).json({ error: 'User not found' });
    }
    if (u.is_suspended) {
      return res.status(403).json({ error: 'Account suspended' });
    }
    req.user = u;
    next();
  } catch (err) {
    next(err);
  }
}
