/**
 * Plain-text → HTML conversion for generated email bodies.
 *
 * Blank line separates paragraphs; a single newline becomes a `<br>`. This is the
 * only place the conversion lives: generation time (`parseSequenceFromJson`) and
 * the historical repair of stored generations both call it, so a repaired row is
 * byte-identical to what the service produces today for the same text.
 *
 * Standalone leaf module (no imports): `src/lib/chat-service-client.ts` is
 * `vi.mock`'d by many suites, so anything a non-mocked module must read lives
 * outside it (see CLAUDE.md "Gotchas").
 */
export function textToHtml(text: string): string {
  return text
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}
