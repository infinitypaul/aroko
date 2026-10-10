export function buildSuccessfulPaymentResponse(payment: { customerId: string; reference: string }) {
  return {
    customerId: payment.customerId,
    paymentReference: payment.reference
  };
}
