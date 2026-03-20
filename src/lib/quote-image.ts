import sharp from "sharp";

interface QuoteImageOptions {
  name: string;
  age: number;
  theme: string;
  text: string;
}

const WIDTH = 1080;
const HEIGHT = 768;

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Wrap text into lines that fit within a given character width */
function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length + word.length + 1 > maxCharsPerLine) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Generate a 1080x768 PNG image with the quote text, name, age, and theme.
 * Dark background, white text, clean typography via SVG → sharp.
 */
export async function generateQuoteImage(opts: QuoteImageOptions): Promise<Buffer> {
  const { name, age, theme, text } = opts;

  const lines = wrapText(text, 38);
  const lineHeight = 46;
  const textBlockHeight = lines.length * lineHeight;
  const textStartY = Math.max(200, (HEIGHT - textBlockHeight) / 2);

  const quoteTspans = lines
    .map((line, i) => `<tspan x="540" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
    .join("\n      ");

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#1a1a2e"/>

  <!-- Theme label -->
  <text x="540" y="80" text-anchor="middle"
        font-family="sans-serif" font-size="22" font-weight="600"
        fill="#8b8ba3" letter-spacing="3">
    ${escapeXml(theme.toUpperCase())}
  </text>

  <!-- Divider -->
  <line x1="440" y1="110" x2="640" y2="110" stroke="#8b8ba3" stroke-width="1"/>

  <!-- Name + Age -->
  <text x="540" y="150" text-anchor="middle"
        font-family="sans-serif" font-size="28" font-weight="700" fill="#ffffff">
    ${escapeXml(name)}, ${age}
  </text>

  <!-- Quote text -->
  <text x="540" y="${textStartY}" text-anchor="middle"
        font-family="serif" font-size="36" font-style="italic" fill="#e0e0e0"
        line-height="${lineHeight}">
      ${quoteTspans}
  </text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
