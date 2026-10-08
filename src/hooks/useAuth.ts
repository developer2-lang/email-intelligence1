import { useCallback, useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../supabase'

export interface SignInResult {
  error: string | null
}

const LOGIN_TIMESTAMP_KEY = 'ei_login_timestamp'
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000 // 72 hours (3 days)

function isSessionExpired(): boolean {
  const stored = localStorage.getItem(LOGIN_TIMESTAMP_KEY)
  if (!stored) return false
  const loginTime = parseInt(stored, 10)
  if (isNaN(loginTime) || loginTime <= 0) return false
  return Date.now() - loginTime > THREE_DAYS_MS
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    const init = async () => {
      try {
        // If 3 days have elapsed since login, expire the session
        if (isSessionExpired()) {
          localStorage.removeItem(LOGIN_TIMESTAMP_KEY)
          await supabase.auth.signOut()
          if (!active) return
          setUser(null)
          setLoading(false)
          return
        }

        // Within 3 days: restore persisted session across page refreshes
        const { data, error } = await supabase.auth.getSession()
        if (!active) return

        if (!error && data?.session?.user) {
          if (!localStorage.getItem(LOGIN_TIMESTAMP_KEY)) {
            localStorage.setItem(LOGIN_TIMESTAMP_KEY, String(Date.now()))
          }
          setUser(data.session.user)
        } else {
          setUser(null)
        }
      } catch {
        if (active) setUser(null)
      } finally {
        if (active) setLoading(false)
      }
    }

    void init()

    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return

      if (event === 'SIGNED_OUT' || !session) {
        localStorage.removeItem(LOGIN_TIMESTAMP_KEY)
        setUser(null)
        setLoading(false)
        return
      }

      if (event === 'SIGNED_IN') {
        // A fresh sign in: record current timestamp and set user immediately
        localStorage.setItem(LOGIN_TIMESTAMP_KEY, String(Date.now()))
        setUser(session.user)
        setLoading(false)
        return
      }

      // For other events (TOKEN_REFRESHED, etc.), check if 3 days have passed
      if (session.user) {
        if (isSessionExpired()) {
          localStorage.removeItem(LOGIN_TIMESTAMP_KEY)
          void supabase.auth.signOut()
          setUser(null)
        } else {
          setUser(session.user)
        }
      }
      setLoading(false)
    })

    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [])

  const signIn = useCallback(async (email: string, password: string): Promise<SignInResult> => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        return { error: error.message }
      }
      if (data.session?.user) {
        localStorage.setItem(LOGIN_TIMESTAMP_KEY, String(Date.now()))
        setUser(data.session.user)
      }
      return { error: null }
    } catch (err: any) {
      return { error: err?.message || 'Failed to sign in. Please try again.' }
    }
  }, [])

  const signOut = useCallback(async () => {
    localStorage.removeItem(LOGIN_TIMESTAMP_KEY)
    setUser(null)
    await supabase.auth.signOut()
  }, [])

  return { user, loading, signIn, signOut }
}