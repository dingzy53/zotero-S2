import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import { guiDeps } from "./gui/deps";
import {
  closeSearchWindows,
  openSearchWindow,
  searchWindows,
} from "./gui/searchWindow";
import { getEntries } from "./log/activity";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  // Reached by the test bundle, which has its own copies of every module
  public api = {
    openSearchWindow,
    closeSearchWindows,
    searchWindows,
    guiDeps,
    getActivity: getEntries,
  };

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
  }
}

export default Addon;
