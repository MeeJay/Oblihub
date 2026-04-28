import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LogOut, Bell } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';

// App switcher — fixed order across the suite. Per obli-design-system.md §1 + §4.1.
type AppType = 'obliview' | 'obliguard' | 'oblimap' | 'obliance' | 'oblihub';

interface AppEntry {
  type: AppType;
  label: string;
  /** Brand dot colour. Reused as the active pill's text + glow. */
  color: string;
}

const APP_ORDER: AppEntry[] = [
  { type: 'obliview',  label: 'Obliview',  color: '#2bc4bd' },
  { type: 'obliguard', label: 'Obliguard', color: '#f5a623' },
  { type: 'oblimap',   label: 'Oblimap',   color: '#1edd8a' },
  { type: 'obliance',  label: 'Obliance',  color: '#e03a3a' },
  { type: 'oblihub',   label: 'Oblihub',   color: '#2d4ec9' },
];

const CURRENT_APP: AppType = 'oblihub';

interface ConnectedApp { appType: string; name: string; baseUrl: string }

export function Header() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>([]);

  useEffect(() => {
    fetch('/api/auth/connected-apps', { credentials: 'include' })
      .then(r => r.json())
      .then((d: { success: boolean; data?: ConnectedApp[] }) => {
        if (d.success && d.data) setConnectedApps(d.data);
      })
      .catch(() => {});
  }, []);

  const reachable = new Set<string>([CURRENT_APP]);
  for (const a of connectedApps) reachable.add(a.appType);

  const goApp = (app: AppEntry) => {
    if (app.type === CURRENT_APP) return;
    const target = connectedApps.find(c => c.appType === app.type);
    if (target) window.location.href = `${target.baseUrl}/auth/sso-redirect`;
  };

  const displayName = user?.displayName || user?.username || 'User';
  const cleanName = displayName.startsWith('og_') ? displayName.slice(3) : displayName;

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <header
      className="flex shrink-0 items-center gap-3 bg-bg-secondary px-4"
      style={{ height: 52 }}
    >
      {/* Logo block */}
      <Link to="/" className="flex items-center gap-2 shrink-0">
        <img src="/logo.svg" alt="Oblihub" className="h-7 w-7 rounded-md" />
        <span className="font-display text-[19px] font-semibold tracking-wide text-text-primary">
          Oblihub
        </span>
      </Link>

      {/* App switcher pills (§4.1) — Oblihub pill glowing in deep blue */}
      <nav className="flex items-center gap-1 ml-2">
        {APP_ORDER.map(app => {
          const isCurrent = app.type === CURRENT_APP;
          const isReachable = reachable.has(app.type);
          const dimmed = !isReachable && !isCurrent;
          return (
            <button
              key={app.type}
              type="button"
              onClick={() => goApp(app)}
              disabled={dimmed}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors',
                isCurrent
                  ? 'text-[color:var(--app-current)]'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
                dimmed && 'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-text-muted',
              )}
              style={isCurrent
                ? ({ '--app-current': app.color, backgroundColor: hexA(app.color, 0.12) } as React.CSSProperties)
                : undefined}
              title={!isReachable && !isCurrent ? `${app.label} — not connected` : app.label}
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{
                  background: app.color,
                  boxShadow: isCurrent ? `0 0 8px ${app.color}` : undefined,
                }}
              />
              {app.label}
            </button>
          );
        })}
      </nav>

      {/* Right cluster */}
      <div className="ml-auto flex items-center gap-3">
        <button
          type="button"
          title="Notifications"
          className="relative flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
        >
          <Bell size={15} />
        </button>

        {user && (
          <>
            <div className="flex items-center gap-2 pl-1.5 pr-3 py-1 rounded-full bg-bg-hover">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-white"
                style={{ background: 'linear-gradient(135deg, rgba(45,78,201,0.8), rgba(90,120,232,0.5))' }}
              >
                {(cleanName[0] ?? '?').toUpperCase()}
              </div>
              <span className="text-[13px] font-medium text-text-primary">{cleanName}</span>
              {user.role && (
                <span className="text-[10px] font-mono uppercase tracking-wider text-accent pl-2 border-l border-border-light">
                  {user.role}
                </span>
              )}
            </div>
            <button
              onClick={handleLogout}
              title="Sign out"
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              <LogOut size={15} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function hexA(hex: string, alpha: number): string {
  const m = hex.replace('#', '');
  const n = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
