import { useEffect, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ProgressStage } from "@/lib/realtime-progress";

export interface ReconciliationProgress {
  stage: ProgressStage | null;
  details: Record<string, unknown> | null;
  progress: number;
}

function getBrowserSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Subscribes to Supabase Realtime broadcast updates for a specific user's
 * statement reconciliation progress.
 *
 * Returns the latest `{ stage, details, progress }` received from the server,
 * or a default empty state when `userId`/`statementId` are missing or when
 * Supabase is not configured.
 */
export function useReconciliationProgress(
  userId: string | null | undefined,
  statementId: string | null | undefined,
): ReconciliationProgress {
  const [state, setState] = useState<ReconciliationProgress>({
    stage: null,
    details: null,
    progress: 0,
  });

  useEffect(() => {
    if (!userId || !statementId) return;

    const supabase = getBrowserSupabase();
    if (!supabase) return;

    const channelName = `progress:${userId}:${statementId}`;

    const channel = supabase
      .channel(channelName)
      .on(
        "broadcast",
        { event: "progress" },
        (message: {
          payload: {
            stage: ProgressStage;
            details: Record<string, unknown> | null;
            progress: number;
          };
        }) => {
          const { stage, details, progress } = message.payload;
          setState({ stage, details, progress });
        },
      )
      .subscribe();

    return () => {
      void channel.unsubscribe();
    };
  }, [userId, statementId]);

  return state;
}