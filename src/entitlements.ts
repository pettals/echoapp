import { invoke } from "@tauri-apps/api/core";
import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from "@supabase/supabase-js";
import { getSession, supabase } from "./auth";

const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type EntitlementTier = "free" | "pro_lifetime";

export interface EntitlementFeatures {
  unlimitedHistory: boolean;
  cloudProvider: boolean;
}

export interface EntitlementStatus {
  tier: EntitlementTier;
  features: EntitlementFeatures;
  checkedAt: string;
  graceUntil: string | null;
  leaseUntil: string | null;
  requiresOnline: boolean;
  source: string;
}

interface ServerEntitlementStatus {
  tier: EntitlementTier;
  features: EntitlementFeatures;
  checkedAt: string;
  graceUntil: string | null;
  leaseUntil?: string | null;
  requiresOnline?: boolean;
}

interface CheckoutSessionResponse {
  id: string;
  url: string;
}

interface ConfirmCheckoutSessionResponse extends ServerEntitlementStatus {}

type AuthSession = Awaited<ReturnType<typeof getSession>>;

export const FREE_ENTITLEMENT: EntitlementStatus = {
  tier: "free",
  features: {
    unlimitedHistory: false,
    cloudProvider: false,
  },
  checkedAt: "",
  graceUntil: null,
  leaseUntil: null,
  requiresOnline: true,
  source: "free",
};

export const ONLINE_PRO_REQUIRED_MESSAGE =
  "No internet connection. Echo is using local transcription until Pro can be verified.";
export const NO_PRO_PURCHASE_MESSAGE = "No Echo Pro purchase is linked to this account yet.";
export const PRO_BILLING_UNAVAILABLE_MESSAGE = "Echo Pro billing is temporarily unavailable.";
export const PRO_SESSION_EXPIRED_MESSAGE = "Sign out and sign in again to restore Echo Pro.";
export const PRO_BILLING_UNREACHABLE_MESSAGE =
  "Echo Pro billing could not be reached. Check your connection and try again.";

const DEFAULT_PRO_LEASE_MS = 5 * 60 * 1000;

function leaseUntilFromNow() {
  return new Date(Date.now() + DEFAULT_PRO_LEASE_MS).toISOString();
}

export function entitlementLabel(entitlement: EntitlementStatus) {
  return entitlement.tier === "pro_lifetime" ? "Echo Pro" : "Free";
}

async function functionHttpErrorMessage(error: FunctionsHttpError, fallback: string) {
  const status = error.context.status;
  const payload = await error.context.json().catch(() => null);
  const detail =
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
      ? payload.error
      : payload &&
          typeof payload === "object" &&
          "message" in payload &&
          typeof payload.message === "string"
        ? payload.message
        : "";

  if (status === 401 || status === 403) return PRO_SESSION_EXPIRED_MESSAGE;
  if (status === 404) return PRO_BILLING_UNAVAILABLE_MESSAGE;
  if (status >= 500) {
    return detail ? `${PRO_BILLING_UNAVAILABLE_MESSAGE} ${detail}` : PRO_BILLING_UNAVAILABLE_MESSAGE;
  }
  return detail || fallback;
}

export async function billingFunctionErrorMessage(error: unknown, fallback: string) {
  if (error instanceof FunctionsHttpError) return functionHttpErrorMessage(error, fallback);
  if (error instanceof FunctionsRelayError) return PRO_BILLING_UNAVAILABLE_MESSAGE;
  if (error instanceof FunctionsFetchError) return PRO_BILLING_UNREACHABLE_MESSAGE;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return fallback;
}

export async function loadCachedEntitlement(userId: string): Promise<EntitlementStatus> {
  if (!HAS_TAURI) return FREE_ENTITLEMENT;
  return invoke<EntitlementStatus>("get_effective_entitlement", { userId });
}

export async function clearActiveEntitlementUser() {
  if (!HAS_TAURI) return;
  await invoke("clear_active_entitlement_user");
}

export async function refreshEntitlementFromServer(
  userId: string,
  sessionOverride?: AuthSession
): Promise<EntitlementStatus> {
  const session = sessionOverride ?? await getSession();
  if (!session?.access_token) throw new Error("Sign in before checking Echo Pro status.");

  const { data, error } = await supabase.functions.invoke<ServerEntitlementStatus>("get-entitlement", {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
    body: {},
  });
  if (error) throw new Error(await billingFunctionErrorMessage(error, PRO_BILLING_UNAVAILABLE_MESSAGE));
  if (!data) throw new Error("Echo Pro status was unavailable.");
  const paid = data.tier === "pro_lifetime";
  const leaseUntil = paid ? data.leaseUntil ?? leaseUntilFromNow() : null;

  if (HAS_TAURI) {
    return invoke<EntitlementStatus>("cache_entitlement", {
      cache: {
        userId,
        tier: data.tier,
        checkedAt: data.checkedAt,
        graceUntil: data.graceUntil ?? null,
        leaseUntil: leaseUntil ?? data.checkedAt,
      },
    });
  }

  return {
    ...data,
    graceUntil: data.graceUntil ?? null,
    leaseUntil,
    requiresOnline: data.requiresOnline ?? true,
    source: "server",
  };
}

export async function createCheckoutSession(
  sessionOverride?: AuthSession
): Promise<CheckoutSessionResponse> {
  const session = sessionOverride ?? await getSession();
  if (!session?.access_token) throw new Error("Sign in before unlocking Echo Pro.");

  const { data, error } = await supabase.functions.invoke<CheckoutSessionResponse>(
    "create-checkout-session",
    {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      body: {
        successUrl: "echo://billing/complete?session_id={CHECKOUT_SESSION_ID}",
        cancelUrl: "echo://billing/cancel",
      },
    }
  );
  if (error) throw new Error(await billingFunctionErrorMessage(error, PRO_BILLING_UNAVAILABLE_MESSAGE));
  if (!data?.url) throw new Error("Checkout did not return a payment link.");
  return data;
}

export async function confirmCheckoutSession(
  checkoutSessionId: string,
  sessionOverride?: AuthSession
): Promise<EntitlementStatus> {
  const session = sessionOverride ?? await getSession();
  if (!session?.access_token) throw new Error("Sign in before confirming Echo Pro.");

  const { data, error } = await supabase.functions.invoke<ConfirmCheckoutSessionResponse>(
    "confirm-checkout-session",
    {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      body: {
        checkoutSessionId,
      },
    }
  );
  if (error) throw new Error(await billingFunctionErrorMessage(error, PRO_BILLING_UNAVAILABLE_MESSAGE));
  if (!data) throw new Error("Checkout confirmation did not return Echo Pro status.");

  const paid = data.tier === "pro_lifetime";
  const leaseUntil = paid ? data.leaseUntil ?? leaseUntilFromNow() : null;

  if (HAS_TAURI && session.user?.id) {
    return invoke<EntitlementStatus>("cache_entitlement", {
      cache: {
        userId: session.user.id,
        tier: data.tier,
        checkedAt: data.checkedAt,
        graceUntil: data.graceUntil ?? null,
        leaseUntil: leaseUntil ?? data.checkedAt,
      },
    });
  }

  return {
    ...data,
    graceUntil: data.graceUntil ?? null,
    leaseUntil,
    requiresOnline: data.requiresOnline ?? true,
    source: "server",
  };
}
