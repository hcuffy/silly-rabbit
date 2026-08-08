import { useState } from "react";
import { NavLink, Outlet } from "react-router";

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`app-shell${collapsed ? " app-shell--collapsed" : ""}`}>
      <nav className="app-shell__rail">
        <div className="app-shell__rail-header">
          {!collapsed && (
            <span className="app-shell__brand">
              <img
                src="/images/silly-rabbit-logo-detailed-1024.png"
                alt="Silly Rabbit logo"
                className="app-shell__brand-logo"
                width={28}
                height={28}
              />
              Silly Rabbit
            </span>
          )}
          <button
            type="button"
            className="app-shell__collapse-toggle"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>
        <NavLink to="/" end className="app-shell__link">
          {collapsed ? "N" : "New run"}
        </NavLink>
        <NavLink to="/runs" className="app-shell__link">
          {collapsed ? "R" : "Run history"}
        </NavLink>
        <NavLink to="/session-recordings" className="app-shell__link">
          {collapsed ? "S" : "Session recordings"}
        </NavLink>
        <NavLink to="/cycles" className="app-shell__link">
          {collapsed ? "C" : "Cycles"}
        </NavLink>
        <NavLink to="/settings" className="app-shell__link">
          {collapsed ? "T" : "Settings"}
        </NavLink>
      </nav>
      <main className="app-shell__content">
        <Outlet />
      </main>
    </div>
  );
}
