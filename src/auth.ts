import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createClient, type AuthChangeEvent, type Session, type SupportedStorage } from "@supabase/supabase-js";

const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const SUPABASE_URL = "https://glkriavrwsissibmwxhd.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_JMOFx_LYWWkusmTdABVxRQ_1BkFvxw-";
export const AUTH_CALLBACK_URL = "echo://auth/callback";
export const AUTH_RESET_PASSWORD_URL = "echo://auth/reset-password";

export interface AuthUserSummary {
  id: string;
  email: string;
  provider: string;
}

export type AuthEventHandler = (event: AuthChangeEvent, session: Session | null) => void;

const tauriAuthStorage: SupportedStorage = {
  async getItem(key) {
    if (!HAS_TAURI) return window.localStorage.getItem(key);
    return invoke<string | null>("get_auth_storage", { key });
  },
  async setItem(key, value) {
    if (!HAS_TAURI) {
      window.localStorage.setItem(key, value);
      return;
    }
    await invoke("set_auth_storage", { key, value });
  },
  async removeItem(key) {
    if (!HAS_TAURI) {
      window.localStorage.removeItem(key);
      return;
    }
    await invoke("delete_auth_storage", { key });
  },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: false,
    flowType: "pkce",
    persistSession: true,
    storage: tauriAuthStorage,
  },
});

export function summarizeSession(session: Session | null): AuthUserSummary | null {
  const user = session?.user;
  if (!user) return null;
  const provider = String(user.app_metadata?.provider ?? "email");
  return {
    id: user.id,
    email: user.email ?? "Unknown email",
    provider: provider === "google" ? "Google" : "Email",
  };
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthStateChange(handler: AuthEventHandler) {
  return supabase.auth.onAuthStateChange(handler).data.subscription;
}

export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: AUTH_CALLBACK_URL,
      scopes: "openid email profile",
      skipBrowserRedirect: HAS_TAURI,
      queryParams: {
        prompt: "select_account",
      },
    },
  });
  if (error) throw error;

  if (data.url) {
    if (HAS_TAURI) {
      await openUrl(data.url);
    } else {
      window.location.assign(data.url);
    }
  }
}

export async function signInWithPassword(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signUpWithPassword(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: AUTH_CALLBACK_URL,
    },
  });
  if (error) throw error;
  return data;
}

export async function sendPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: AUTH_RESET_PASSWORD_URL,
  });
  if (error) throw error;
}

export async function updatePassword(password: string) {
  const { data, error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
  return data.user;
}

export async function exchangeCodeForSession(code: string) {
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
