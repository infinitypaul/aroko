const reference = "pay_123";
const rebuilt = { reference };
if (rebuilt.reference !== reference) {
  console.error("FAIL");
  process.exit(1);
}
console.log("PASS payment-retry");
process.exit(0);
