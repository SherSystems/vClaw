import { useState, useEffect, useRef, useCallback } from "react";
import { sendAgentCommand } from "../api/client";

const SUGGESTIONS = [
  "List running VMs",
  "Show cluster health",
  "Restart VM 104",
  "What's using the most CPU?",
  "Prepare node for maintenance",
];

interface AgentResponse {
  success: boolean;
  text: string;
}

export default function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<AgentResponse | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  const openPalette = useCallback(() => {
    setIsOpen(true);
    setIsClosing(false);
    setQuery("");
    setResponse(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const closePalette = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
    }, 150);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (isOpen) {
          closePalette();
        } else {
          openPalette();
        }
      }
      if (e.key === "Escape" && isOpen) {
        e.preventDefault();
        closePalette();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, openPalette, closePalette]);

  const handleSend = useCallback(
    async (command?: string) => {
      const text = command ?? query;
      if (!text.trim()) return;

      setLoading(true);
      setResponse(null);

      try {
        const result = await sendAgentCommand(text);
        const plan = result as Record<string, unknown>;
        const stepsCompleted = plan.stepsCompleted ?? plan.steps_completed ?? 0;
        const stepsFailed = plan.stepsFailed ?? plan.steps_failed ?? 0;
        const duration = plan.duration ?? plan.elapsed ?? "n/a";
        const summary = plan.summary ?? plan.message ?? "Command executed.";

        setResponse({
          success: true,
          text: [
            `${summary}`,
            `Steps completed: ${stepsCompleted}`,
            stepsFailed ? `Steps failed: ${stepsFailed}` : null,
            `Duration: ${duration}`,
          ]
            .filter(Boolean)
            .join("\n"),
        });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "An unexpected error occurred.";
        setResponse({ success: false, text: message });
      } finally {
        setLoading(false);
      }
    },
    [query]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  };

  if (!isOpen) return null;

  const overlayClass = [
    "cmd-palette-overlay",
    !isClosing ? "open" : "",
    isClosing ? "closing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={overlayClass}
      onClick={closePalette}
    >
      <div
        className="cmd-palette"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input row */}
        <div className="cmd-palette-input-row">
          <span className="cmd-palette-icon">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <input
            ref={inputRef}
            className="cmd-palette-input"
            placeholder="Ask InfraWrap anything..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <kbd className="cmd-palette-kbd">ESC</kbd>
        </div>

        {/* Suggestion chips */}
        {!loading && !response && (
          <div className="cmd-palette-chips">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                className="cmd-palette-chip"
                onClick={() => {
                  setQuery(suggestion);
                  handleSend(suggestion);
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {/* Loading indicator */}
        <div className={`cmd-palette-loading${loading ? " visible" : ""}`}>
          <span className="cmd-palette-spinner" />
          InfraWrap is thinking...
        </div>

        {/* Response */}
        <div className={`cmd-palette-response${response ? " visible" : ""}`}>
          {response && (
            <>
              <div className="cmd-palette-response-label">Result</div>
              <div
                className={`cmd-palette-response-body ${
                  response.success ? "success" : "error"
                }`}
              >
                {response.text}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="cmd-palette-footer">
          <span className="cmd-palette-footer-keys">
            <kbd>↵</kbd> Run &nbsp; <kbd>ESC</kbd> Close
          </span>
          <span>InfraWrap Agent</span>
        </div>
      </div>
    </div>
  );
}
