/** Small DOM helpers shared by the popup and the options page. */

import { t } from "../shared/i18n";

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string> } = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

/** Fill every element carrying data-i18n="key" (text) or data-i18n-attr="attr:key". */
export function localize(root: ParentNode = document): void {
  for (const node of Array.from(root.querySelectorAll<HTMLElement>("[data-i18n]"))) {
    node.textContent = t(node.dataset.i18n!);
  }
  for (const node of Array.from(root.querySelectorAll<HTMLElement>("[data-i18n-attr]"))) {
    for (const pair of node.dataset.i18nAttr!.split(";")) {
      const [attr, key] = pair.split(":");
      if (attr && key) node.setAttribute(attr.trim(), t(key.trim()));
    }
  }
  document.documentElement.lang = chrome.i18n.getUILanguage().split("-")[0] || "en";
}

export function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (reply: T) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(reply);
    });
  });
}
