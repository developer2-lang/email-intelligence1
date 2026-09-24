import { useState } from 'react'
import type { FormEvent } from 'react'
import type { SignInResult } from '../hooks/useAuth'

const TEST_EMAIL = 'developer2@iuova.in'

interface LoginPageProps {
  onSignIn: (email: string, password: string) => Promise<SignInResult>
}

export default function LoginPage({ onSignIn }: LoginPageProps) {
  const [email, setEmail] = useState(TEST_EMAIL)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError(null)
    setBusy(true)
    const result = await onSignIn(email.trim(), password)
    if (result.error) {
      setError(result.error)
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="side-logo" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 5.5h8M12 5.5v13M8 18.5h8" />
            </svg>
          </div>
          <div className="auth-brand-meta">
            <div className="auth-brand-name">IUOVA</div>
            <div className="auth-brand-sub">Email Intelligence</div>
          </div>
        </div>

        <div className="auth-title">Welcome back</div>
        <div className="auth-sub">Sign in to access your outreach dashboard.</div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@iuova.in"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <div className="auth-hint">Demo login · developer2@iuova.in</div>
      </div>
    </div>
  )
}