import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../supabase/functions/_shared/checkout.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { isCheckoutFulfillmentEvent, isCheckoutSessionPaid } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

assert.equal(isCheckoutSessionPaid({ payment_status: "paid" }), true,
  "Echo Pro can be granted after payment funds are available");
assert.equal(isCheckoutSessionPaid({ payment_status: "unpaid", status: "complete" }), false,
  "A completed session must not grant Pro while a delayed payment is pending");
assert.equal(isCheckoutSessionPaid({ payment_status: "no_payment_required", status: "complete" }), false,
  "A no-payment-required session must not grant the paid lifetime product");
assert.equal(isCheckoutFulfillmentEvent("checkout.session.completed"), true,
  "Immediate payment checkouts must be handled");
assert.equal(isCheckoutFulfillmentEvent("checkout.session.async_payment_succeeded"), true,
  "Delayed checkouts must be handled after Stripe confirms payment");
assert.equal(isCheckoutFulfillmentEvent("checkout.session.async_payment_failed"), false,
  "Failed delayed payments must never enter the fulfillment path");

console.log("Checkout payment confirmation regressions passed.");
