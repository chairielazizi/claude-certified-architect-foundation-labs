---
name: scaffold-component
description: Create a new React component with its test file and CSS module, following the team's component conventions. Use when asked to add or scaffold a component.
argument-hint: "[ComponentName] [directory]"
allowed-tools: Read Write
disable-model-invocation: true
---
Create the React component `$0` in `$1`.

1. If `$1/$0.tsx` already exists, stop and say so. Never overwrite a component.
2. Read one existing component in `$1` (if there is one) and match its style.
3. Write exactly these three files and nothing else:
   - `$1/$0.tsx`: a function component with an exported `interface $0Props` and a named export `$0`.
     No default export. Keyboard accessible, with an accessible name.
   - `$1/$0.test.tsx`: renders `$0` and queries it with `getByRole`. One behavior per test.
   - `$1/$0.module.css`: a single root class `.root`.
4. Do not edit existing files, install packages or run shell commands. If the component needs a new
   dependency, say which one and stop.

Finish by listing the three paths you wrote.
