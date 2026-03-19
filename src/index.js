import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { connect } from './db/index.js';
import authRoutes from './routes/auth.js';
import chamasRoutes from './routes/chamas.js';
import walletRoutes from './routes/wallet.js';
import contributionsRoutes from './routes/contributions.js';
import loansRoutes from './routes/loans.js';
import transactionsRoutes from './routes/transactions.js';
import notificationsRoutes from './routes/notifications.js';
import invitationsRoutes from './routes/invitations.js';
import distributionsRoutes from './routes/distributions.js';
import adminRoutes from './routes/admin.js';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/chamas', chamasRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/contributions', contributionsRoutes);
app.use('/api/loans', loansRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/invitations', invitationsRoutes);
app.use('/api/distributions', distributionsRoutes);
app.use('/api/admin', adminRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

connect()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Chama Wallet API running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });
