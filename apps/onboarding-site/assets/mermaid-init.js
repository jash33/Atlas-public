/* Atlas course — mermaid bootstrap for the local (repo) copies.
 *
 * Published artifacts render <pre class="mermaid"> natively and never load this
 * file; it exists so the same pages also work opened straight from disk.
 *
 * Include AFTER mermaid.min.js:
 *   assets/mermaid.min.js  then  assets/mermaid-init.js
 */

(function () {
  "use strict";
  if (typeof mermaid === "undefined") return;

  mermaid.initialize({
    startOnLoad: true,
    securityLevel: "strict",
    flowchart: { curve: "basis", useMaxWidth: true },
    sequence: { useMaxWidth: true, actorMargin: 40, mirrorActors: false },
    theme: "base",
    themeVariables: {
      background: "#fffef9",
      primaryColor: "#f4ece6",
      primaryTextColor: "#1a1a18",
      primaryBorderColor: "#7d2b1f",
      secondaryColor: "#eceade",
      tertiaryColor: "#fffef9",
      lineColor: "#8a877f",
      textColor: "#1a1a18",
      fontFamily: "-apple-system, 'Segoe UI', system-ui, sans-serif",
      fontSize: "13px"
    }
  });
})();
