function doPost(e) {
  var payload = JSON.parse(e.postData.contents);
  return route(payload);
}

function doGet(e) {
  // Allows testing via browser / health check
  if (!e.parameter.payload) {
    return jsonResponse({ success: true, message: "Monks Apps Script backend is running" });
  }
  var payload = JSON.parse(e.parameter.payload);
  return route(payload);
}

function route(payload) {
  var action = payload.action;
  try {
    if (action === "generate") {
      return handleGenerate(payload);
    }
    if (action === "save") {
      return handleSave(payload);
    }
    return jsonResponse({ success: false, error: "Unknown action: " + action });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message || String(err) });
  }
}

// ── Generate image via Gemini ──

function handleGenerate(payload) {
  var prompt = payload.prompt;
  if (!prompt) {
    return jsonResponse({ success: false, error: "Missing prompt" });
  }

  var apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) {
    return jsonResponse({ success: false, error: "GEMINI_API_KEY not set in Script Properties" });
  }

  var url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=" +
    apiKey;

  var body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };

  var res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    return jsonResponse({
      success: false,
      error: "Gemini API error " + res.getResponseCode() + ": " + res.getContentText(),
    });
  }

  var data = JSON.parse(res.getContentText());
  var parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) {
    return jsonResponse({ success: false, error: "No response parts from Gemini" });
  }

  for (var i = 0; i < parts.length; i++) {
    if (parts[i].inlineData) {
      return jsonResponse({
        success: true,
        imageBase64: parts[i].inlineData.data,
        mimeType: parts[i].inlineData.mimeType || "image/png",
      });
    }
  }

  return jsonResponse({ success: false, error: "No image data in Gemini response" });
}

// ── Save image to Google Drive ──

function handleSave(payload) {
  var imageBase64 = payload.imageBase64;
  var mimeType = payload.mimeType || "image/png";
  var prompt = payload.prompt || "generated";

  if (!imageBase64) {
    return jsonResponse({ success: false, error: "Missing imageBase64" });
  }

  var filename =
    prompt.substring(0, 50).replace(/[^a-zA-Z0-9 ]/g, "") + "-" + Date.now() + ".png";

  var blob = Utilities.newBlob(Utilities.base64Decode(imageBase64), mimeType, filename);
  var file = DriveApp.createFile(blob);

  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  var driveUrl = file.getUrl();

  return jsonResponse({ success: true, driveUrl: driveUrl });
}

// ── Helpers ──

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
