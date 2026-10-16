import type { S2Paper } from "../src/s2/types";

/** Shaped like real `/paper/batch` responses (fields = FULL_FIELDS). */
export const ATTENTION: S2Paper = {
  paperId: "204e3073870fae3d05bcbc2f6a8e263d9b72e776",
  corpusId: 13756489,
  externalIds: {
    DBLP: "journals/corr/VaswaniSPUJGKP17",
    MAG: "2963403868",
    ArXiv: "1706.03762",
    CorpusId: 13756489,
  },
  url: "https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263d9b72e776",
  title: "Attention is All you Need",
  abstract:
    "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
  venue: "Neural Information Processing Systems",
  publicationVenue: {
    name: "Neural Information Processing Systems",
    type: "conference",
  },
  year: 2017,
  publicationDate: "2017-06-12",
  journal: { name: "ArXiv", volume: "abs/1706.03762" },
  authors: [
    { authorId: "40348417", name: "Ashish Vaswani" },
    { authorId: "1846258", name: "Noam M. Shazeer" },
    { authorId: "3877127", name: "Niki Parmar" },
  ],
  citationCount: 150000,
  isOpenAccess: false,
  openAccessPdf: { url: "", status: null },
  publicationTypes: ["JournalArticle", "Conference"],
};

export const DEEP_LEARNING: S2Paper = {
  paperId: "a4cec122a08216fe8a3bc19b22e78fbaea096256",
  corpusId: 1779661,
  externalIds: {
    DOI: "10.1038/nature14539",
    MAG: "2919115771",
    PubMed: "26017442",
    CorpusId: 1779661,
  },
  url: "https://www.semanticscholar.org/paper/a4cec122a08216fe8a3bc19b22e78fbaea096256",
  title: "Deep Learning",
  abstract:
    "Deep learning allows computational models that are composed of multiple processing layers to learn representations of data.",
  venue: "Nature",
  publicationVenue: { name: "Nature", type: "journal" },
  year: 2015,
  publicationDate: "2015-05-27",
  journal: { name: "Nature", volume: "521", pages: " 436-444" },
  authors: [
    { authorId: "1688882", name: "Yann LeCun" },
    { authorId: "1751762", name: "Yoshua Bengio" },
    { authorId: "1695689", name: "Geoffrey E. Hinton" },
  ],
  citationCount: 70000,
  isOpenAccess: false,
  openAccessPdf: null,
  publicationTypes: ["JournalArticle", "Review"],
};

export const ARXIV_ONLY: S2Paper = {
  paperId: "0123456789abcdef0123456789abcdef01234567",
  corpusId: 999999001,
  externalIds: { ArXiv: "2401.00001", CorpusId: 999999001 },
  url: "https://www.semanticscholar.org/paper/0123456789abcdef0123456789abcdef01234567",
  title: "A Preprint About Zotero Plugins for Agents",
  abstract: null,
  venue: "arXiv.org",
  publicationVenue: { name: "arXiv.org", type: "journal" },
  year: 2024,
  publicationDate: "2024-01-01",
  journal: { name: "ArXiv", volume: "abs/2401.00001" },
  authors: [{ authorId: "1", name: "Ludwig van Beethoven" }],
  openAccessPdf: { url: "https://arxiv.org/pdf/2401.00001", status: "GREEN" },
  publicationTypes: null,
};

export const FIXTURES = [ATTENTION, DEEP_LEARNING, ARXIV_ONLY];
