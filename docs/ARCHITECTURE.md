# Architecture

The repository keeps two editable source roots:

- `source/` contains the Electron main, host, coordinator, local-exec, shared,
  and protocol reconstruction.
- `frontend/` contains the React renderer reconstruction.

The upstream 0.18.0 application is an external, checksum-pinned comparison
input.
`npm run bootstrap` extracts its `dist` tree to ignored `src/app/dist`. Build
scripts use that baseline for evidence and ABI-matched native support, compile
reviewed source runtimes, overlay eligible clean outputs, apply the reconstructed
updater guard, and pack a new ASAR.

The default release renderer is `frontend/src/main.tsx`; the checksum-pinned
`src/app/dist/renderer` remains available for pixel-fidelity comparisons. The
clean profile is built by the same distribution function for both `npm run dev`
and `npm run package`. Running
`npm run frontend:recover` produces an ignored, expanded snapshot at
`recovered/frontend/app`; `--renderer recovered` serves that snapshot for
forensic inspection. The upstream package does not ship its original
TypeScript/JSX source maps, so the checked-in `frontend/src` tree is an
evidence-backed reconstruction rather than a claim of original source.

Small manifests remain checked in only where the build consumes them directly.
Large recovery reports, source capsules, rejected candidate evidence, and
screenshots live only in the private forensic history and are not part of this
branch's product tree.
