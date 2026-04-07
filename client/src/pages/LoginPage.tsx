import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import toast from 'react-hot-toast';

export function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoading } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login(username, password);
      navigate('/');
    } catch {
      toast.error('Invalid credentials');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <img src="/logo.svg" alt="Oblihub" className="mx-auto h-24 w-24 mb-3" />
          <p className="mt-2 text-sm text-text-secondary">Sign in to continue</p>
        </div>
        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-bg-secondary p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Username</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <button type="submit" disabled={isLoading}
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
            {isLoading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
