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
  ],
});
