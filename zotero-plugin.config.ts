import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  // Default would be kebab-case of the name: "zotero-s-2"
  xpiName: "zotero-s2",
  // Zotero requires an update_url. Until package.json "repository" names the
  // real GitHub repo (currently a placeholder), point it nowhere so no third
  // party can serve updates. Then switch to:
  // https://github.com/{{owner}}/{{repo}}/releases/download/release/update.json
  updateURL: "https://localhost/zotero-s2/update.json",
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox140",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    // Keep clear of a running everyday Zotero on 23119
    prefs: {
      "extensions.zotero.httpServer.port": 23129,
      "extensions.zotero.zoteros2.mcpToken": "test-token",
    },
    mocha: { timeout: 20000 },
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
