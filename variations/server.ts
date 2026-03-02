import type { HTMLBundle } from "bun";

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || "";
const PORT = Number(process.env.PORT) || 3000;

interface AppsScriptResponse {
  success: boolean;
  error?: string;
  imageBase64?: string;
  mimeType?: string;
  driveUrl?: string;
}

async function forwardToAppsScript(
  payload: Record<string, unknown>,
): Promise<AppsScriptResponse> {
  if (!APPS_SCRIPT_URL) {
    throw new Error("APPS_SCRIPT_URL is not configured. Add it to your .env file.");
  }
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Apps Script error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<AppsScriptResponse>;
}

function htmlResponse(body: string) {
  return new Response(body, {
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

export function startServer(name: string, html: HTMLBundle) {
  Bun.serve({
    port: PORT,
    routes: {
      "/": html,
    },
    async fetch(req) {
      const url = new URL(req.url);

      // POST /generate — proxy to Apps Script → Gemini
      if (req.method === "POST" && url.pathname === "/generate") {
        try {
          const params = new URLSearchParams(await req.text());
          const prompt = params.get("prompt")?.trim();

          if (!prompt) {
            return htmlResponse(
              `<div class="text-error font-dm text-sm text-center py-4">Please enter a prompt to generate an image.</div>`,
            );
          }

          const data = await forwardToAppsScript({ action: "generate", prompt });

          if (!data.success) {
            return htmlResponse(
              `<div class="text-error font-dm text-sm text-center py-4">Error: ${data.error}</div>`,
            );
          }

          const dataUrl = `data:${data.mimeType};base64,${data.imageBase64}`;
          return htmlResponse(`
            <img src="${dataUrl}" alt="Generated: ${prompt.replace(/"/g, "&quot;")}" class="generated-image animate-fade-in" />
            <input type="hidden" name="image_data" value="${data.imageBase64}" />
            <input type="hidden" name="image_mime" value="${data.mimeType}" />
            <input type="hidden" name="image_prompt" value="${prompt.replace(/"/g, "&quot;")}" />
          `);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          return htmlResponse(
            `<div class="text-error font-dm text-sm text-center py-4">Error: ${msg}</div>`,
          );
        }
      }

      // POST /save — proxy to Apps Script → Drive
      if (req.method === "POST" && url.pathname === "/save") {
        try {
          const params = new URLSearchParams(await req.text());
          const imageBase64 = params.get("image_data");
          const mimeType = params.get("image_mime") || "image/png";
          const prompt = params.get("image_prompt") || "generated";

          // If no generated image, fall back to the provided image path
          if (!imageBase64) {
            const imagePath = params.get("image_path");
            if (imagePath) {
              const safePath = imagePath.replace(/\.\./g, "");
              const file = Bun.file(`${import.meta.dir}/${name}${safePath}`);
              if (await file.exists()) {
                const buf = await file.arrayBuffer();
                const base64 = Buffer.from(buf).toString("base64");
                const data = await forwardToAppsScript({
                  action: "save",
                  imageBase64: base64,
                  mimeType: file.type || "image/png",
                  prompt: "background image",
                });
                if (!data.success) {
                  return htmlResponse(
                    `<div class="text-error font-dm text-sm text-center py-2">Save failed: ${data.error}</div>`,
                  );
                }
                return htmlResponse(`
                  <a href="${data.driveUrl}" target="_blank" rel="noopener noreferrer" class="animate-fade-in inline-flex items-center gap-2">
                    <span>Saved! View in Google Drive</span>
                    <svg class="w-icon-sm h-icon-sm" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>
                  </a>
                `);
              }
            }
            return htmlResponse(
              `<div class="text-error font-dm text-sm text-center py-2">No image to save.</div>`,
            );
          }

          const data = await forwardToAppsScript({
            action: "save",
            imageBase64,
            mimeType,
            prompt,
          });

          if (!data.success) {
            return htmlResponse(
              `<div class="text-error font-dm text-sm text-center py-2">Save failed: ${data.error}</div>`,
            );
          }

          return htmlResponse(`
            <a href="${data.driveUrl}" target="_blank" rel="noopener noreferrer" class="animate-fade-in inline-flex items-center gap-2">
              <span>Saved! View in Google Drive</span>
              <svg class="w-icon-sm h-icon-sm" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>
            </a>
          `);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          return htmlResponse(
            `<div class="text-error font-dm text-sm text-center py-2">Save failed: ${msg}</div>`,
          );
        }
      }

      return new Response("Not found", { status: 404 });
    },
    development: true,
  });

  console.log(`✦ ${name} → http://localhost:${PORT}`);
}
