import { google } from "googleapis";
import { readFile, stat } from "fs/promises";
import { join, extname } from "path";

const ROOT = import.meta.dir;

const VARIATIONS = [
  { name: "v1-clean-minimal", port: 3001, dir: "variations/v1-clean-minimal" },
  { name: "v2-split-panel", port: 3002, dir: "variations/v2-split-panel" },
  { name: "v3-immersive-gallery", port: 3003, dir: "variations/v3-immersive-gallery" },
];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";

const MIME: Record<string, string> = {
  ".html": "text/html;charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

// ── Gemini Image Generation ──

async function generateImage(prompt: string): Promise<{ base64: string; mimeType: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts) throw new Error("No response parts from Gemini");

  for (const part of parts) {
    if (part.inlineData) {
      return {
        base64: part.inlineData.data,
        mimeType: part.inlineData.mimeType || "image/png",
      };
    }
  }

  throw new Error("No image data in Gemini response");
}

// ── Google Drive Save ──

async function saveToDrive(
  base64: string,
  filename: string,
  mimeType: string
): Promise<string> {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    return `https://drive.google.com/file/d/mock-${Date.now()}/view`;
  }

  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });

  const drive = google.drive({ version: "v3", auth });

  const buffer = Buffer.from(base64, "base64");
  const media = { mimeType, body: new Blob([buffer]).stream() };

  const fileMetadata: Record<string, unknown> = { name: filename };
  if (GOOGLE_DRIVE_FOLDER_ID) {
    fileMetadata.parents = [GOOGLE_DRIVE_FOLDER_ID];
  }

  const file = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: "id,webViewLink",
  });

  // Make publicly viewable
  await drive.permissions.create({
    fileId: file.data.id!,
    requestBody: { role: "reader", type: "anyone" },
  });

  // Re-fetch to get the webViewLink
  const updated = await drive.files.get({
    fileId: file.data.id!,
    fields: "webViewLink",
  });

  return updated.data.webViewLink || `https://drive.google.com/file/d/${file.data.id}/view`;
}

// ── Static File Serving ──

async function serveStatic(
  path: string,
  variationDir: string
): Promise<Response | null> {
  // Try variation dir first, then project root
  const candidates = [join(ROOT, variationDir, path), join(ROOT, path)];

  for (const filePath of candidates) {
    try {
      const s = await stat(filePath);
      if (!s.isFile()) continue;
      const content = await readFile(filePath);
      const ext = extname(filePath);
      const contentType = MIME[ext] || "application/octet-stream";
      return new Response(content, {
        headers: { "Content-Type": contentType, "Cache-Control": "no-cache" },
      });
    } catch {
      continue;
    }
  }

  return null;
}

// ── Request Handler ──

function makeHandler(variation: (typeof VARIATIONS)[number]) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;

    // POST /generate — Gemini image generation
    if (req.method === "POST" && pathname === "/generate") {
      try {
        const formData = await req.formData();
        const prompt = formData.get("prompt")?.toString().trim();

        if (!prompt) {
          return new Response(
            `<div class="text-error font-dm text-sm text-center py-4">Please enter a prompt to generate an image.</div>`,
            { headers: { "Content-Type": "text/html;charset=utf-8" } }
          );
        }

        if (!GEMINI_API_KEY) {
          return new Response(
            `<div class="text-error font-dm text-sm text-center py-4">GEMINI_API_KEY is not configured. Add it to your .env file.</div>`,
            { headers: { "Content-Type": "text/html;charset=utf-8" } }
          );
        }

        const { base64, mimeType } = await generateImage(prompt);
        const dataUrl = `data:${mimeType};base64,${base64}`;

        // Return HTML fragment — HTMX swaps this directly
        const html = `
          <img src="${dataUrl}" alt="Generated: ${prompt.replace(/"/g, "&quot;")}" class="generated-image animate-fade-in" />
          <input type="hidden" name="image_data" value="${base64}" />
          <input type="hidden" name="image_mime" value="${mimeType}" />
          <input type="hidden" name="image_prompt" value="${prompt.replace(/"/g, "&quot;")}" />
        `;

        return new Response(html, {
          headers: { "Content-Type": "text/html;charset=utf-8" },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return new Response(
          `<div class="text-error font-dm text-sm text-center py-4">Error: ${msg}</div>`,
          { headers: { "Content-Type": "text/html;charset=utf-8" } }
        );
      }
    }

    // POST /save — Save to Google Drive
    if (req.method === "POST" && pathname === "/save") {
      try {
        const formData = await req.formData();
        const base64 = formData.get("image_data")?.toString();
        const mimeType = formData.get("image_mime")?.toString() || "image/png";
        const prompt = formData.get("image_prompt")?.toString() || "generated";

        if (!base64) {
          return new Response(
            `<div class="text-error font-dm text-sm text-center py-2">No image to save. Generate one first.</div>`,
            { headers: { "Content-Type": "text/html;charset=utf-8" } }
          );
        }

        const filename = `${prompt.slice(0, 50).replace(/[^a-zA-Z0-9 ]/g, "")}-${Date.now()}.png`;
        const link = await saveToDrive(base64, filename, mimeType);

        const html = `
          <a href="${link}" target="_blank" rel="noopener noreferrer" class="animate-fade-in inline-flex items-center gap-2">
            <span>Saved! View in Google Drive</span>
            <svg class="w-icon-sm h-icon-sm" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>
          </a>
        `;

        return new Response(html, {
          headers: { "Content-Type": "text/html;charset=utf-8" },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return new Response(
          `<div class="text-error font-dm text-sm text-center py-2">Save failed: ${msg}</div>`,
          { headers: { "Content-Type": "text/html;charset=utf-8" } }
        );
      }
    }

    // GET / — serve index.html
    if (pathname === "/") {
      const file = await serveStatic("index.html", variation.dir);
      if (file) return file;
      return new Response("index.html not found", { status: 404 });
    }

    // Static files
    const file = await serveStatic(pathname.slice(1), variation.dir);
    if (file) return file;

    return new Response("Not found", { status: 404 });
  };
}

// ── Start Servers ──

for (const variation of VARIATIONS) {
  Bun.serve({
    port: variation.port,
    fetch: makeHandler(variation),
  });
  console.log(`✦ ${variation.name} → http://localhost:${variation.port}`);
}

console.log("\n🎨 All variations running. Open any URL above in your browser.\n");
