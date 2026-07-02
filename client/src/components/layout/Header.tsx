import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LogOut, Bell } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';
import { Logo } from '@/components/common/Logo';

// App switcher — fixed order across the suite. Per obli-design-system.md §1 + §4.1.
type AppType = 'obliview' | 'obliguard' | 'oblimap' | 'obliance' | 'obliplan' | 'oblihub';

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
  { type: 'obliplan',  label: 'Obliplan',  color: '#7c6cff' },
  { type: 'oblihub',   label: 'Oblihub',   color: '#1678cd' },
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
      {/* Logo — theme-aware wordmark, no text label (Obliance-style: the wordmark is the label). */}
      <Link to="/" className="flex items-center shrink-0">
        <Logo className="h-8 w-auto max-w-[160px] object-contain" />
      </Link>

      {/* App switcher — container-wrapped pill group (Daylight spec §4). Uses bg-hover for
          the frame so it visually matches the user pill on the right; inner pills are
          rounded-md, active pill is a raised white-card look (bg-secondary + subtle shadow). */}
      <nav className="ml-2 flex items-center gap-1 rounded-lg bg-bg-hover p-1">
        {APP_ORDER.filter(app => reachable.has(app.type)).map(app => {
          const isCurrent = app.type === CURRENT_APP;
          return (
            <button
              key={app.type}
              type="button"
              onClick={() => goApp(app)}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-1.5 text-[12.5px] transition-colors',
                isCurrent
                  ? 'bg-bg-secondary font-semibold text-text-primary shadow-[0_1px_3px_rgb(46_52_64_/_0.1)]'
                  : 'font-medium text-text-secondary hover:bg-bg-active hover:text-text-primary',
              )}
              title={app.label}
            >
              <span className="h-2 w-2 rounded-full shrink-0" style={{ background: app.color }} />
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
            {/* User pill — same bg-hover surface as the switcher container so both frames
                stay coherent across every theme. Avatar disc keeps rounded-full inside. */}
            <Link
              to="/profile"
              className="flex items-center gap-2 rounded-lg bg-bg-hover py-1 pl-1.5 pr-3 transition-colors hover:bg-bg-active"
              title="Profile"
            >
              {user.avatar ? (
                <img
                  src={user.avatar}
                  alt={cleanName}
                  className="w-7 h-7 rounded-full object-cover"
                />
              ) : (
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-white"
                  style={{ background: 'linear-gradient(135deg, rgb(22 120 205 / 0.8), rgb(72 143 236 / 0.5))' }}
                >
                  {(cleanName[0] ?? '?').toUpperCase()}
                </div>
              )}
              <span className="text-[13px] font-medium text-text-primary">{cleanName}</span>
              {user.role && (
                <span className="text-[10px] font-mono uppercase tracking-wider text-accent pl-2 border-l border-border-light">
                  {user.role}
                </span>
              )}
            </Link>
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
