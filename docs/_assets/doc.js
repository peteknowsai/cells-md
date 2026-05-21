/* Cells doc copy buttons.
 *
 * Drop-in companion to doc.css — add
 *   <script src="_assets/doc.js" defer></script>
 * (adjust the relative path for subdirectories) and every <pre> block gets a
 * one-click "Copy" control. Self-contained: injects its own styles, reusing
 * doc.css's CSS variables so the button matches the doc theme. */
(function () {
  "use strict";

  var css = [
    ".doc-copy-wrap { position: relative; }",
    ".doc-copy-btn {",
    "  position: absolute; top: 8px; right: 8px;",
    "  font-family: var(--mono, monospace); font-size: 10.5px;",
    "  text-transform: uppercase; letter-spacing: 0.07em; line-height: 1.4;",
    "  padding: 3px 9px; border-radius: 4px;",
    "  border: 1px solid var(--rule, #ddd);",
    "  background: var(--paper, #fff); color: var(--muted, #777);",
    "  cursor: pointer;",
    "  transition: color 0.12s ease, border-color 0.12s ease;",
    "}",
    ".doc-copy-btn:hover { color: var(--accent, #6e8b3a); border-color: var(--accent, #6e8b3a); }",
    ".doc-copy-btn.copied { color: var(--accent, #6e8b3a); border-color: var(--accent, #6e8b3a); }",
  ].join("\n");

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for browsers/contexts without the async Clipboard API.
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error("copy failed"));
    });
  }

  function attach(pre) {
    var wrap = document.createElement("div");
    wrap.className = "doc-copy-wrap";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "doc-copy-btn";
    btn.textContent = "Copy";
    wrap.appendChild(btn);

    btn.addEventListener("click", function () {
      copy(pre.innerText.replace(/\s+$/, "")).then(
        function () {
          btn.textContent = "Copied";
          btn.classList.add("copied");
        },
        function () {
          btn.textContent = "Copy failed";
        }
      );
      setTimeout(function () {
        btn.textContent = "Copy";
        btn.classList.remove("copied");
      }, 1600);
    });
  }

  // `defer` guarantees the DOM is parsed before this runs.
  var pres = document.querySelectorAll("pre");
  for (var i = 0; i < pres.length; i++) attach(pres[i]);
})();
