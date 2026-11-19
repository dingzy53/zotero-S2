import { assert } from "chai";
import { config } from "../package.json";
import { bridgePath, installBridge } from "../src/modules/bridge";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("installs the stdio bridge via getResourceAsync", async function () {
    const tmpDir = PathUtils.join(
      PathUtils.tempDir,
      `s2-bridge-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await IOUtils.makeDirectory(tmpDir, { createAncestors: true });
    try {
      await installBridge(tmpDir);
      const written = await IOUtils.readUTF8(bridgePath(tmpDir));
      const packaged = await Zotero.File.getResourceAsync(
        `chrome://${config.addonRef}/content/bridge/zotero-s2-mcp.mjs`,
      );
      assert.isTrue(written.startsWith("#!/usr/bin/env node"));
      assert.equal(written, packaged);
    } finally {
      await IOUtils.remove(tmpDir, { recursive: true, ignoreAbsent: true });
    }
  });
});
