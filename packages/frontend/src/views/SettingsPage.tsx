import { NavMapPanel } from "./NavMapPanel.js";
import { TargetProfileList } from "./TargetProfileList.js";

export function SettingsPage() {
  return (
    <>
      <h2>Settings</h2>
      <TargetProfileList />
      <NavMapPanel />
    </>
  );
}
