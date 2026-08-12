"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Makes the read saveable as a PDF, via the browser's own print-to-PDF.
 *
 * Deliberately NOT a server-side render. Headless Chrome is the high-fidelity
 * way to do this and it is not affordable here: the droplet runs four Next apps
 * in 1GB with about 570MB free, and a Chromium instance is several hundred MB
 * for as long as it renders — one concurrent request away from OOMing the apps
 * it shares the box with. Rasterising client-side (html2canvas and friends) is
 * the other common answer and is worse than it looks: it produces a flat image,
 * so nothing in the PDF is selectable, searchable or quotable, and this
 * document exists to be quoted into applications.
 *
 * Two things have to happen before the page is fit to print, and neither is
 * visible until you look at the output:
 *
 *  - Collapsed <details> print collapsed. Rows scoring 2 or 3 start closed, so
 *    a naive print silently drops the evidence behind the strongest scores —
 *    the part that makes the document credible rather than merely assertive.
 *    CSS cannot force them open portably (the mechanism moved from a hidden
 *    slot to ::details-content partway through Chrome 130-something), so the
 *    open attribute is set directly and put back afterwards.
 *
 *  - The filename comes from document.title, which is the product name for
 *    every read anyone saves. See src/lib/filename.ts.
 */
export function usePrintable(filename: string) {
  // Null when not printing. Otherwise: exactly what we changed, so the page is
  // handed back in the state the reader left it in — including any rows they
  // had opened or closed themselves.
  const undo = useRef<{ opened: HTMLDetailsElement[]; title: string } | null>(null);

  const expand = useCallback(() => {
    if (undo.current) return; // Both listeners below can fire for one print.
    const opened: HTMLDetailsElement[] = [];
    document
      .querySelectorAll<HTMLDetailsElement>("details:not([open])")
      .forEach((d) => {
        d.open = true;
        opened.push(d);
      });
    undo.current = { opened, title: document.title };
    document.title = filename;
  }, [filename]);

  const restore = useCallback(() => {
    const u = undo.current;
    if (!u) return;
    undo.current = null;
    for (const d of u.opened) d.open = false;
    document.title = u.title;
  }, []);

  useEffect(() => {
    // Registered for Ctrl+P as well as the button, because plenty of people
    // print by habit and would otherwise get a document with its evidence
    // missing and no indication anything was dropped.
    //
    // Two mechanisms because neither is universal: beforeprint/afterprint
    // covers Chrome, Firefox and Edge; Safari does not fire them but does flip
    // this media query. Both paths are idempotent, so firing twice is fine.
    const mql = window.matchMedia("print");
    const onChange = (e: MediaQueryListEvent) => (e.matches ? expand() : restore());

    window.addEventListener("beforeprint", expand);
    window.addEventListener("afterprint", restore);
    mql.addEventListener("change", onChange);
    return () => {
      window.removeEventListener("beforeprint", expand);
      window.removeEventListener("afterprint", restore);
      mql.removeEventListener("change", onChange);
      // Unmounting mid-print would otherwise strand the title and the opened
      // rows in their print state.
      restore();
    };
  }, [expand, restore]);

  return useCallback(() => {
    // Explicit rather than leaning on beforeprint: window.print() is synchronous
    // in every desktop browser, so the DOM is already expanded by the time the
    // dialog reads layout, and this path works even where the event does not.
    expand();
    window.print();
    restore();
  }, [expand, restore]);
}
