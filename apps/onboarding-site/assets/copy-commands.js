(function () {
  "use strict";

  function fallbackCopy(text) {
    var input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();

    try {
      return document.execCommand("copy");
    } finally {
      input.remove();
    }
  }

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }

    return fallbackCopy(text)
      ? Promise.resolve()
      : Promise.reject(new Error("Clipboard copy was unavailable"));
  }

  function boot() {
    document.querySelectorAll("pre.flow").forEach(function (block) {
      var wrapper = document.createElement("div");
      wrapper.className = "copyable-command";
      block.parentNode.insertBefore(wrapper, block);
      wrapper.appendChild(block);

      var button = document.createElement("button");
      button.className = "copy-command";
      button.type = "button";
      button.textContent = "Copy";
      button.setAttribute("aria-label", "Copy command to clipboard");
      button.setAttribute("aria-live", "polite");
      wrapper.appendChild(button);

      button.addEventListener("click", function () {
        copy(block.textContent.trim()).then(
          function () {
            button.textContent = "Copied";
            button.classList.add("copied");
            window.setTimeout(function () {
              button.textContent = "Copy";
              button.classList.remove("copied");
            }, 1500);
          },
          function () {
            button.textContent = "Copy failed";
          },
        );
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
