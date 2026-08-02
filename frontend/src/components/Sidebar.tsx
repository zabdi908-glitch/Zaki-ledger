import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';
import {
  Home, Upload, Edit3, CheckSquare, Landmark, Search, ListChecks,
  FolderOpen, BarChart3, Settings
} from 'lucide-react';

const navGroups = [
  { items: [{ id: '', label: 'Dashboard', icon: Home }] },
  { label: 'Extraction', items: [
    { id: 'upload', label: 'Upload & Extract', icon: Upload },
    { id: 'review', label: 'Review & Edit', icon: Edit3 },
    { id: 'batch', label: 'Batch Review', icon: CheckSquare },
  ]},
  { label: 'Reconciliation', items: [
    { id: 'reconcile', label: 'Bank Reconcile', icon: Landmark },
  ]},
  { label: 'Organization', items: [
    { id: 'auto-categorize', label: 'Auto-Categorize', icon: FolderOpen, soon: true },
  ]},
  { label: 'Insights', items: [
    { id: 'reports', label: 'Reports', icon: BarChart3, soon: true },
  ]},
  { label: 'Account', items: [
    { id: 'settings', label: 'Settings', icon: Settings },
  ]},
];

export default function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useStore();
  const location = useLocation();
  const navigate = useNavigate();
  const current = location.pathname.replace('/', '') || '';

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleSidebar]);

  return (
    <div className={`flex-shrink-0 bg-slate-800 text-white flex flex-col py-6 px-4 overflow-y-auto transition-all duration-100 ${sidebarCollapsed ? 'w-[72px]' : 'w-60'}`}>
      <div className="flex items-center justify-between px-1 pb-8">
        {!sidebarCollapsed && (
          <div className="text-xl font-bold tracking-tight">Zaki<span className="text-sky-400">.</span></div>
        )}
        <button onClick={toggleSidebar} title="Toggle sidebar (Cmd/Ctrl+B)" className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-700 transition-colors">
          <ListChecks size={16} />
        </button>
      </div>

      <div className="flex flex-col gap-3.5">
        {navGroups.map((grp, gi) => (
          <div key={gi}>
            {grp.label && !sidebarCollapsed && (
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 px-3 pb-1">{grp.label}</div>
            )}
            <div className="flex flex-col gap-0.5">
              {grp.items.map((item) => {
                const isActive = current === item.id;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    onClick={() => !item.soon && navigate('/' + item.id)}
                    title={item.label}
                    className={`flex items-center justify-between gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      isActive ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                    } ${item.soon ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    {sidebarCollapsed ? (
                      <div className="w-7 h-7 flex items-center justify-center mx-auto">
                        <Icon size={16} />
                      </div>
                    ) : (
                      <div className="flex items-center gap-2.5">
                        <Icon size={16} />
                        <span>{item.label}</span>
                      </div>
                    )}
                    {item.soon && !sidebarCollapsed && (
                      <span className="text-[10px] font-bold text-slate-500 border border-slate-600 rounded px-1.5 py-0.5">SOON</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {!sidebarCollapsed && (
        <div className="mt-auto pt-3 border-t border-slate-700 text-xs text-slate-400">
          <div className="font-semibold text-white mb-0.5">Francisco M.</div>
          <div>Growing Practice · Tier 2</div>
        </div>
      )}
    </div>
  );
}
