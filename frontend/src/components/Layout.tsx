import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function Layout() {
  return (
    <div className="flex h-screen bg-neutral-50 text-slate-900 overflow-hidden">
      <Sidebar />
      <div className="flex-1 overflow-y-auto p-10">
        <div className="max-w-6xl mx-auto">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
