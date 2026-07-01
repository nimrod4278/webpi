import { createChat, type Chat } from "wepi";
import { C2wSandbox } from "./c2w-sandbox.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const keyEl = $<HTMLInputElement>("key");
const msgEl = $<HTMLInputElement>("msg");
const sendEl = $<HTMLButtonElement>("send");
const logEl = $<HTMLDivElement>("log");
const filesEl = $<HTMLSpanElement>("files");
const sbEl = $<HTMLParagraphElement>("sandbox-status");

let chat: Chat | undefined;
let sandboxReady = false;

// Start booting the bash sandbox immediately on page load — it has no dependency on the
// API key, so overlapping its ~33MB download + VM boot with the user reading the page /
// pasting a key means it's usually ready before the first command.
const sandbox = new C2wSandbox({
  onLog: (l) => {
    if (!sandboxReady) sbEl.textContent = "sandbox: " + l;
    console.debug("[sandbox]", l);
  },
});

// Once the shell answers, the kernel/JIT are still cold: the first fork+exec of busybox is
// expensive under full-system emulation. Pay that cost here, in the idle window before the
// user types, so their first real command runs on a warm VM. exec() serializes internally,
// so a user command sent mid-warm-up simply queues behind it.
sandbox.ready
  .then(async () => {
    sbEl.textContent = "sandbox: warming up… (first command primes the VM)";
    try {
      await sandbox.exec("uname -a");
    } catch {
      /* warm-up is best-effort; never block chat on it */
    }
    sandboxReady = true;
    sbEl.textContent = "sandbox: ready";
  })
  .catch((e) => {
    sbEl.textContent = "sandbox: boot failed — " + e;
  });

async function boot() {
  const apiKey = keyEl.value.trim();
  if (!apiKey || chat) return;
  keyEl.disabled = true;

  chat = await createChat({
    apiKey,
    files: { "README.md": "# my project\n" },
    sandbox,
  });
  logEl.textContent = "Ready. Ask pi to create/edit files or run shell commands.\n";
  msgEl.disabled = false;
  sendEl.disabled = false;
  msgEl.focus();
  renderFiles();
}

function renderFiles() {
  const names = Object.keys(chat?.files() ?? {});
  filesEl.textContent = names.length ? names.join(", ") : "(empty)";
}

function append(s: string) {
  logEl.textContent += s;
  logEl.scrollTop = logEl.scrollHeight;
}

function preview(value: unknown, max = 2000): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value && typeof value === "object" && "command" in value) {
    // bash tool args
    text = String((value as { command: unknown }).command);
  } else if (value && typeof value === "object" && Array.isArray((value as any).content)) {
    // AgentTool result: { content: [{ type: "text", text }], ... }
    text = (value as { content: { type?: string; text?: string }[] }).content
      .map((c) => c?.text ?? "")
      .join("");
  } else {
    text = JSON.stringify(value);
  }
  text = (text ?? "").trimEnd();
  return text.length > max ? text.slice(0, max) + "\n…(truncated)" : text;
}

let busy = false;

async function send() {
  if (!chat || busy) return; // one turn at a time; the agent rejects concurrent prompts
  const text = msgEl.value.trim();
  if (!text) return;
  busy = true;
  msgEl.value = "";
  msgEl.disabled = true;
  sendEl.disabled = true;
  append(`\n> ${text}\n`);
  try {
    const turn = chat.send(text, {
      onTool: (e) => {
        if (e.type === "start") {
          append(`\n[${e.toolName}] ${preview(e.args)}\n`);
          if (e.toolName === "bash" && !sandboxReady)
            append("  (sandbox still booting/warming up — this may take a moment…)\n");
        } else {
          const out = preview(e.result);
          append(`${e.isError ? "  [tool error] " : ""}${out ? out + "\n" : "(no output)\n"}`);
        }
      },
    });
    for await (const delta of turn) {
      append(delta);
    }
  } catch (e) {
    append(`\n[error] ${e}\n`);
  } finally {
    busy = false;
    msgEl.disabled = false;
    sendEl.disabled = false;
    renderFiles();
    msgEl.focus();
  }
}

keyEl.addEventListener("change", boot);
sendEl.addEventListener("click", send);
msgEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") send();
});
