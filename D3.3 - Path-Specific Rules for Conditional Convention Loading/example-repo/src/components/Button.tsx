import styles from "./Button.module.css";

export interface ButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

export function Button({ label, onPress, disabled = false }: ButtonProps) {
  return (
    <button type="button" className={styles.root} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  );
}
