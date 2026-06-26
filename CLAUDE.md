# CLAUDE.md

## TypeScript

- Enable strict mode — no `any`, no `as` type assertions, no `!` non-null assertions, no `@ts-ignore`.
- Use `import type { ... }` for type-only imports; keep them separate from value imports.
- Prefer `type` aliases over `interface` unless declaration merging is needed.
- Define object shapes with `type`; define component Props inline after the function signature.
- Model state machines with discriminated unions — never with multiple optional fields.
- Validate at runtime boundaries (API responses, user input) with Zod — don't trust type assertions.
- Never import inside functions; all imports go at the top of the file.
- Prefer generics over `any`; prefer `unknown` over `any`.
- Shared types go in `src/types.ts` — don't scatter type definitions across files.

### Errors & null handling

- Check `null` and `undefined` together with `== null`.
- Prefer optional chaining `?.` and nullish coalescing `??` over deeply nested `&&` guards.
- Extend `Error` with custom subclasses — never throw raw `new Error('...')`.
- Never expose internal error details to clients. Log details server-side; return generic messages to users.
- Validate environment variables at the entry point: throw immediately if missing, don't check repeatedly at runtime.

### Arrays & immutability

- Never mutate in place: use `[...arr].sort()` / `.toSorted()` / `.toReversed()` over `.sort()` / `.reverse()`.
- `Array.filter(Boolean)` to strip falsy values.
- `Array.flatMap` over `.map().flat()`.
- Use Map/Set for frequent lookups and deduplication; use plain objects only for fixed-key records.

## React Components

- Functional components with named exports: `export function Button({ ... }: { ... }) { ... }`
- No default exports — `React.lazy()` is the only exception.
- PascalCase for component files (`UserAvatar.tsx`); camelCase for hooks and utils (`useAuth.ts`).
- One component per file. Private sub-components live at the bottom of the same file.
- Component internal order: destructure props → hooks → derived state / callbacks → early returns → JSX.
- Each component does exactly one thing. Consider splitting past ~150 lines.

### State management

| Data type | Solution |
|-----------|----------|
| Server data (API responses, caching) | Async fetch + custom hook encapsulation |
| Global client state (theme, locale, preferences) | context + useState or lightweight store |
| Local component state (form inputs, toggles) | useState / useReducer |
| URL-derived state (filters, pagination) | Read from URL search params; don't sync bidirectionally |

- Don't pull in unnecessary external state libraries.
- Don't hoist non-shared state into a global store. Don't prop-drill beyond 2 levels.

### Hooks

- Custom hooks start with `use`. Return tuples or objects — be consistent within the project.
- Only use `useMemo` / `useCallback` for:
  - Referential stability passed to `React.memo` children
  - Stable values needed in dependency arrays of other hooks
  - Computationally meaningful derived data (large list filtering / sorting)
- Every `useEffect` must clean up after itself: timers, subscriptions, WebSocket, event listeners.
- Never sync state inside `useEffect` that can be derived during render.

### JSX guidelines

- Conditional rendering: `{cond && <Comp />}` or `{cond ? <A /> : <B />}` — `cond` must be a boolean expression.
- List rendering: stable `key` is mandatory. Never use index as key (except for static lists).
- Break props onto separate lines when there are more than 3.
- Omit value for boolean props when `true`: `<Button disabled />`
- Never embed complex logic in JSX — extract to variables or functions first.

## Styling

- Use Tailwind CSS directly in JSX class strings.
- No CSS Modules, CSS-in-JS, or standalone style files.
- Use semantic CSS custom property tokens for colors — never hardcode hex/rgb values.
- Responsive design: mobile-first. Layer breakpoints from small to large.
- Reuse styles with `cn()` / `cva()` — never copy-paste class strings.

## Naming

- Variables & functions: camelCase, semantically clear — `fetchNodes` not `fn`, `activeRegion` not `ar`.
- Components: PascalCase, describes what it renders — `UserCard` not `Card2`.
- Files: match the primary export name (PascalCase for components, camelCase for utils/hooks).
- Event callbacks: `on` prefix → `onClose`, `onToggle`. Props use `onXxx`; handlers use `handleXxx`.
- Booleans: `is` / `has` / `should` prefix.
- Constants: UPPER_SNAKE_CASE only for truly constant values (not derived from runtime data).
- No pinyin. No meaningless abbreviations.

## Functions

- A function does one thing. Its name describes the return value or side effect.
- Pure functions over functions with side effects. Push I/O and side effects to the boundary.
- Use an options object `{ ... }` when there are more than 3 parameters.
- No boolean flag parameters — split into two functions or use an options object.
- No `function` keyword. Use `const fn = () => {}` or `export function` syntax.
- Exported functions must have a JSDoc comment describing their purpose.

## Modules & imports

- No default exports. Named exports everywhere.
- Import order: third-party libraries → internal project modules → type imports.
- No deeply nested relative paths (`../../..`). Use a path alias when nesting exceeds 2 levels.
- No circular dependencies. Push shared logic down to utils; feature components only import from utils.
- No barrel export index files — they break tree-shaking and invite circular dependencies.

## Errors & boundaries

- Every Promise must handle rejection — no omitted `.catch` or unguarded `await`.
- Every network request must have a deadline. Clean up resources on timeout.
- Component-level error boundaries catch and degrade gracefully — never crash to a blank page.
- User-facing error messages describe the problem in user language, not developer language.

## Git

- Conventional Commits: `feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `style:` / `test:` / `perf:`.
- Commit messages describe what changed and why — not which files were touched.
- One commit does one thing.
- Never commit temporary files, local IDE config, or environment-specific files.
- Pass typecheck before committing.

## Security

- Never hardcode secrets, tokens, or passwords — environment variables, validated at startup.
- Never trust client input — always validate server-side.
- Never leak internal stack traces, paths, or database structure to the client.
- Sanitize user-generated content for XSS before rendering.
- Use parameterized queries for SQL — never concatenate user input into query strings.
- Never commit: `.env*`, `*.pem`, `*.key`, `credentials*`.

## Don't do

- Don't use `any` or `as` to bypass the type system.
- Don't use default exports.
- Don't re-export from index files.
- Don't mutate state during render.
- Don't call hooks conditionally.
- Don't leave side effects without cleanup.
- Don't add new dependencies without team agreement.
- Don't commit commented-out code.
- Don't use magic numbers — extract to named constants.
- Don't abstract prematurely — wait until a pattern appears 3 times before extracting.
