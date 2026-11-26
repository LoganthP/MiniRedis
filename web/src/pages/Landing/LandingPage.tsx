import { MotionConfig } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Background } from "../../components/Shell";
import { api, type Overview } from "../../lib/api";
import { ArchitectureSection } from "./components/ArchitectureSection";
import { CtaSection, LandingFooter } from "./components/CtaAndFooter";
import { FeaturesSection } from "./components/FeaturesSection";
import { HeroSection } from "./components/HeroSection";
import { HowItWorksSection } from "./components/HowItWorksSection";
import { LandingNavbar } from "./components/LandingNavbar";
import { PlaygroundSection } from "./components/PlaygroundSection";
import "./landing.css";

export function LandingPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);

  useEffect(() => {
    document.title = "MiniRedis — Crash-Safe Key-Value Engine";
    let mounted = true;
    api
      .overview()
      .then((o) => {
        if (mounted) setOverview(o);
      })
      .catch(() => {
        /* API offline or unreachable */
      });
    return () => {
      mounted = false;
    };
  }, []);

  const scrollToSection = useCallback((id: string) => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
    if (id === "top") {
      window.scrollTo({ top: 0, behavior });
      return;
    }
    const el = document.getElementById(id);
    if (!el) return;
    const navOffset = 64;
    const y = el.getBoundingClientRect().top + window.scrollY - navOffset;
    window.scrollTo({ top: Math.max(0, y), behavior });
  }, []);

  const version = String(overview?.server?.miniredis_version ?? "1.0.0");

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen overflow-x-clip text-fg">
        <Background />
        <LandingNavbar
          version={version}
          onNavigate={onNavigate}
          onScrollTo={scrollToSection}
        />
        <main>
          <HeroSection overview={overview} onNavigate={onNavigate} />
          <FeaturesSection onNavigate={onNavigate} />
          <HowItWorksSection />
          <PlaygroundSection onNavigate={onNavigate} />
          <ArchitectureSection />
          <CtaSection onNavigate={onNavigate} />
        </main>
        <LandingFooter onScrollTop={() => scrollToSection("top")} />
      </div>
    </MotionConfig>
  );
}
