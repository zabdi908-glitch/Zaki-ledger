import { getSessionUser } from "@/lib/auth";
import SettingsClient from "./SettingsClient";

export default async function SettingsPage() {
  const user = await getSessionUser();
  return <SettingsClient email={user?.email ?? ""} />;
}
