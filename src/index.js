import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { connect, isConnected } from './db/index.js';
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
  const dbOk = isConnected();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    database: dbOk ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// Return 503 when DB is down so frontend gets a clear message instead of 500 "Database not connected"
app.use('/api', (req, res, next) => {
  if (!isConnected()) {
    return res.status(503).json({
      error: 'Service temporarily unavailable. Please try again in a moment.',
    });
  }
  next();
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

// Start server first so the process binds to PORT (required by Render/Heroku).
// Retry MongoDB connection in the background until success (e.g. after fixing Atlas Network Access).
async function connectWithRetry() {
  const intervalMs = 10000; // 10 seconds
  for (;;) {
    try {
      await connect();
      console.log('MongoDB connected');
      return;
    } catch (err) {
      console.error('MongoDB connection failed:', err.message);
      console.log(`Retrying in ${intervalMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

app.listen(PORT, () => {
  console.log(`Chama Wallet API listening on port ${PORT}`);
  connectWithRetry();
});
