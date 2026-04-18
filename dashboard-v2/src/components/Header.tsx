import { useStore } from "../store";

export function Header() {
  const connected = useStore((s) => s.connected);
  const mode = useStore((s) => s.mode);

  return (
    <header className="header">
      <div className="header-right" style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
        <button className="cmd-k-trigger">
          Ask vClaw
          <span className="cmd-palette-kbd">&#x2318;K</span>
        </button>

        <div className="conn-status">
          <span className={`conn-dot${connected ? " live" : ""}`} />
          {connected ? "Live" : "Reconnecting..."}
        </div>

        <span className={`mode-pill ${mode}`}>
          {mode.toUpperCase()}
        </span>
      </div>
    </header>
  );
}

export default Header;
