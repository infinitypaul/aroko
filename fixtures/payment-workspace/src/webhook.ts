import { buildSuccessfulPaymentResponse } from "./payment.js";

export function handleWebhookPayment(payment: { customerId: string; reference: string }) {
  return buildSuccessfulPaymentResponse(payment);
}
