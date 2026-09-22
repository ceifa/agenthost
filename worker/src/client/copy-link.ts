// "Copy this link" button, shared by the Share widget on hosted sites and the
// asset share page. The <script> tag carries the URL in data-url, the button's
// id in data-button and, optionally, the id of the element whose text flips to
// "Copied" in data-label (defaults to the button itself). The original label is
// read from the element, so each template controls its own wording.

// A module, so `main` stays local to this file instead of a global shared by the
// other client scripts when they are typechecked together.
export {};

function main() {
  const script = document.currentScript as HTMLScriptElement | null;
  const url = script?.dataset.url;
  const buttonId = script?.dataset.button;
  if (!url || !buttonId) return;

  const button = document.getElementById(buttonId);
  if (!button) return;
  const label = (script.dataset.label && document.getElementById(script.dataset.label)) || button;
  const idleText = label.textContent;

  const showCopied = () => {
    label.textContent = "Copied";
    setTimeout(() => {
      label.textContent = idleText;
    }, 1500);
  };
  const fallback = () => prompt("Copy this link:", url);

  button.addEventListener("click", () => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(showCopied).catch(fallback);
    } else {
      fallback();
    }
  });
}

main();
