import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { LayoutDashboard, Settings, User, LogOut } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { StackDetailPage } from '@/pages/StackDetailPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { NotFoundPage } from '@/pages/NotFoundPage';

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

function AppLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const isAdmin = user?.role === 'admin';

  const displayName = user?.displayName || user?.username || 'User';
  // Strip og_ prefix for SSO users
  const cleanName = displayName.startsWith('og_') ? displayName.slice(3) : displayName;

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen">
      <aside className="w-56 shrink-0 border-r border-border bg-bg-secondary flex flex-col">
        {/* Logo */}
        <div className="flex h-14 items-center px-4 border-b border-border">
          <img src="/logo.svg" alt="Oblihub" className="h-10 w-10 rounded-lg" />
        </div>

        {/* Nav links */}
        <nav className="flex-1 p-3 space-y-1">
          <SidebarLink href="/" icon={LayoutDashboard} label="Dashboard" active={location.pathname === '/' || location.pathname.startsWith('/stack/')} />
          {isAdmin && (
            <SidebarLink href="/settings" icon={Settings} label="Settings" active={location.pathname === '/settings'} />
          )}
        </nav>

        {/* Bottom section: profile + logout */}
        <div className="p-3 border-t border-border space-y-1">
          <button onClick={() => navigate('/profile')}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
              location.pathname === '/profile'
                ? 'bg-accent/10 text-accent font-medium'
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
            }`}>
            <User size={16} />
            <span className="truncate">{cleanName}</span>
          </button>
          <button onClick={handleLogout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:text-status-down hover:bg-status-down/10 rounded-lg transition-colors">
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">{children}</main>
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
        <Route path="/settings" element={<ProtectedRoute><AppLayout><SettingsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/profile" element={<ProtectedRoute><AppLayout><ProfilePage /></AppLayout></ProtectedRoute>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
