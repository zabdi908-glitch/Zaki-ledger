import { useStore } from '../store/useStore';

export default function Toast() {
  const { toast, toastVisible } = useStore();
  if (!toast) return null;
  return (
    <div className={`fixed bottom-7 right-7 bg-slate-800 text-white px-5 py-3.5 rounded-xl font-semibold text-sm shadow-xl transition-all duration-300 ${toastVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>
      {toast}
    </div>
  );
}
