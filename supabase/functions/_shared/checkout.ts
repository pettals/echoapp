/**
 * Echo Pro is granted only when Stripe says the payment funds are available.
 * A Checkout Session can be complete while a delayed payment is still pending.
 */
export function isCheckoutSessionPaid(session: { payment_status?: unknown }): boolean {
  return session.payment_status === "paid";
}

export function isCheckoutFulfillmentEvent(eventType: unknown): boolean {
  return eventType === "checkout.session.completed" ||
    eventType === "checkout.session.async_payment_succeeded";
}
