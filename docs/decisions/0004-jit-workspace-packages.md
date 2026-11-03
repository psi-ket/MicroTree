# 0004 — Internal packages export TypeScript source

## Decision
Workspace packages (`packages/*`) point `exports` at `src/*.ts`. Vite compiles
them for the web app, `tsx` runs them for the runtime in development, and the
runtime production build bundles them with tsup (`noExternal`). Each package
still has its own `typecheck`, `lint` and `test` tasks run by Turborepo.

## Consequences
+ No watch-build step between packages; instant feedback; one tsconfig base.
− Packages are not publishable to npm as-is (not a goal).
