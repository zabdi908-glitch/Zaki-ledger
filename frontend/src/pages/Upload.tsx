import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useStore } from '../store/useStore';
import { useNavigate } from 'react-router-dom';
import { UploadCloud, FileText, FileSpreadsheet, FileCode } from 'lucide-react';

export default function Upload() {
  const [isDragging, setIsDragging] = useState(false);
  const [stage, setStage] = useState<'idle' | 'processing' | 'done'>('idle');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<any>(null);
  const showToast = useStore((s) => s.showToast);
  const navigate = useNavigate();

  const uploadMutation = useMutation({
    mutationFn: async (files: FileList) => {
      const formData = new FormData();
      Array.from(files).forEach((f) => formData.append('files', f));
      const res = await api.post('/documents/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => {
          if (e.total) setProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
      return res.data;
    },
    onMutate: () => { setStage('processing'); setProgress(0); },
    onSuccess: (data) => { setStage('done'); setResult(data); showToast(`${data.extracted} items extracted`); },
    onError: () => { setStage('idle'); showToast('Upload failed'); }
  });

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length) uploadMutation.mutate(e.dataTransfer.files);
  }, [uploadMutation]);

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) uploadMutation.mutate(e.target.files);
  };

  const highCount = result?.items?.filter((i: any) => i.overall_confidence >= 95).length || 0;
  const mediumCount = result?.items?.filter((i: any) => i.overall_confidence >= 70 && i.overall_confidence < 95).length || 0;
  const lowCount = result?.items?.filter((i: any) => i.overall_confidence < 70).length || 0;

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight mb-1">Upload & Extract</h1>
      <p className="text-slate-500 mb-8">Drop invoices, receipts, or bank statements to extract data automatically</p>

      {stage === 'idle' && (
        <>
          <div
            onClick={() => document.getElementById('fileInput')?.click()}
            onDrop={onDrop}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            className={`border-2 border-dashed rounded-2xl p-16 text-center cursor-pointer transition-colors ${isDragging ? 'border-sky-500 bg-sky-50' : 'border-slate-300 bg-white hover:border-slate-400'}`}
          >
            <UploadCloud size={40} className="mx-auto mb-4 text-slate-400" />
            <div className="text-lg font-semibold mb-1.5">Drag & drop files here</div>
            <div className="text-sm text-slate-500 mb-5">or click to browse — PDF, CSV, OFX up to 25MB each</div>
            <button className="px-5 py-2.5 rounded-lg bg-slate-800 text-white text-sm font-semibold hover:bg-slate-700">Choose files</button>
            <input id="fileInput" type="file" multiple accept=".pdf,.csv,.ofx,.png,.jpg,.jpeg" className="hidden" onChange={onFileSelect} />
          </div>
          <div className="flex gap-3 mt-5">
            <div className="flex items-center gap-2 text-sm text-slate-500"><div className="w-7 h-7 rounded-md bg-red-100 text-red-700 flex items-center justify-center text-[10px] font-bold font-mono">PDF</div>Invoices & receipts</div>
            <div className="flex items-center gap-2 text-sm text-slate-500"><div className="w-7 h-7 rounded-md bg-emerald-100 text-emerald-700 flex items-center justify-center text-[10px] font-bold font-mono">CSV</div>Bank statements</div>
            <div className="flex items-center gap-2 text-sm text-slate-500"><div className="w-7 h-7 rounded-md bg-amber-100 text-amber-700 flex items-center justify-center text-[10px] font-bold font-mono">OFX</div>Bank exports</div>
          </div>
        </>
      )}

      {stage === 'processing' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
          <div className="text-base font-semibold mb-5">Extracting data from files…</div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden max-w-md mx-auto">
            <div className="h-full bg-sky-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
          <div className="text-sm text-slate-500 mt-3 font-mono">{progress}% complete</div>
        </div>
      )}

      {stage === 'done' && result && (
        <>
          <div className="bg-white border border-slate-200 rounded-2xl p-8 mb-5">
            <div className="text-lg font-semibold mb-1">{result.extracted} items extracted</div>
            <div className="text-sm text-slate-500 mb-6">Review flagged items before posting to QuickBooks</div>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-emerald-50 rounded-xl p-4">
                <div className="text-2xl font-bold text-emerald-700">{highCount}</div>
                <div className="text-sm text-emerald-800">Auto-approved (95%+)</div>
              </div>
              <div className="bg-amber-50 rounded-xl p-4">
                <div className="text-2xl font-bold text-amber-700">{mediumCount}</div>
                <div className="text-sm text-amber-800">Needs review (70–95%)</div>
              </div>
              <div className="bg-red-50 rounded-xl p-4">
                <div className="text-2xl font-bold text-red-700">{lowCount}</div>
                <div className="text-sm text-red-800">Flagged (below 70%)</div>
              </div>
            </div>
          </div>
          <div className="flex gap-3">
            <button onClick={() => navigate('/batch')} className="px-5 py-3 rounded-lg bg-slate-800 text-white text-sm font-semibold hover:bg-slate-700">
              Review flagged items ({mediumCount + lowCount})
            </button>
            <button onClick={() => { setStage('idle'); setResult(null); }} className="px-5 py-3 rounded-lg border border-slate-200 bg-white text-sm font-semibold hover:bg-slate-50">
              Upload more
            </button>
          </div>
        </>
      )}
    </div>
  );
}
