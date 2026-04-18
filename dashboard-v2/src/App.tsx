import { useSSE } from "./hooks/useSSE";
import { useClusterPolling, useIncidentPolling } from "./hooks/usePolling";
import { useStore } from "./store";
import Sidebar from "./components/layout/Sidebar";
import Overview from "./components/pages/Overview";
import Infrastructure from "./components/pages/Infrastructure";
import AppTopology from "./components/AppTopology";
import Migrations from "./components/Migrations";
import Operations from "./components/pages/Operations";
import Chaos from "./components/Chaos";
import CommandPalette from "./components/CommandPalette";
import ToastContainer from "./components/Toast";

export function App() {
  useSSE();
  useClusterPolling();
  useIncidentPolling();

  const activeTab = useStore((s) => s.activeTab);

  return (
    <>
      <div className="app-layout">
        <Sidebar />
        <div className="app-content">
          <main className="page-content">
            {activeTab === "overview" && <Overview />}
            {activeTab === "infrastructure" && <Infrastructure />}
            {activeTab === "applications" && <AppTopology />}
            {activeTab === "migrations" && <Migrations />}
            {activeTab === "operations" && <Operations />}
            {activeTab === "chaos" && <Chaos />}
          </main>
        </div>
      </div>

      <CommandPalette />
      <ToastContainer />
    </>
  );
}
