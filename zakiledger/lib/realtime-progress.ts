import { getSupabase } from "./supabase";

export type ProgressStage =
  | "uploading"
  | "parsing"
  | "extracting"
  | "matching"
  | "generating_memos"
  | "complete"
  | "error";

const STAGE_ORDER: ProgressStage[] = [
  "uploading",
  "parsing",
  "extracting",
  "matching",
  "generating_memos",
  "complete",
];

/**
 * Maps a progress stage to an approximate completion percentage.
 */
export function stageToProgress(stage: ProgressStage): number {
  if (stage === "error") return 0;
  const index = STAGE_ORDER.indexOf(stage);
  if (index === -1) return 0;
  return Math.round(((index + 1) / STAGE_ORDER.length) * 100);
}

/**
 * Publishes a progress update to a Supabase Realtime broadcast channel.
 *
 * The channel is scoped per-user and per-statement so clients can subscribe
 * to exactly the stream they care about.
 *
 * When Supabase is not configured this silently no-ops so the skeleton still
 * runs end-to-end without a database.
 */
export async function publishProgress(
  userId: string,
  statementId: string,
  stage: ProgressStage,
  details?: Record<string, unknown>,
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) {
    return;
  }

  const channelName = `progress:${userId}:${statementId}`;
  const progress = stageToProgress(stage);
  const payload = {
    stage,
    details: details ?? null,
    progress,
    timestamp: Date.now(),
  };

  const channel = supabase.channel(channelName);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      channel.unsubscribe();
      reject(new Error("Realtime publish timed out"));
    }, 10_000);

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timeout);
        channel
          .send({ type: "broadcast", event: "progress", payload })
          .then(() => {
            channel.unsubscribe();
            resolve();
          })
          .catch((err: unknown) => {
            channel.unsubscribe();
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      } else if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        clearTimeout(timeout);
        channel.unsubscribe();
        reject(
          new Error(`Realtime subscription failed with status: ${status}`),
        );
      }
    });
  });
}