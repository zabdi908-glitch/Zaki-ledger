import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { DashboardStats } from '../types';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useNavigate } from 'react-router-dom';
import { Upload, CheckCircle, AlertTriangle, FileText, RefreshCw } from 'lucide-react';

const chartData = [
  { label: 'Feb', v: 60 }, { label: 'Mar', v: 72 }, { label: 'Apr', v: 68 },
  { label: 'May', v: 85 }, { label: 'Jun', v: 78 }, { label: 'Jul', v: 100 }
];

export default function Dashboard() {
  const navigate = useNavigate();
  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ['dashboard-stats'],
    queryFn: async () => (await api.get('/dashboard/stats')).data,
  });

  const items = stats?.items;
  const matches = stats?.matches;
  const readyToApprove = (items?.approved || 0);
  const needReview = (items?.pending || 0);
  const total = (items?.total || 0);
  const readyPct = total > 0 ? Math.round((readyToApprove / total) * 100) : 0;

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight mb-1">Dashboard</h1>
      <p className="text-slate-500 mb-8">Overview for July 2026</p>

      <div className="grid grid-cols-4 gap-4 mb-8">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-sm text-slate-500 mb-2">Items extracted</div>
          <div className="text-3xl font-bold font-mono">{items?.total || 0}</div>
          <div className="text-xs text-emerald-600 mt-1">↑ 12% vs June</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-sm text-slate-500 mb-2">Pending review</div>
          <div className="text-3xl font-bold font-mono">{items?.pending || 0}</div>
          <div className="text-xs text-amber-600 mt-1">Needs your attention</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-sm text-slate-500 mb-2">Avg. confidence</div>
          <div className="text-3xl font-bold font-mono">{items?.avg_confidence || 0}%</div>
          <div className="text-xs text-slate-500 mt-1">Across all items</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-sm text-slate-500 mb-2">QuickBooks</div>
          <div className="text-lg font-bold text-emerald-600 mt-1">Connected ✓</div>
          <div className="text-xs text-slate-500 mt-1">Last synced 2h ago</div>
        </div>
      </div>

      {/* Smart Import Summary */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 mb-6">
        <h3 className="text-base font-semibold mb-4">Import Summary</h3>
        <div className="flex flex-wrap gap-3 mb-4">
          <span className="inline-flex items-center gap-1.5 text-sm"><CheckCircle size={14} className="text-emerald-500"/> {readyToApprove} Ready to Approve</span>
          <span className="inline-flex items-center gap-1.5 text-sm"><AlertTriangle size={14} className="text-amber-500"/> {needReview} Need Review</span>
          <span className="inline-flex items-center gap-1.5 text-sm"><FileText size={14} className="text-slate-400"/> {items?.rejected || 0} Rejected</span>
          <span className="inline-flex items-center gap-1.5 text-sm"><RefreshCw size={14} className="text-slate-400"/> {matches?.pending || 0} Reconcile Pending</span>
        </div>
        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${readyPct}%` }} />
        </div>
        <div className="text-sm text-slate-500 mt-2">{readyPct}% Ready to Post</div>
      </div>

      <div className="grid grid-cols-[1.4fr_1fr] gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <h3 className="text-base font-semibold mb-5">Monthly extraction volume</h3>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData}>
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip cursor={{ fill: '#f1f5f9' }} contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0' }} />
              <Bar dataKey="v" radius={[4, 4, 0, 0]}>
                {chartData.map((entry, index) => (
                  <Cell key={index} fill={entry.label === 'Jul' ? '#0ea5e9' : '#cbd5e1'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <h3 className="text-base font-semibold mb-4">Quick actions</h3>
          <div className="flex flex-col gap-2.5 mb-6">
            <button onClick={() => navigate('/upload')} className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-slate-800 text-white text-sm font-semibold hover:bg-slate-700 transition-colors text-left">
              <Upload size={16}/> Upload invoices or receipts →
            </button>
            <button onClick={() => navigate('/batch')} className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-200 text-sm font-semibold hover:bg-slate-50 transition-colors text-left">
              <CheckSquare size={16}/> Review {items?.pending || 0} pending items →
            </button>
          </div>
          <h4 className="text-sm font-semibold text-slate-500 mb-3">Recent activity</h4>
          <div className="flex flex-col gap-3">
            {stats?.recent_activity?.slice(0, 4).map((act, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span>{act.text}</span>
                <span className="text-slate-400 text-xs">{new Date(act.time).toLocaleDateString()}</span>
              </div>
            )) || (
              <>
                <div className="flex justify-between text-sm"><span>Uploaded 12 invoices</span><span className="text-slate-400 text-xs">2h ago</span></div>
                <div className="flex justify-between text-sm"><span>Approved 8 flagged items</span><span className="text-slate-400 text-xs">Yesterday</span></div>
                <div className="flex justify-between text-sm"><span>Bank statement reconciled</span><span className="text-slate-400 text-xs">3 days ago</span></div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Learned Patterns */}
      {stats?.learned_patterns && stats.learned_patterns.length > 0 && (
        <div className="mt-6 bg-white border border-slate-200 rounded-xl p-6">
          <h3 className="text-base font-semibold mb-4">Learned Patterns</h3>
          <div className="flex flex-wrap gap-2">
            {stats.learned_patterns.map((p, i) => (
              <div key={i} className="px-3 py-1.5 bg-sky-50 text-sky-700 rounded-lg text-sm font-medium border border-sky-100">
                {p.merchant} → {p.category} ({p.confidence}%)
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
