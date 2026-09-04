import { buildFidelityReconstructedAsar, buildReconstructedAsar } from "./clean-build.mjs";

const args = process.argv.slice(2);
const sourceFlag = args.includes("--source");
const fidelityFlag = args.includes("--fidelity");
if (sourceFlag && fidelityFlag) {
  throw new Error("Choose one build mode: --source or --fidelity.");
}
const fidelity = fidelityFlag;
const result = fidelity
  ? await buildFidelityReconstructedAsar()
  : await buildReconstructedAsar();
console.log(`Reconstructed ASAR: ${result.builtAsar}`);
console.log(`Renderer mode: ${fidelity ? "checksum-pinned upstream 0.18.0 payload" : "clean TypeScript source (frontend/src/main.tsx)"}`);
