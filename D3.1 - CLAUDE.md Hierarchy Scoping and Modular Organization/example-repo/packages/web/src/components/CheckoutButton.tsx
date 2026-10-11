import styles from "./CheckoutButton.module.css";

export interface CheckoutButtonProps {
  label: string;
  disabled?: boolean;
  onCheckout: () => void;
}

export function CheckoutButton({ label, disabled = false, onCheckout }: CheckoutButtonProps) {
  return (
    <button type="button" className={styles.button} disabled={disabled} onClick={onCheckout}>
      {label}
    </button>
  );
}
