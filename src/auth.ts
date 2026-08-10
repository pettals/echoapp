import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createClient, type AuthChangeEvent, type Session, type SupportedStorage } from "@supabase/supabase-js";

const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const SUPABASE_URL = "https://glkriavrwsissibmwxhd.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_JMOFx_LYWWkusmTdABVxRQ_1BkFvxw-";
export const AUTH_CALLBACK_URL = "echo://auth/callback";
export const AUTH_GOOGLE_CALLBACK_URL = "https://pettals.co.uk/echo/auth/callback/";
export const AUTH_RESET_PASSWORD_URL = "echo://auth/reset-password";
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

interface PkceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_code?: string;
  error_description?: string;
  msg?: string;
  message?: string;
}

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

function randomPkceVerifier() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const values = new Uint8Array(64);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

function base64Url(bytes: Uint8Array) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier: string) {
  if (!crypto.subtle) {
    return { challenge: verifier, method: "plain" };
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { challenge: base64Url(new Uint8Array(digest)), method: "s256" };
}

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

async function persistPkceVerifier(verifier: string, redirectType?: "recovery") {
  const storedVerifier = JSON.stringify(redirectType ? `${verifier}/${redirectType}` : verifier);
  await setRawAuthStorage(AUTH_CODE_VERIFIER_STORAGE_KEY, storedVerifier);
  await setRawAuthStorage(AUTH_CODE_VERIFIER_FALLBACK_KEY, storedVerifier);
}

async function backupPkceVerifier() {
  const storedVerifier = await getRawAuthStorage(AUTH_CODE_VERIFIER_STORAGE_KEY);
  if (storedVerifier) {
    await setRawAuthStorage(AUTH_CODE_VERIFIER_FALLBACK_KEY, storedVerifier);
  }
}

async function restorePkceVerifier() {
  const storedVerifier = await getRawAuthStorage(AUTH_CODE_VERIFIER_STORAGE_KEY);
  if (storedVerifier) return;
  const fallbackVerifier = await getRawAuthStorage(AUTH_CODE_VERIFIER_FALLBACK_KEY);
  if (fallbackVerifier) {
    await setRawAuthStorage(AUTH_CODE_VERIFIER_STORAGE_KEY, fallbackVerifier);
  }
}

async function getPkceVerifier() {
  const storedVerifier =
    (await getRawAuthStorage(AUTH_CODE_VERIFIER_STORAGE_KEY)) ??
    (await getRawAuthStorage(AUTH_CODE_VERIFIER_FALLBACK_KEY));
  if (!storedVerifier) {
    throw new Error(RESTART_GOOGLE_SIGN_IN_MESSAGE);
  }

  let parsedVerifier = storedVerifier;
  try {
    const parsed = JSON.parse(storedVerifier);
    if (typeof parsed === "string") {
      parsedVerifier = parsed;
    }
  } catch {
    parsedVerifier = storedVerifier;
  }

  const [verifier] = parsedVerifier.split("/");
  if (!verifier) {
    throw new Error(RESTART_GOOGLE_SIGN_IN_MESSAGE);
  }
  return verifier;
}

async function clearPkceVerifier() {
  await removeRawAuthStorage(AUTH_CODE_VERIFIER_STORAGE_KEY);
  await removeRawAuthStorage(AUTH_CODE_VERIFIER_FALLBACK_KEY);
}

function authApiMessage(payload: PkceTokenResponse, fallback: string) {
  return payload.error_description ?? payload.message ?? payload.msg ?? payload.error ?? fallback;
}

function isDefiniteStaleCodeFailure(status: number, payload: PkceTokenResponse) {
  const detail = [
    payload.error,
    payload.error_code,
    payload.error_description,
    payload.message,
    payload.msg,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    status === 400 &&
    (detail.includes("invalid_grant") ||
      detail.includes("bad_code_verifier") ||
      detail.includes("expired") ||
      detail.includes("already") ||
      detail.includes("used") ||
      detail.includes("invalid request"))
  );
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

async function exchangePkceCodeForSession(code: string) {
  const verifier = await getPkceVerifier();
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_code: code,
      code_verifier: verifier,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as PkceTokenResponse;
  if (!response.ok) {
    if (isDefiniteStaleCodeFailure(response.status, payload)) {
      await clearPkceVerifier();
    }
    throw new Error(authApiMessage(payload, RESTART_GOOGLE_SIGN_IN_MESSAGE));
  }

  if (!payload.access_token || !payload.refresh_token) {
    throw new Error("Echo received an incomplete sign-in response. Start Google sign-in again from Echo.");
  }

  const { data, error } = await supabase.auth.setSession({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
  });
  if (error) throw error;
  if (!data.session) {
    throw new Error("Echo could not persist your sign-in session. Start Google sign-in again from Echo.");
  }

  const confirmedSession = await getFreshSession(data.session);
  if (!confirmedSession?.access_token) {
    throw new Error("Echo could not restore your sign-in session. Start Google sign-in again from Echo.");
  }

  await clearPkceVerifier();
  return confirmedSession;
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
  const verifier = randomPkceVerifier();
  const { challenge, method } = await pkceChallenge(verifier);
  await persistPkceVerifier(verifier);

  const url = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
  url.search = new URLSearchParams({
    provider: "google",
    redirect_to: AUTH_GOOGLE_CALLBACK_URL,
    scopes: "openid email profile",
    code_challenge: challenge,
    code_challenge_method: method,
    prompt: "select_account",
  }).toString();

  if (HAS_TAURI) {
    await openUrl(url.toString());
  } else {
    window.location.assign(url.toString());
  }
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
  await restorePkceVerifier();
  return exchangePkceCodeForSession(code);
}

export async function signOut() {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  } finally {
    await clearAuthSessionStorage();
  }
}
