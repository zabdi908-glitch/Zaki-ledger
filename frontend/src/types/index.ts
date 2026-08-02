export interface ExtractedItem {
  id: string;
  merchant: string;
  merchant_confidence: number;
  merchant_confidence_reason: string | null;
  invoice_number: string;
  invoice_number_confidence: number;
  invoice_number_confidence_reason: string | null;
  transaction_date: string;
  date_confidence: number;
  date_confidence_reason: string | null;
  amount: number;
  amount_confidence: number;
  amount_confidence_reason: string | null;
  tax_amount: number;
  tax_confidence: number;
  tax_confidence_reason: string | null;
  category: string;
  category_confidence: number;
  category_confidence_reason: string | null;
  overall_confidence: number;
  reason: string | null;
  needs_review: boolean;
  status: 'pending' | 'approved' | 'rejected' | 'posted';
  created_at: string;
}

export interface ReconciliationMatch {
  id: string;
  bank_transaction_id: string;
  extracted_item_id: string;
  match_type: string;
  confidence: number;
  detail: string;
  status: 'pending' | 'approved' | 'rejected';
  amount_diff: number;
  date_gap_days: number;
  bank_transaction: {
    description: string;
    transaction_date: string;
    amount: number;
  };
  extracted_item: {
    merchant: string;
    transaction_date: string;
    amount: number;
  };
}

export interface DashboardStats {
  items: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    avg_confidence: number;
  };
  matches: {
    total: number;
    pending: number;
    approved: number;
  };
  recent_activity: Array<{ text: string; time: string; entity: string }>;
  learned_patterns: Array<{
    merchant: string;
    category: string;
    confidence: number;
    approvals: number;
  }>;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  change_summary: string;
  created_at: string;
}
