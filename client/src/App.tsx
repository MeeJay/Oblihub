import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { StackDetailPage } from '@/pages/StackDetailPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isInitialized } = useAuthStore();
  if (!isInitialized) return <div className="flex h-screen items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen">
      <aside className="w-56 shrink-0 border-r border-border bg-bg-secondary flex flex-col">
        <div className="flex h-14 items-center px-4 border-b border-border">
          <img src="/logo.svg" alt="Oblihub" className="h-10 w-10 rounded-lg" />
        </div>
        <nav className="flex-1 p-3 space-y-1">
          <a href="/" className="flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-lg">Dashboard</a>
          <a href="/settings" className="flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-lg">Settings</a>
        </nav>
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
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
