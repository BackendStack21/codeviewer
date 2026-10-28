// The client bundle is produced by scripts/build.ts into dist/client and embedded
// into the server (and therefore into the compiled binary) as text imports.
import html from "../../dist/client/index.html" with { type: "text" };
// @ts-ignore: generated at build time
import js from "../../dist/client/app.js" with { type: "text" };
import css from "../../dist/client/app.css" with { type: "text" };
import favicon from "../../dist/client/favicon.svg" with { type: "text" };

// Fonts (OFL, see vendor/fonts/*-OFL.txt) are embedded as files in the compiled binary.
import jbmRegular from "../../vendor/fonts/JetBrainsMono-Regular.woff2" with { type: "file" };
import jbmBold from "../../vendor/fonts/JetBrainsMono-Bold.woff2" with { type: "file" };
import jbmItalic from "../../vendor/fonts/JetBrainsMono-Italic.woff2" with { type: "file" };
import jbmBoldItalic from "../../vendor/fonts/JetBrainsMono-BoldItalic.woff2" with { type: "file" };
import inter from "../../vendor/fonts/InterVariable.woff2" with { type: "file" };

export const FONTS: Record<string, string> = {
  "/fonts/JetBrainsMono-Regular.woff2": jbmRegular as unknown as string,
  "/fonts/JetBrainsMono-Bold.woff2": jbmBold as unknown as string,
  "/fonts/JetBrainsMono-Italic.woff2": jbmItalic as unknown as string,
  "/fonts/JetBrainsMono-BoldItalic.woff2": jbmBoldItalic as unknown as string,
  "/fonts/InterVariable.woff2": inter as unknown as string,
};

export interface Asset {
  type: string;
  body: string;
  gzip: Uint8Array | null;
  etag: string;
}

function asset(type: string, body: string): Asset {
  const etag = `"${Bun.hash(body).toString(36)}"`;
  return { type, body, gzip: body.length > 1024 ? Bun.gzipSync(body, { level: 9 }) : null, etag };
}

let cache: Record<string, Asset> | null = null;

export function loadAssets(): Record<string, Asset> {
  return (cache ??= {
    "/index.html": asset("text/html; charset=utf-8", html as unknown as string),
    "/app.js": asset("text/javascript; charset=utf-8", js as unknown as string),
    "/app.css": asset("text/css; charset=utf-8", css as unknown as string),
    "/favicon.svg": asset("image/svg+xml", favicon as unknown as string),
  });
}
