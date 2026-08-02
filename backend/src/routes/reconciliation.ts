import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

interface BankTxn {
  id: string; description: string; transaction_date: string; amount: number;
  direction: string; reference: string | null; parsed_merchant: string | null;
}

interface ExtractedItem {
  id: string; merchant: string; amount: number; transaction_date: string;
  invoice_number: string | null;
}

function normalizeMerchant(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fuzzyMatch(a: string, b: string): number {
  const na = normalizeMerchant(a);
  const nb = normalizeMerchant(b);
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return 85;
  // Simple Levenshtein-ish
  let matches = 0;
  const minLen = Math.min(na.length, nb.length);
  for (let i = 0; i < minLen; i++) if (na[i] === nb[i]) matches++;
  return Math.round((matches / Math.max(na.length, nb.length)) * 100);
}

function computeMatchConfidence(bank: BankTxn, item: ExtractedItem): { confidence: number; detail: string; match_type: string; amount_diff: number; date_gap_days: number } {
  const amountDiff = Math.abs(bank.amount - item.amount);
  const amountScore = amountDiff < 0.01 ? 100 : amountDiff < 1 ? 80 : amountDiff < 5 ? 60 : 30;
  const date1 = new Date(bank.transaction_date);
  const date2 = new Date(item.transaction_date);
  const dateGap = Math.abs(Math.round((date1.getTime() - date2.getTime()) / (1000 * 60 * 60 * 24)));
  const dateScore = dateGap === 0 ? 100 : dateGap <= 2 ? 80 : dateGap <= 7 ? 60 : 30;
  const merchantScore = fuzzyMatch(bank.description, item.merchant);
  const refScore = (bank.reference && item.invoice_number && bank.reference.toUpperCase() === item.invoice_number.toUpperCase()) ? 100 : 0;

  let confidence = Math.round((amountScore + dateScore + merchantScore) / 3);
  let matchType = 'fuzzy';
  let detail = `Amount ${amountScore >= 80 ? '✓' : '≈'} · Date ${dateScore >= 80 ? '✓' : '≈'} · Merchant ${merchantScore >= 80 ? '✓' : '≈'}`;

  if (refScore === 100) {
    confidence = Math.min(99, confidence + 15);
    matchType = 'reference';
    detail += ' · Reference ✓';
  }
  if (amountDiff < 0.01 && dateGap === 0 && merchantScore >= 85) {
    confidence = 99;
    matchType = 'exact';
    detail = 'Amount ✓ · Date ✓ · Merchant ✓';
  }

  return { confidence, detail, match_type: matchType, amount_diff: amountDiff, date_gap_days: dateGap };
}

router.post('/import', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { transactions } = req.body as { transactions: Omit<BankTxn, 'id'>[] };
    if (!transactions?.length) return res.status(400).json({ error: 'No transactions provided' });

    const inserted = [];
    for (const txn of transactions) {
      const { data, error } = await supabase.from('bank_transactions').insert({
        user_id: userId,
        description: txn.description,
        transaction_date: txn.transaction_date,
        amount: txn.amount,
        direction: txn.direction,
        reference: txn.reference,
        parsed_merchant: txn.description.split(' ')[0]
      }).select().single();
      if (error) throw error;
      inserted.push(data);
    }

    // Auto-match against extracted items
    const { data: items } = await supabase.from('extracted_items').select('*').eq('user_id', userId).eq('status', 'approved');
    const matches = [];
    for (const txn of inserted) {
      for (const item of (items || [])) {
        const result = computeMatchConfidence(txn, item);
        if (result.confidence >= 50) {
          const { data: match } = await supabase.from('reconciliation_matches').insert({
            user_id: userId,
            bank_transaction_id: txn.id,
            extracted_item_id: item.id,
            match_type: result.match_type,
            confidence: result.confidence,
            detail: result.detail,
            amount_diff: result.amount_diff,
            date_gap_days: result.date_gap_days,
            status: result.confidence >= 95 ? 'approved' : 'pending'
          }).select().single();
          matches.push(match);
        }
      }
    }

    res.json({ imported: inserted.length, matches_found: matches.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/matches', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const status = req.query.status as string | undefined;
    let query = supabase.from('reconciliation_matches')
      .select(`*, bank_transaction:bank_transaction_id(*), extracted_item:extracted_item_id(*)`)
      .eq('user_id', userId)
      .order('confidence', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/matches/:id/approve', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { data, error } = await supabase.from('reconciliation_matches').update({ status: 'approved' }).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw error;
    await supabase.from('audit_log').insert({ user_id: userId, action: 'Match approved', entity_type: 'reconciliation_match', entity_id: id, change_summary: `Match approved` });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/matches/:id/reject', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { data, error } = await supabase.from('reconciliation_matches').update({ status: 'rejected' }).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw error;
    await supabase.from('audit_log').insert({ user_id: userId, action: 'Match rejected', entity_type: 'reconciliation_match', entity_id: id, change_summary: `Match rejected` });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk-approve-matches', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No IDs provided' });
    const { data, error } = await supabase.from('reconciliation_matches').update({ status: 'approved' }).in('id', ids).eq('user_id', userId).select();
    if (error) throw error;
    await supabase.from('audit_log').insert({ user_id: userId, action: 'Bulk matches approved', entity_type: 'reconciliation_match', change_summary: `${ids.length} matches approved` });
    res.json({ approved: data?.length || 0 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
