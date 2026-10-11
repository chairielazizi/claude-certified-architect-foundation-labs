export function RefundStatus({ refundId }: { refundId: string | null }) {
  if (!refundId) return <p>Refund window expired. Contact support.</p>;
  return <p>Refund {refundId} is on its way.</p>;
}
