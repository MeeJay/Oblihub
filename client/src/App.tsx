import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { LayoutDashboard, Settings, User, Users, LogOut, ArrowLeftRight, Layers, HardDrive, Network, Database, Globe, Shield, ArrowRight, Radio, Ban, ShieldCheck, FileText, Activity, Package } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { settingsApi } from '@/api/settings.api';
import { systemApi } from '@/api/stacks.api';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { StackDetailPage } from '@/pages/StackDetailPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ManagedStacksPage } from '@/pages/ManagedStacksPage';
import { StackEditorPage } from '@/pages/StackEditorPage';
import { ImagesPage } from '@/pages/ImagesPage';
import { NetworksPage } from '@/pages/NetworksPage';
import { VolumesPage } from '@/pages/VolumesPage';
import { ProxyHostsPage } from '@/pages/ProxyHostsPage';
import { CertificatesPage } from '@/pages/CertificatesPage';
import { RedirectionsPage } from '@/pages/RedirectionsPage';
import { StreamsPage } from '@/pages/StreamsPage';
import { DeadHostsPage } from '@/pages/DeadHostsPage';
import { AccessListsPage } from '@/pages/AccessListsPage';
import { CustomPagesPage } from '@/pages/CustomPagesPage';
import { UptimeMonitorsPage } from '@/pages/UptimeMonitorsPage';
import { AppStorePage } from '@/pages/AppStorePage';
import { UsersPage } from '@/pages/UsersPage';
import { RolesPage } from '@/pages/RolesPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isInitialized } = useAuthStore();
  if (!isInitialized) return <div className="flex h-screen items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function SidebarLink({ href, icon: Icon, label, active }: { href: string; icon: typeof LayoutDashboard; label: string; active: boolean }) {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate(href)}
      className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
        active
          ? 'bg-accent/10 text-accent font-medium'
          : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
      }`}>
      <Icon size={16} />
      {label}
    </button>
  );
}

interface ConnectedApp {
  appType: string;
  name: string;
  baseUrl: string;
}

function AppLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const isAdmin = user?.role === 'admin';

  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>([]);
  const [obligateUrl, setObligateUrl] = useState<string | null>(null);
  const [allowStack, setAllowStack] = useState(false);
  const [allowNginx, setAllowNginx] = useState(false);

  useEffect(() => {
    fetch('/api/auth/connected-apps', { credentials: 'include' })
      .then(r => r.json())
      .then((d: { success: boolean; data?: ConnectedApp[] }) => {
        if (d.success && d.data) setConnectedApps(d.data.filter(a => a.appType !== 'oblihub'));
      })
      .catch(() => {});

    settingsApi.getAll()
      .then(cfg => setObligateUrl(cfg.obligate_url ?? null))
      .catch(() => {});

    systemApi.getFeatures()
      .then(f => { setAllowStack(f.allowStack); setAllowNginx(f.allowNginx); })
      .catch(() => {
        systemApi.getInfo()
          .then(info => { setAllowStack(info.allowStack); setAllowNginx(info.allowNginx); })
          .catch(() => {});
      });
  }, []);

  const displayName = user?.displayName || user?.username || 'User';
  const cleanName = displayName.startsWith('og_') ? displayName.slice(3) : displayName;

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen flex-col">
      {/* Top header bar */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-bg-secondary px-4">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="Oblihub" className="h-10 w-10 rounded-lg" />

          {/* Cross-app switch buttons */}
          {obligateUrl && connectedApps.length > 0 && connectedApps.map(app => (
            <button
              key={app.appType}
              onClick={() => { window.location.href = `${app.baseUrl}/auth/sso-redirect`; }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold border transition-all
                text-accent bg-accent/10 border-accent/30
                hover:text-white hover:bg-accent/20 hover:border-accent/60"
            >
              <ArrowLeftRight size={12} />
              {app.name}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-text-secondary">{cleanName}</span>
          {user?.role === 'admin' && (
            <span className="text-xs bg-accent/20 text-accent px-2 py-0.5 rounded">admin</span>
          )}
          <button onClick={handleLogout}
            className="rounded-md p-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
            title="Logout">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {/* Main content with sidebar */}
      <div className="flex flex-1 overflow-hidden">
        <aside className="w-52 shrink-0 border-r border-border bg-bg-secondary flex flex-col">
          <nav className="flex-1 p-3 space-y-1">
            <SidebarLink href="/" icon={LayoutDashboard} label="Dashboard" active={location.pathname === '/' || location.pathname.startsWith('/stack/')} />
            <SidebarLink href="/app-store" icon={Package} label="App Store" active={location.pathname === '/app-store'} />

            {allowStack && (
              <>
                <SidebarLink href="/managed-stacks" icon={Layers} label="Stacks" active={location.pathname.startsWith('/managed-stacks') || location.pathname.startsWith('/stack-editor')} />

                <div className="pt-3 pb-1">
                  <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider px-3">Docker</div>
                </div>
                <SidebarLink href="/images" icon={HardDrive} label="Images" active={location.pathname === '/images'} />
                <SidebarLink href="/networks" icon={Network} label="Networks" active={location.pathname === '/networks'} />
                <SidebarLink href="/volumes" icon={Database} label="Volumes" active={location.pathname === '/volumes'} />
              </>
            )}

            {allowNginx && (
              <>
                <div className="pt-3 pb-1">
                  <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider px-3">Proxy</div>
                </div>
                <SidebarLink href="/proxy-hosts" icon={Globe} label="Proxy Hosts" active={location.pathname === '/proxy-hosts'} />
                <SidebarLink href="/redirections" icon={ArrowRight} label="Redirections" active={location.pathname === '/redirections'} />
                <SidebarLink href="/streams" icon={Radio} label="Streams" active={location.pathname === '/streams'} />
                <SidebarLink href="/dead-hosts" icon={Ban} label="404 Hosts" active={location.pathname === '/dead-hosts'} />
                <SidebarLink href="/certificates" icon={Shield} label="SSL Certificates" active={location.pathname === '/certificates'} />
                <SidebarLink href="/access-lists" icon={ShieldCheck} label="Access Lists" active={location.pathname === '/access-lists'} />
                <SidebarLink href="/custom-pages" icon={FileText} label="Error Pages" active={location.pathname === '/custom-pages'} />
                <SidebarLink href="/uptime" icon={Activity} label="Uptime" active={location.pathname === '/uptime'} />
              </>
            )}

            {isAdmin && (
              <>
                <div className="pt-3 pb-1">
                  <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider px-3">System</div>
                </div>
                <SidebarLink href="/users" icon={Users} label="Users" active={location.pathname === '/users'} />
                <SidebarLink href="/roles" icon={Shield} label="Roles" active={location.pathname === '/roles'} />
                <SidebarLink href="/settings" icon={Settings} label="Settings" active={location.pathname === '/settings'} />
              </>
            )}
          </nav>

          <div className="p-3 border-t border-border">
            <button onClick={() => navigate('/profile')}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
                location.pathname === '/profile'
                  ? 'bg-accent/10 text-accent font-medium'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
              }`}>
              <User size={16} />
              <span className="truncate">{cleanName}</span>
            </button>
          </div>
        </aside>

        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

