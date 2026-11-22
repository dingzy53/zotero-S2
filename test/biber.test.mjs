// Validates generated BibTeX against biber's BibLaTeX datamodel.
// Runs in plain Node (`npm run test:bibtex`) and skips cleanly when biber is
// not installed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function hasBiber() {
  const probe = spawnSync("biber", ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
}

describe("bibtex datamodel validation", () => {
  it("passes biber --tool --validate-datamodel with no warnings", async (t) => {
    if (!hasBiber()) {
      t.skip("biber is not installed");
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "zotero-s2-biber-"));
    try {
      const modPath = join(dir, "export.mjs");
      await build({
        stdin: {
          contents: [
            'export { bibtexFromPaper, joinBibtex } from "./src/gui/export";',
            'export { ARXIV_ONLY, ATTENTION, DEEP_LEARNING } from "./test/fixtures";',
          ].join("\n"),
          resolveDir: ROOT,
          loader: "ts",
        },
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: modPath,
      });

      const {
        bibtexFromPaper,
        joinBibtex,
        ARXIV_ONLY,
        ATTENTION,
        DEEP_LEARNING,
      } = await import(pathToFileURL(modPath).href);

      const arxivPaper = {
        ...ARXIV_ONLY,
        paperId: "arxiv-retest-1",
        externalIds: {
          ArXiv: "2604.21816",
          DOI: "10.48550/arXiv.2604.21816",
        },
      };
      const confBothPaper = {
        ...ATTENTION,
        paperId: "conf-both-1",
        publicationTypes: ["Conference"],
        externalIds: { ...ATTENTION.externalIds, DOI: "10.5555/3295222" },
      };
      const vaswaniPaper = {
        ...ATTENTION,
        externalIds: { ...ATTENTION.externalIds, DOI: "10.5555/3295222" },
      };

      const { text } = joinBibtex(
        [
          {
            id: arxivPaper.paperId,
            paper: {
              citationStyles: {
                bibtex:
                  "@Article{Beethoven2026Preprint,\n" +
                  "  author = {Ludwig van Beethoven},\n" +
                  "  booktitle = {arXiv.org},\n" +
                  "  journal = {ArXiv},\n" +
                  "  title = {A Preprint About Zotero Plugins for Agents},\n" +
                  "  volume = {abs/2604.21816},\n" +
                  "  year = {2026},\n" +
                  "}",
              },
            },
          },
          {
            id: DEEP_LEARNING.paperId,
            paper: {
              citationStyles: {
                bibtex:
                  "@Article{LeCun2015DeepL,\n" +
                  "  author = {Yann LeCun and Yoshua Bengio and Geoffrey E. Hinton},\n" +
                  "  booktitle = {Nature},\n" +
                  "  journal = {Nature},\n" +
                  "  pages = {436-444},\n" +
                  "  title = {Deep Learning},\n" +
                  "  volume = {521},\n" +
                  "  year = {2015}\n}",
              },
            },
          },
          {
            id: confBothPaper.paperId,
            paper: {
              citationStyles: {
                bibtex:
                  "@Article{Vaswani2017ConfBoth,\n" +
                  "  author = {Ashish Vaswani and Noam M. Shazeer},\n" +
                  "  booktitle = {Neural Information Processing Systems},\n" +
                  "  journal = {ArXiv},\n" +
                  "  title = {Attention is All you Need},\n" +
                  "  volume = {abs/1706.03762},\n" +
                  "  year = {2017}\n}",
              },
            },
          },
          {
            id: vaswaniPaper.paperId,
            paper: {
              citationStyles: {
                bibtex:
                  "@Article{Vaswani2017AttentionIA,\n" +
                  "  author = {Ashish Vaswani and Noam M. Shazeer},\n" +
                  "  booktitle = {Neural Information Processing Systems},\n" +
                  "  title = {Attention is All you Need},\n" +
                  "  year = {2017}\n}",
              },
            },
          },
        ],
        [arxivPaper, DEEP_LEARNING, confBothPaper, vaswaniPaper],
      );

      const built = [DEEP_LEARNING, ATTENTION, ARXIV_ONLY]
        .map((p) => bibtexFromPaper(p))
        .join("\n\n");
      const bibPath = join(dir, "generated.bib");
      await writeFile(bibPath, `${text}\n${built}\n`, "utf8");

      const res = spawnSync(
        "biber",
        [
          "--tool",
          "--validate-datamodel",
          "--nolog",
          "--output-directory",
          dir,
          bibPath,
        ],
        { encoding: "utf8" },
      );
      const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
      assert.equal(res.status, 0, output);
      assert.doesNotMatch(output, /\b(?:WARN|ERROR)\s+-/, output);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
