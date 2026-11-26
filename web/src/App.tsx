import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { AppProvider } from "./lib/app-context";
import { Background, TopNav, type ViewId } from "./components/Shell";
import { ToastProvider } from "./components/ui";
import { KeysView } from "./views/KeysView";
import { CommandsView } from "./views/CommandsView";
import { RecoveryView } from "./views/RecoveryView";
import { OverviewView } from "./views/OverviewView";
import { ExperimentProvider } from "./lib/experiment";

const VIEWS: ViewId[] = ["overview", "keys", "commands", "recovery"];

function viewFromHash(): ViewId {
  const v = window.location.hash.replace(/^#\/?/, "").split("?")[0] as ViewId;
  return VIEWS.includes(v) ? v : "overview";
}

export default function App() {
  const [view, setView] = useState<ViewId>(viewFromHash);

  useEffect(() => {
    const h = () => setView(viewFromHash());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);

  return (
    <ToastProvider>
      <AppProvider>
        <ExperimentProvider>
        <Background />
        <TopNav view={view} onView={setView} />
        <main className="mx-auto max-w-[1400px] px-4 pb-12 pt-5 sm:px-6">
          <AnimatePresence mode="wait">
            <motion.div key={view} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {view === "overview" && <OverviewView />}
              {view === "keys" && <KeysView />}
              {view === "commands" && <CommandsView />}
              {view === "recovery" && <RecoveryView />}
            </motion.div>
          </AnimatePresence>
        </main>
        </ExperimentProvider>
      </AppProvider>
    </ToastProvider>
  );
}
