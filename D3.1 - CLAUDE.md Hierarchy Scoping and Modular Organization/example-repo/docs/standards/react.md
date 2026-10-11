# React conventions

- Function components and hooks only; no class components.
- One component per file, named after the component (`CheckoutButton.tsx`).
- Server state goes through TanStack Query hooks in `src/api/`; never fetch inside `useEffect`.
- Type props with an exported `interface <Component>Props`.
- Every interactive element is keyboard reachable and has an accessible name; tests query with `getByRole`.
- Style with CSS modules (`Component.module.css`); inline style objects only for dynamic values.
