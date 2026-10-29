import type { S2Paper } from "../s2/types";

/** What a results view needs from the controller. Selection is shared. */
export interface ViewHost {
  doc: Document;
  selection: Set<string>;
  /** The paper the detail pane shows. */
  focused: string | null;
  /** Item key when the paper is already in the target library. */
  inLibrary(paper: S2Paper): string | null | undefined;
  /** Outcome of the last add for this paper, shown next to it. */
  outcome(paper: S2Paper): string | undefined;
  onSelectionChange(): void;
  onOpen(paper: S2Paper): void;
}

export interface ResultsView {
  render(papers: readonly S2Paper[]): void;
  /** Cheap refresh of selection, badges and outcomes without rebuilding. */
  refresh(): void;
  destroy(): void;
}
