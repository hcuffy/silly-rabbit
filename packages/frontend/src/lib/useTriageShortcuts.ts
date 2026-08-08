import type { Finding } from "@silly-rabbit/shared";
import { useEffect } from "react";
import type { FeedbackVerdict } from "./apiClient.js";

export interface UseTriageShortcutsOptions {
  findings: Finding[];
  activeIndex: number;
  onNavigate: (nextIndex: number) => void;
  onFeedback: (findingId: string, verdict: FeedbackVerdict) => void;
}

function isTextInputFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  return activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA" || activeElement.isContentEditable;
}

export function useTriageShortcuts({ findings, activeIndex, onNavigate, onFeedback }: UseTriageShortcutsOptions): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (isTextInputFocused()) return;
      const activeFinding = findings[activeIndex];

      switch (event.key) {
        case "1":
          if (activeFinding?.featureId) onFeedback(activeFinding.id, "confirmed_issue");
          break;
        case "2":
          if (activeFinding?.featureId) onFeedback(activeFinding.id, "intended_behavior");
          break;
        case "3":
          if (activeFinding) onFeedback(activeFinding.id, "dismiss");
          break;
        case "n":
        case "N":
          if (activeIndex < findings.length - 1) onNavigate(activeIndex + 1);
          break;
        case "p":
        case "P":
          if (activeIndex > 0) onNavigate(activeIndex - 1);
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [findings, activeIndex, onNavigate, onFeedback]);
}
