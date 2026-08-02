import { Router } from 'express';
import multer from 'multer';
import { supabase } from '../lib/supabase.js';
import { extractDocument, extractFromText } from '../lib/openai.js';
import { validateLowConfidence } from '../lib/claude.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/upload', requireAuth, upload.array('files', 20), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const files = req.files as Express.Multer.File[];
    if (!files?.length) return res.status(400).json({ error: 'No files uploaded' });

    const results = [];
    for (const file of files) {
      // Store file metadata
      const { data: doc, error: docErr } = await supabase
        .from('documents')
        .insert({ user_id: userId, filename: file.originalname, file_type: 'invoice', file_size: file.size, mime_type: file.mimetype, status: 'processing' })
        .select()
        .single();
      if (docErr) throw docErr;

      // Extract with OpenAI
      const base64 = file.buffer.toString('base64');
      const extraction = await extractDocument(base64, file.mimetype);

      // Fallback to Claude for low confidence
      let finalExtraction = extraction;
      if (extraction.overall_confidence < 70) {
        const fields = {
          merchant: { value: extraction.merchant, confidence: extraction.merchant_confidence },
          invoice_number: { value: extraction.invoice_number, confidence: extraction.invoice_number_confidence },
          transaction_date: { value: extraction.transaction_date, confidence: extraction.date_confidence },
          amount: { value: extraction.amount, confidence: extraction.amount_confidence },
          tax_amount: { value: extraction.tax_amount, confidence: extraction.tax_confidence },
          category: { value: extraction.category, confidence: extraction.category_confidence }
        };
        const validated = await validateLowConfidence(fields);
        if (validated.validated && Object.keys(validated.corrections).length > 0) {
          finalExtraction = { ...extraction, ...validated.corrections };
        }
      }

      // Store extracted item
      const { data: item, error: itemErr } = await supabase
        .from('extracted_items')
        .insert({
          user_id: userId,
          document_id: doc.id,
          merchant: finalExtraction.merchant,
          merchant_confidence: finalExtraction.merchant_confidence,
          invoice_number: finalExtraction.invoice_number,
          invoice_number_confidence: finalExtraction.invoice_number_confidence,
          transaction_date: finalExtraction.transaction_date,
          date_confidence: finalExtraction.date_confidence,
          amount: finalExtraction.amount,
          amount_confidence: finalExtraction.amount_confidence,
          tax_amount: finalExtraction.tax_amount,
          tax_confidence: finalExtraction.tax_confidence,
          category: finalExtraction.category,
          category_confidence: finalExtraction.category_confidence,
          overall_confidence: finalExtraction.overall_confidence,
          reason: finalExtraction.reason,
          status: finalExtraction.overall_confidence >= 95 ? 'approved' : 'pending'
        })
        .select()
        .single();
      if (itemErr) throw itemErr;

      // Update document status
      await supabase.from('documents').update({ status: 'completed', processed_at: new Date().toISOString() }).eq('id', doc.id);

      // Log audit
      await supabase.from('audit_log').insert({ user_id: userId, action: 'Document extracted', entity_type: 'extracted_item', entity_id: item.id, change_summary: `${file.originalname} → ${finalExtraction.merchant} $${finalExtraction.amount}` });

      results.push(item);
    }

    res.json({ success: true, extracted: results.length, items: results });
  } catch (err: any) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

router.get('/items', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const status = req.query.status as string | undefined;
    let query = supabase.from('extracted_items').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/items/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const updates = req.body;
    const { data, error } = await supabase.from('extracted_items').update(updates).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw error;
    await supabase.from('audit_log').insert({ user_id: userId, action: 'Item updated', entity_type: 'extracted_item', entity_id: id, change_summary: JSON.stringify(updates) });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/items/:id/approve', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { data, error } = await supabase.from('extracted_items').update({ status: 'approved' }).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw error;
    await supabase.from('audit_log').insert({ user_id: userId, action: 'Item approved', entity_type: 'extracted_item', entity_id: id, change_summary: `Approved ${data.merchant} $${data.amount}` });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/items/:id/reject', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { data, error } = await supabase.from('extracted_items').update({ status: 'rejected' }).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw error;
    await supabase.from('audit_log').insert({ user_id: userId, action: 'Item rejected', entity_type: 'extracted_item', entity_id: id, change_summary: `Rejected ${data.merchant} $${data.amount}` });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk-approve', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No IDs provided' });
    const { data, error } = await supabase.from('extracted_items').update({ status: 'approved' }).in('id', ids).eq('user_id', userId).select();
    if (error) throw error;
    await supabase.from('audit_log').insert({ user_id: userId, action: 'Bulk approved', entity_type: 'extracted_item', change_summary: `${ids.length} items approved` });
    res.json({ approved: data?.length || 0 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk-reject', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No IDs provided' });
    const { data, error } = await supabase.from('extracted_items').update({ status: 'rejected' }).in('id', ids).eq('user_id', userId).select();
    if (error) throw error;
    await supabase.from('audit_log').insert({ user_id: userId, action: 'Bulk rejected', entity_type: 'extracted_item', change_summary: `${ids.length} items rejected` });
    res.json({ rejected: data?.length || 0 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
