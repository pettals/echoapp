import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createClient, type AuthChangeEvent, type Session, type SupportedStorage } from "@supabase/supabase-js";

const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// This is intentionally opt-in and development-only. It lets local Windows
// builds exercise the app shell while OAuth is being repaired, without ever
// weakening the production authentication gate.
export const DEV_AUTH_BYPASS =
  import.meta.env.DEV && import.meta.env.VITE_ECHO_DEV_BYPASS_AUTH === "true";
export const DEV_AUTH_USER: AuthUserSummary = {
  id: "echo-dev-user",
  email: "dev@localhost",
  provider: "Development",
};

export const SUPABASE_URL = "https://glkriavrwsissibmwxhd.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_JMOFx_LYWWkusmTdABVxRQ_1BkFvxw-";
export const AUTH_APP_SCHEME = import.meta.env.DEV ? "echo-dev" : "echo";
export const AUTH_CALLBACK_URL = `${AUTH_APP_SCHEME}://auth/callback`;
export const AUTH_GOOGLE_CALLBACK_URL = import.meta.env.DEV
  ? "https://pettals.co.uk/echo/auth/callback/?protocol=echo-dev"
  : "https://pettals.co.uk/echo/auth/callback/";
export const AUTH_RESET_PASSWORD_URL = import.meta.env.DEV
  ? "https://pettals.co.uk/echo/auth/callback/?protocol=echo-dev&flow=reset"
  : "https://pettals.co.uk/echo/auth/callback/?flow=reset";
const AUTH_STORAGE_KEY = "sb-glkriavrwsissibmwxhd-auth-token";
const AUTH_CODE_VERIFIER_STORAGE_KEY = `${AUTH_STORAGE_KEY}-code-verifier`;
const AUTH_USER_STORAGE_KEY = `${AUTH_STORAGE_KEY}-user`;
const AUTH_CODE_VERIFIER_FALLBACK_KEY = "echo-pkce-code-verifier";
const RESTART_GOOGLE_SIGN_IN_MESSAGE = "Start Google sign-in again from Echo.";

export interface AuthUserSummary {
  id: string;
  email: string;
  provider: string;
}

export interface SignUpProfile {
  firstName: string;
  lastName: string;
}

export type AuthEventHandler = (event: AuthChangeEvent, session: Session | null) => void;

function localStorageGet(key: string) {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function localStorageSet(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Secure storage remains the source of truth in Tauri builds.
  }
}

function localStorageRemove(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Best-effort cleanup only.
  }
}

function isMigratableAuthKey(key: string) {
  return key === AUTH_STORAGE_KEY || key === AUTH_USER_STORAGE_KEY;
}

const tauriAuthStorage: SupportedStorage = {
  async getItem(key) {
    if (!HAS_TAURI) return localStorageGet(key);
    const stored = await invoke<string | null>("get_auth_storage", { key });
    if (stored || !isMigratableAuthKey(key)) return stored;

    const legacyStored = localStorageGet(key);
    if (!legacyStored) return null;

    await invoke("set_auth_storage", { key, value: legacyStored });
    localStorageRemove(key);
    return legacyStored;
  },
  async setItem(key, value) {
    if (!HAS_TAURI) {
      localStorageSet(key, value);
      return;
    }
    await invoke("set_auth_storage", { key, value });
    localStorageRemove(key);
  },
  async removeItem(key) {
    if (!HAS_TAURI) {
      localStorageRemove(key);
      return;
    }
    await invoke("delete_auth_storage", { key });
    localStorageRemove(key);
  },
};

async function setRawAuthStorage(key: string, value: string) {
  await tauriAuthStorage.setItem(key, value);
  localStorageSet(key, value);
}

async function getRawAuthStorage(key: string) {
  const stored = await tauriAuthStorage.getItem(key);
  if (stored) return stored;
  return localStorageGet(key);
}

async function removeRawAuthStorage(key: string) {
  await tauriAuthStorage.removeItem(key);
  localStorageRemove(key);
}

async function backupPkceVerifier() {
  const storedVerifier = await getRawAuthStorage(AUTH_CODE_VERIFIER_STORAGE_KEY);
  if (storedVerifier) {
    await setRawAuthStorage(AUTH_CODE_VERIFIER_FALLBACK_KEY, storedVerifier);
  }
}

async function clearPkceVerifier() {
  await removeRawAuthStorage(AUTH_CODE_VERIFIER_STORAGE_KEY);
  await removeRawAuthStorage(AUTH_CODE_VERIFIER_FALLBACK_KEY);
}

function isInvalidStoredSessionError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes("invalid refresh token") ||
    message.includes("refresh token not found") ||
    message.includes("refresh_token_not_found") ||
    message.includes("invalid_grant")
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: false,
    flowType: "pkce",
    persistSession: true,
    storageKey: AUTH_STORAGE_KEY,
    storage: tauriAuthStorage,
    userStorage: tauriAuthStorage,
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

export async function getFreshSession(currentSession?: Session | null) {
  try {
    const session = await getSession();
    if (session?.access_token) return session;
  } catch (e) {
    if (!currentSession?.refresh_token) throw e;
  }

  if (!currentSession?.refresh_token) return null;
  const { data, error } = await supabase.auth.refreshSession(currentSession);
  if (error) throw error;
  return data.session;
}

export async function restorePersistedSession() {
  try {
    return await getFreshSession(null);
  } catch (e) {
    if (isInvalidStoredSessionError(e)) {
      await clearAuthSessionStorage();
      return null;
    }
    throw e;
  }
}

export async function clearAuthSessionStorage() {
  await Promise.allSettled([
    tauriAuthStorage.removeItem(AUTH_STORAGE_KEY),
    tauriAuthStorage.removeItem(AUTH_USER_STORAGE_KEY),
    removeRawAuthStorage(AUTH_CODE_VERIFIER_STORAGE_KEY),
    removeRawAuthStorage(AUTH_CODE_VERIFIER_FALLBACK_KEY),
  ]);
}

export function onAuthStateChange(handler: AuthEventHandler) {
  return supabase.auth.onAuthStateChange(handler).data.subscription;
}

export async function signInWithGoogle() {
  return signInWithGoogleViaClient();
}

export async function signInWithGoogleViaClient() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: AUTH_GOOGLE_CALLBACK_URL,
      scopes: "openid email profile",
      skipBrowserRedirect: HAS_TAURI,
      queryParams: {
        prompt: "select_account",
      },
    },
  });
  if (error) throw error;
  await backupPkceVerifier();

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

export async function signUpWithPassword(
  email: string,
  password: string,
  profile: SignUpProfile
) {
  const firstName = profile.firstName.trim();
  const lastName = profile.lastName.trim();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: AUTH_CALLBACK_URL,
      data: {
        first_name: firstName,
        last_name: lastName,
        full_name: `${firstName} ${lastName}`,
      },
    },
  });
  if (error) throw error;
  await backupPkceVerifier();
  return data;
}

export async function sendPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: AUTH_RESET_PASSWORD_URL,
  });
  if (error) throw error;
  await backupPkceVerifier();
}

export async function updatePassword(password: string) {
  const { data, error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
  return data.user;
}

export async function exchangeCodeForSession(code: string) {
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    await clearPkceVerifier();
    throw new Error(error.message || RESTART_GOOGLE_SIGN_IN_MESSAGE);
  }
  if (!data.session) {
    await clearPkceVerifier();
    throw new Error("Echo could not restore your sign-in session. Start sign-in again from Echo.");
  }
  await clearPkceVerifier();
  return data.session;
}

export async function signOut() {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  } finally {
    await clearAuthSessionStorage();
  }
}
