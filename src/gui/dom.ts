const HTML = "http://www.w3.org/1999/xhtml";

/** Creates an HTML element in a XUL document. */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: { class?: string; text?: string; title?: string } & Record<
    string,
    string | undefined
  > = {},
  children: Array<Node | string | null | undefined | false> = [],
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML, tag) as HTMLElementTagNameMap[K];
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child) node.append(child);
  }
  return node;
}
