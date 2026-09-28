/* Atlas course — click a diagram to open it full screen.
 *
 * Diagrams are dense and render small inside the reading measure. This makes
 * every <figure class="dg"> openable: click, Enter/Space, or tap. Inside the
 * overlay the diagram fits the viewport by default and a second click zooms it
 * to twice the width so the container scrolls — which is what dense flowcharts
 * need on a phone.
 *
 * Works with Mermaid rendered natively (published artifacts), by
 * mermaid.min.js locally, or with static diagram images. The visual is cloned
 * at click time, so it doesn't matter when Mermaid rendering finished.
 */

(function () {
  "use strict";

  var overlay, stage, caption, opener;

  function build() {
    overlay = document.createElement("div");
    overlay.className = "lb";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Enlarged diagram");
    overlay.hidden = true;
    overlay.innerHTML =
      '<button class="lb-close" type="button" aria-label="Close">&times;</button>' +
      '<div class="lb-inner"><div class="lb-stage"></div><p class="lb-cap"></p></div>';
    document.body.appendChild(overlay);

    stage = overlay.querySelector(".lb-stage");
    caption = overlay.querySelector(".lb-cap");

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || e.target.closest(".lb-close")) close();
    });
    stage.addEventListener("click", function (e) {
      e.stopPropagation();
      stage.classList.toggle("zoomed");
    });
    document.addEventListener("keydown", function (e) {
      if (!overlay.hidden && (e.key === "Escape" || e.key === "Esc")) close();
    });
  }

  function open(fig) {
    var visual = fig.querySelector("svg, img");
    if (!visual) return; // not rendered yet — leave the page alone

    opener = fig;
    stage.classList.remove("zoomed");
    stage.innerHTML = "";

    var clone = visual.cloneNode(true);
    clone.removeAttribute("width");
    clone.removeAttribute("height");
    clone.style.maxWidth = "none";
    clone.style.width = "100%";
    clone.style.height = "auto";
    stage.appendChild(clone);

    var cap = fig.querySelector("figcaption");
    caption.innerHTML = cap ? cap.innerHTML : "";
    caption.hidden = !cap;

    overlay.hidden = false;
    document.documentElement.style.overflow = "hidden";
    overlay.querySelector(".lb-close").focus();
  }

  function close() {
    overlay.hidden = true;
    stage.innerHTML = "";
    document.documentElement.style.overflow = "";
    if (opener) {
      opener.focus();
      opener = null;
    }
  }

  function boot() {
    build();

    document.querySelectorAll("figure.dg").forEach(function (fig) {
      fig.tabIndex = 0;
      fig.setAttribute("role", "button");
      fig.setAttribute("aria-label", "Open this diagram full screen");

      if (!fig.querySelector(".dg-hint")) {
        var hint = document.createElement("span");
        hint.className = "dg-hint";
        hint.textContent = "Click to view full screen";
        fig.insertBefore(hint, fig.firstChild);
      }

      fig.addEventListener("click", function (e) {
        if (e.target.closest("a")) return;
        open(fig);
      });
      fig.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(fig);
        }
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
