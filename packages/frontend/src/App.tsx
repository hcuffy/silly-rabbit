import { Route, Routes } from "react-router";
import { AppShell } from "./AppShell.js";
import { useSessionQuery } from "./lib/queries.js";
import { CyclesPage } from "./views/CyclesPage.js";
import { HomePage } from "./views/HomePage.js";
import { LoadingScreen } from "./views/LoadingScreen.js";
import { LoginScreen } from "./views/LoginScreen.js";
import { RunDetailPage } from "./views/RunDetailPage.js";
import { RunHistoryPage } from "./views/RunHistoryPage.js";
import { SessionRecordingsPage } from "./views/SessionRecordingsPage.js";
import { SessionReplayDetailPage } from "./views/SessionReplayDetailPage.js";
import { SessionReplayRunHistoryPage } from "./views/SessionReplayRunHistoryPage.js";
import { SettingsPage } from "./views/SettingsPage.js";

export function App() {
  const sessionQuery = useSessionQuery();

  if (sessionQuery.isLoading) return <LoadingScreen />;
  if (sessionQuery.isError) return <LoginScreen />;

  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="runs" element={<RunHistoryPage />} />
        <Route path="runs/:id" element={<RunDetailPage />} />
        <Route path="session-recordings" element={<SessionRecordingsPage />} />
        <Route path="session-replay/runs" element={<SessionReplayRunHistoryPage />} />
        <Route path="session-replay/:id" element={<SessionReplayDetailPage />} />
        <Route path="cycles" element={<CyclesPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
