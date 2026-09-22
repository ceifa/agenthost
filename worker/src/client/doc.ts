// Progressive enhancement for the markdown shell: wide tables get their own
// scroll container so they never stretch the prose column, every code block
// gets a copy button, and the raw-markdown view gets one for the whole source.

// A module, so `main` stays local to this file instead of a global shared by the
// other client scripts when they are typechecked together.
export {};

function main() {
  for (const table of document.querySelectorAll("article table")) {
    const wrapper = document.createElement("div");
    wrapper.className = "scroll";
    table.parentNode!.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }

  if (!navigator.clipboard) return;

  function copyButton(className: string, text: () => string): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = className;
    button.type = "button";
    button.textContent = "Copy";
    button.addEventListener("click", () => {
      navigator.clipboard.writeText(text()).then(() => {
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = "Copy";
        }, 1400);
      });
    });
    return button;
  }

  for (const code of document.querySelectorAll<HTMLElement>("article .codeblock>pre>code")) {
    code.parentNode!.parentNode!.appendChild(copyButton("copy", () => code.textContent ?? ""));
  }

  const source = document.getElementById("raw-src");
  const actions = document.querySelector(".doc-actions");
  if (source && actions) actions.appendChild(copyButton("act", () => source.textContent ?? ""));
}

main();
