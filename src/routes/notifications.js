import { Router } from 'express';
import { col } from '../db/index.js';
import { requireAuth, loadUser } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, loadUser, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const unreadOnly = req.query.unread === 'true';

    const filter = { user_id: req.user.id };
    if (unreadOnly) filter.read_at = null;

    const notifications = await col('notifications')
      .find(filter)
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    const total = await col('notifications').countDocuments(filter);

    res.json({
      notifications,
      total,
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/read', requireAuth, loadUser, async (req, res, next) => {
  try {
    const r = await col('notifications').updateOne(
      { id: req.params.id, user_id: req.user.id, read_at: null },
      { $set: { read_at: new Date() } }
    );
    if (r.matchedCount === 0) {
      return res.status(404).json({ error: 'Notification not found or already read' });
    }
    res.json({ message: 'Marked as read' });
  } catch (err) {
    next(err);
  }
});

router.post('/read-all', requireAuth, loadUser, async (req, res, next) => {
  try {
    await col('notifications').updateMany(
      { user_id: req.user.id, read_at: null },
      { $set: { read_at: new Date() } }
    );
    res.json({ message: 'All marked as read' });
  } catch (err) {
    next(err);
  }
});

export default router;
