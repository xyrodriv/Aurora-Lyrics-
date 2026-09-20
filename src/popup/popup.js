// Aurora Lyrics — popup: lists installed extensions and opens the in-YTM Marketplace.
const list = document.getElementById("list");

chrome.storage.local.get("ytmod_registry", (r) => {
  const reg = r["ytmod_registry"] || {};
  const ids = Object.keys(reg);
  if (!ids.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No add-ons installed. Open the Aurora Lyrics Marketplace in YTM.";
    list.appendChild(e);
    return;
  }
  for (const id of ids) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("span");
    label.textContent = id;
    const tg = document.createElement("input");
    tg.type = "checkbox";
    tg.checked = !!reg[id].enabled;
    tg.addEventListener("change", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: "ytmod-setEnabled", id, on: tg.checked });
      });
    });
    row.append(label, tg);
    list.appendChild(row);
  }
});

document.getElementById("open").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: "ytmod-open" });
  });
});
