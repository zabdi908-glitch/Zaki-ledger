import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config();

import documentsRouter from './routes/documents.js';
import reconciliationRouter from './routes/reconciliation.js';
import learningRouter from './routes/learning.js';
import dashboardRouter from './routes/dashboard.js';
import oauthRouter from './routes/oauth.js';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

app.use('/api/documents', documentsRouter);
app.use('/api/reconciliation', reconciliationRouter);
app.use('/api/learning', learningRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/oauth', oauthRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Zaki Ledger API running on port ${PORT}`);
});
