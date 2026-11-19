// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      files: ["test/**/*.ts"],
      rules: {
        // One file per area, several describe() blocks each
        "mocha/max-top-level-suites": "off",
      },
    },
    {
      // The stdio bridge and its tests run in Node, not in Zotero
      files: ["addon/content/bridge/*.mjs", "bridge/*.mjs"],
      languageOptions: {
        globals: {
          AbortSignal: "readonly",
          Buffer: "readonly",
          URL: "readonly",
          clearInterval: "readonly",
          clearTimeout: "readonly",
          fetch: "readonly",
          process: "readonly",
          setInterval: "readonly",
          setTimeout: "readonly",
        },
      },
    },
  ],
});
