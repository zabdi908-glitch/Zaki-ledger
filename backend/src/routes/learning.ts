import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.post('/learn', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { merchant, category, amount, transaction_date } = req.body;
    if (!merchant || !category) return res.status(400).json({ error: 'Missing merchant or category' });

    const date = new Date(transaction_date);
    const hour = date.getHours();
    const dayOfWeek = date.getDay();
    const merchantKey = merchant.toLowerCase().trim();

    // Check existing preference
    const { data: existing } = await supabase
      .from('user_merchant_preferences')
      .select('*')
      .eq('user_id', userId)
      .eq('merchant_key', merchantKey)
      .eq('category', category)
      .single();

    if (existing) {
      const newCount = (existing.approval_count || 0) + 1;
      const newConfidence = Math.min(99, 60 + newCount * 10);
      const { data, error } = await supabase
        .from('user_merchant_preferences')
        .update({
          approval_count: newCount,
          confidence_score: newConfidence,
          last_used_at: new Date().toISOString(),
          time_window_start: existing.time_window_start ?? hour,
          time_window_end: existing.time_window_end ?? hour,
          amount_min: existing.amount_min ? Math.min(existing.amount_min, amount) : amount,
          amount_max: existing.amount_max ? Math.max(existing.amount_max, amount) : amount
        })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      return res.json({ learned: true, preference: data });
    }

    // Create new preference
    const { data, error } = await supabase
      .from('user_merchant_preferences')
      .insert({
        user_id: userId,
        merchant_key: merchantKey,
        category,
        time_window_start: hour,
        time_window_end: hour,
        amount_min: amount,
        amount_max: amount,
        day_of_week: dayOfWeek,
        approval_count: 1,
        confidence_score: 70
      })
      .select()
      .single();
    if (error) throw error;

    res.json({ learned: true, preference: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/patterns', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { data, error } = await supabase
      .from('user_merchant_preferences')
      .select('*')
      .eq('user_id', userId)
      .order('confidence_score', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/suggest-category', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { merchant, amount, date } = req.query as Record<string, string>;
    if (!merchant) return res.status(400).json({ error: 'Missing merchant' });

    const txnDate = new Date(date || new Date());
    const hour = txnDate.getHours();
    const merchantKey = merchant.toLowerCase().trim();

    const { data: prefs } = await supabase
      .from('user_merchant_preferences')
      .select('*')
      .eq('user_id', userId)
      .eq('merchant_key', merchantKey)
      .order('confidence_score', { ascending: false });

    if (!prefs?.length) return res.json({ suggestion: null, confidence: 0, reason: 'No learned patterns for this merchant' });

    // Find best matching preference by time/amount
    let best = prefs[0];
    for (const p of prefs) {
      const timeMatch = p.time_window_start !== null && hour >= p.time_window_start && hour <= p.time_window_end;
      const amountMatch = p.amount_min !== null && amount && parseFloat(amount) >= p.amount_min && parseFloat(amount) <= p.amount_max;
      if (timeMatch || amountMatch) {
        best = p;
        break;
      }
    }

    res.json({
      suggestion: best.category,
      confidence: best.confidence_score,
      based_on: `${best.approval_count} previous approval${best.approval_count > 1 ? 's' : ''}`,
      reason: best.confidence_score >= 95 ? 'Auto-approve based on learned pattern' : 'Suggested based on previous decisions'
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
