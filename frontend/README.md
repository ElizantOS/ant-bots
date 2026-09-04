# Renderer source

This directory contains the editable React/TypeScript renderer reconstruction.
It is built with Vite and is the default Renderer for `npm run package` and
`npm run dev`. Use `npm run package:fidelity` or
`npm run dev -- --renderer upstream` only to compare against the checksum-pinned
shipped renderer.

The small files under `manifests/` identify assets and reviewed semantic
boundaries. The upstream renderer itself is not tracked: `npm run bootstrap`
hydrates its checksum-pinned payload under ignored `src/app/dist`, and
`npm run frontend:recover` can create an ignored formatted copy for inspection.

Source development is independent of the pinned DMG. The source renderer uses
the checked-in static assets under `frontend/public/assets` and npm package
dependencies; only `--renderer upstream`/`recovered` and fidelity packaging
need the hydrated upstream payload.

Run the editable renderer checks from the repository root:

```sh
npm run typecheck
npm run frontend:build
```

Comments beginning with `@evidence` point to byte or symbol boundaries in the
bootstrapped 0.18.0 renderer. They are provenance annotations, not imports.
