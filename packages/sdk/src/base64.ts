/** Browser-safe UTF-8 <-> base64 helpers, tolerant of tty-polluted input. */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** UTF-8 string -> base64 (chunked to stay under argument limits). */
export function toBase64(s: string): string {
  const bytes = encoder.encode(s);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64 (possibly wrapped/CR-polluted tty output) -> UTF-8 string. */
export function fromBase64(b64: string): string {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  if (!clean) return "";
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return decoder.decode(bytes);
}

/** Single-quote a string for POSIX sh. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
