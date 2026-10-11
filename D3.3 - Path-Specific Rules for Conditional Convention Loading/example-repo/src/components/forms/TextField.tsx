import { useId } from "react";
import styles from "./TextField.module.css";

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

export function TextField({ label, value, onChange, error }: TextFieldProps) {
  const id = useId();
  return (
    <div className={styles.root}>
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} aria-invalid={Boolean(error)} onChange={(e) => onChange(e.target.value)} />
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
