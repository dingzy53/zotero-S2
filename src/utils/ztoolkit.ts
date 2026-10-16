import { BasicTool, unregister } from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export { createZToolkit };

class Toolkit extends BasicTool {
  unregisterAll() {
    unregister(this);
  }
}

function createZToolkit() {
  const toolkit = new Toolkit();
  toolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  toolkit.basicOptions.log.disableConsole = __env__ === "production";
  toolkit.basicOptions.api.pluginID = config.addonID;
  return toolkit;
}
