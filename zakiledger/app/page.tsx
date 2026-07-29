import { redirect } from "next/navigation";

/**
 * The whole authenticated app now lives under app/(app), with Dashboard as
 * its home screen — see design_handoff_zaki_ledger/. The rich single-
 * document review flow that used to live at "/" (per-field editing,
 * duplicate detection, type confirmation, supplier calibration) is retired
 * in favor of the simpler Upload/Review/Batch screens, per the rebuild plan.
 */
export default function Home() {
  redirect("/dashboard");
}