export default function App() {
  const { checkSession } = useAuthStore();
  useEffect(() => { checkSession(); }, []);

  return (
    <BrowserRouter>
      <Toaster position="bottom-right" toastOptions={{ style: { background: 'rgb(22 27 34)', color: 'rgb(230 237 243)', border: '1px solid rgb(48 54 61)' } }} />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<ProtectedRoute><AppLayout><DashboardPage /></AppLayout></ProtectedRoute>} />
        <Route path="/stack/:id" element={<ProtectedRoute><AppLayout><StackDetailPage /></AppLayout></ProtectedRoute>} />
        <Route path="/managed-stacks" element={<ProtectedRoute><AppLayout><ManagedStacksPage /></AppLayout></ProtectedRoute>} />
        <Route path="/stack-editor/:id" element={<ProtectedRoute><AppLayout><StackEditorPage /></AppLayout></ProtectedRoute>} />
        <Route path="/images" element={<ProtectedRoute><AppLayout><ImagesPage /></AppLayout></ProtectedRoute>} />
        <Route path="/networks" element={<ProtectedRoute><AppLayout><NetworksPage /></AppLayout></ProtectedRoute>} />
        <Route path="/volumes" element={<ProtectedRoute><AppLayout><VolumesPage /></AppLayout></ProtectedRoute>} />
        <Route path="/proxy-hosts" element={<ProtectedRoute><AppLayout><ProxyHostsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/redirections" element={<ProtectedRoute><AppLayout><RedirectionsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/streams" element={<ProtectedRoute><AppLayout><StreamsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/dead-hosts" element={<ProtectedRoute><AppLayout><DeadHostsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/certificates" element={<ProtectedRoute><AppLayout><CertificatesPage /></AppLayout></ProtectedRoute>} />
        <Route path="/access-lists" element={<ProtectedRoute><AppLayout><AccessListsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/custom-pages" element={<ProtectedRoute><AppLayout><CustomPagesPage /></AppLayout></ProtectedRoute>} />
        <Route path="/uptime" element={<ProtectedRoute><AppLayout><UptimeMonitorsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/app-store" element={<ProtectedRoute><AppLayout><AppStorePage /></AppLayout></ProtectedRoute>} />
        <Route path="/users" element={<ProtectedRoute><AppLayout><UsersPage /></AppLayout></ProtectedRoute>} />
        <Route path="/roles" element={<ProtectedRoute><AppLayout><RolesPage /></AppLayout></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><AppLayout><SettingsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/profile" element={<ProtectedRoute><AppLayout><ProfilePage /></AppLayout></ProtectedRoute>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
