import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The Chrome extension lives under web/extension/ but has its own
    // tsconfig + package.json + esbuild pipeline. Keep it out of the
    // Next.js linter so chrome.* globals don't trip it.
    "extension/**",
  ]),
]);

export default eslintConfig;
