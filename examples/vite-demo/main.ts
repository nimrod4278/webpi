import { createChat, type Chat } from "wepi";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const keyEl = $<HTMLInputElement>("key");
const msgEl = $<HTMLInputElement>("msg");
const sendEl = $<HTMLButtonElement>("send");
const logEl = $<HTMLDivElement>("log");
const filesEl = $<HTMLSpanElement>("files");

let chat: Chat | undefined;

async function boot() {
  const apiKey = keyEl.value.trim();
  if (!apiKey || chat) return;
  keyEl.disabled = true;
  chat = await createChat({
    apiKey,
    files: { "README.md": "# my project\n" },
  });
  logEl.textContent = "Ready. Ask pi to create or edit files.\n";
  msgEl.disabled = false;
  sendEl.disabled = false;
  msgEl.focus();
  renderFiles();
}

function renderFiles() {
  const names = Object.keys(chat?.files() ?? {});
  filesEl.textContent = names.length ? names.join(", ") : "(empty)";
}

async function send() {
  if (!chat) return;
  const text = msgEl.value.trim();
  if (!text) return;
  msgEl.value = "";
  sendEl.disabled = true;
  logEl.textContent += `\n> ${text}\n`;
  try {
    for await (const delta of chat.send(text)) {
      logEl.textContent += delta;
      logEl.scrollTop = logEl.scrollHeight;
    }
  } catch (e) {
    logEl.textContent += `\n[error] ${e}\n`;
  } finally {
    sendEl.disabled = false;
    renderFiles();
  }
}

keyEl.addEventListener("change", boot);
sendEl.addEventListener("click", send);
msgEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") send();
});
