---
paths: ["src/components/**/*.tsx"]
---
# React component conventions

- Function components and hooks only; named exports, no default exports.
- Props typed with an exported `interface <Component>Props`.
- Accessible by default: native elements (`button`, `label` + `input`), keyboard support, visible focus,
  an accessible name for every control.
- Style with the sibling CSS module (`<Component>.module.css`); inline styles only for dynamic values.
- Data comes in through props or `src/api` hooks; components never call `fetch` directly.
- `useEffect` only to synchronize with something external; derive values during render instead.
