import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createClient, type AuthChangeEvent, type Session, type SupportedStorage } from "@supabase/supabase-js";

const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const SUPABASE_URL = "https://glkriavrwsissibmwxhd.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_JMOFx_LYWWkusmTdABVxRQ_1BkFvxw-";
export const AUTH_CALLBACK_URL = "echo://auth/callback";
export const AUTH_RESET_PASSWORD_URL = "echo://auth/reset-password";
const AUTH_STORAGE_KEY = "sb-glkriavrwsissibmwxhd-auth-token";
const AUTH_CODE_VERIFIER_STORAGE_KEY = `${AUTH_STORAGE_KEY}-code-verifier`;
const AUTH_CODE_VERIFIER_FALLBACK_KEY = "echo-pkce-code-verifier";
const RESTART_GOOGLE_SIGN_IN_MESSAGE = "Start Google sign-in again from Echo.";

export interface AuthUserSummary {
  id: string;
  email: string;
  provider: string;
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
  if (typeof window !== "undefined") {
    window.localStorage.setItem(key, value);
  }
}

async function getRawAuthStorage(key: string) {
  const stored = await tauriAuthStorage.getItem(key);
  if (stored) return stored;
  if (typeof window !== "undefined") {
    return window.localStorage.getItem(key);
  }
  return null;
}

async function removeRawAuthStorage(key: string) {
  await tauriAuthStorage.removeItem(key);
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(key);
  }
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

  await clearPkceVerifier();
  return data.session;
}

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
  const verifier = randomPkceVerifier();
  const { challenge, method } = await pkceChallenge(verifier);
  await persistPkceVerifier(verifier);

  const url = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
  url.search = new URLSearchParams({
    provider: "google",
    redirect_to: AUTH_CALLBACK_URL,
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
      redirectTo: AUTH_CALLBACK_URL,
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

export async function signUpWithPassword(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: AUTH_CALLBACK_URL,
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
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
