import { Button } from "../components/Button";

export function Checkout({ onPay }: { onPay: () => void }) {
  return (
    <main>
      <h1>Checkout</h1>
      <Button label="Pay now" onClick={onPay} />
    </main>
  );
}
