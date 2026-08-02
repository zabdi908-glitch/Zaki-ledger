import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.get('/stats', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;

    const { data: items } = await supabase.from('extracted_items').select('*').eq('user_id', userId);
    const { data: pendingItems } = await supabase.from('extracted_items').select('*').eq('user_id', userId).eq('status', 'pending');
    const { data: matches } = await supabase.from('reconciliation_matches').select('*').eq('user_id', userId);
    const { data: pendingMatches } = await supabase.from('reconciliation_matches').select('*').eq('user_id', userId).eq('status', 'pending');
    const { data: audit } = await supabase.from('audit_log').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(10);
    const { data: patterns } = await supabase.from('user_merchant_preferences').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(5);

    const totalItems = items?.length || 0;
    const pendingCount = pendingItems?.length || 0;
    const approvedCount = items?.filter(i => i.status === 'approved').length || 0;
    const rejectedCount = items?.filter(i => i.status === 'rejected').length || 0;
    const avgConfidence = totalItems > 0
      ? Math.round(items!.reduce((a, i) => a + (i.overall_confidence || 0), 0) / totalItems)
      : 0;

    const totalMatches = matches?.length || 0;
    const pendingMatchCount = pendingMatches?.length || 0;
    const approvedMatchCount = matches?.filter(m => m.status === 'approved').length || 0;

    res.json({
      items: { total: totalItems, pending: pendingCount, approved: approvedCount, rejected: rejectedCount, avg_confidence: avgConfidence },
      matches: { total: totalMatches, pending: pendingMatchCount, approved: approvedMatchCount },
      recent_activity: audit?.map(a => ({ text: a.action, time: a.created_at, entity: a.change_summary })) || [],
      learned_patterns: patterns?.map(p => ({
        merchant: p.merchant_key,
        category: p.category,
        confidence: p.confidence_score,
        approvals: p.approval_count
      })) || []
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
