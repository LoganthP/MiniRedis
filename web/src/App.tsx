import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { AppProvider } from "./lib/app-context";
import { Background, TopNav, type ViewId } from "./components/Shell";
import { ToastProvider } from "./components/ui";
import { KeysView } from "./views/KeysView";
import { CommandsView } from "./views/CommandsView";
import { RecoveryView } from "./views/RecoveryView";
import { OverviewView } from "./views/OverviewView";
import { ExperimentProvider } from "./lib/experiment";
import { LandingPage } from "./pages/Landing/LandingPage";

const VIEWS: ViewId[] = ["overview", "keys", "commands", "recovery"];

function parseLocation(): { isApp: boolean; view: ViewId } {
  const path = window.location.pathname;
  const hashView = window.location.hash.replace(/^#\/?/, "").split("?")[0] as ViewId;
  const isHashView = VIEWS.includes(hashView);
  if (path.startsWith("/app")) {
    return { isApp: true, view: isHashView ? hashView : "overview" };
  }
  if (isHashView) {
    return { isApp: true, view: hashView };
  }
  return { isApp: false, view: "overview" };
}

export default function App() {
  const [loc, setLoc] = useState(parseLocation);

  useEffect(() => {
    // Normalize legacy root-hash links (e.g. /#/keys) to /app#/keys.
    const path = window.location.pathname;
    const hashView = window.location.hash.replace(/^#\/?/, "").split("?")[0] as ViewId;
    if (!path.startsWith("/app") && VIEWS.includes(hashView)) {
      window.history.replaceState(null, "", `/app${window.location.hash}`);
      setLoc(parseLocation());
    }
    const sync = () => setLoc(parseLocation());
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  useEffect(() => {
    if (loc.isApp) document.title = "MiniRedis · Dashboard";
  }, [loc.isApp]);

  const navigate = useCallback((target: string) => {
    window.history.pushState(null, "", target);
    setLoc(parseLocation());
    window.scrollTo(0, 0);
  }, []);

  const setView = useCallback((v: ViewId) => {
    const next = `/app#/${v}`;
    if (window.location.pathname + window.location.hash !== next) {
      window.history.pushState(null, "", next);
    }
    setLoc({ isApp: true, view: v });
  }, []);

  if (!loc.isApp) {
    return <LandingPage onNavigate={navigate} />;
  }

  return (
    <ToastProvider>
      <AppProvider>
        <ExperimentProvider>
          <Background />
          <TopNav view={loc.view} onView={setView} onHome={() => navigate("/")} />
          <main className="mx-auto max-w-[1400px] px-4 pb-12 pt-5 sm:px-6">
            <AnimatePresence mode="wait">
              <motion.div
                key={loc.view}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                {loc.view === "overview" && <OverviewView />}
                {loc.view === "keys" && <KeysView />}
                {loc.view === "commands" && <CommandsView />}
                {loc.view === "recovery" && <RecoveryView />}
              </motion.div>
            </AnimatePresence>
          </main>
        </ExperimentProvider>
      </AppProvider>
    </ToastProvider>
  );
}
