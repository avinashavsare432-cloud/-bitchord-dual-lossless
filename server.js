import express from "express";
import path from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createBitChordAuth } from "./bitchord-addon-auth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
const hosts = (process.env.BITCHORD_HOSTS || "")
  .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
if (!hosts.length) console.warn("WARNING: BITCHORD_HOSTS is empty; using localhost for local development. Set the deployed hostname before enforcement.");
const auth = createBitChordAuth({ hosts: hosts.length ? hosts : ["localhost"] });
const authMode = (process.env.BITCHORD_AUTH_MODE || "log").toLowerCase();
const musicDir = path.resolve(process.env.MUSIC_DIR || path.join(__dirname, "music"));
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const mediaSecret = process.env.MEDIA_SECRET || "";
const AUDIO_EXT = new Set([".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav", ".aac"]);
const mime = {
  ".flac": "audio/flac", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
  ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav", ".aac": "audio/aac"
};
const codecFor = ext => ext === ".m4a" ? "alac/aac" : ext.replace(".", "");
const qualityFor = ext => ext === ".flac" || ext === ".wav" ? "LOSSLESS" : "HIGH";

async function protect(req, res, next) {
  // The audio player fetches signed media without BitChord auth headers.
  if (req.path.startsWith("/media/")) return next();
  const result = await auth.verifyRequest(req);
  if (result.ok) {
    req.bitchord = result.claims;
    return next();
  }
  console.warn("BitChord auth:", result.error);
  if (authMode === "enforce") {
    const rejected = auth.rejection(result);
    return res.status(rejected.status).set(rejected.headers).send(rejected.body);
  }
  return next(); // temporary rollout mode; switch to enforce after verification.
}

// Public manifest must remain outside auth middleware.
app.get("/manifest.json", (_req, res) => res.json(manifest));
app.get("/health", (_req, res) => res.json({ ok: true, service: manifest.id }));
app.use(protect);

function cleanText(v, max = 180) {
  return String(v ?? "").trim().slice(0, max);
}
function localFiles() {
  if (!fs.existsSync(musicDir)) return [];
  const found = [];
  const walk = dir => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && AUDIO_EXT.has(path.extname(ent.name).toLowerCase())) found.push(full);
    }
  };
  walk(musicDir);
  return found;
}
function localId(full) {
  return path.relative(musicDir, full).split(path.sep).join("/");
}
function localPath(id) {
  const full = path.resolve(musicDir, id);
  if (full !== musicDir && !full.startsWith(musicDir + path.sep)) return null;
  return full;
}
function localTrack(full) {
  const ext = path.extname(full).toLowerCase();
  const filename = path.basename(full, ext);
  const bits = filename.split(" - ");
  return {
    id: `local:${localId(full)}`,
    title: bits.length > 1 ? bits.slice(1).join(" - ") : filename,
    artist: bits.length > 1 ? bits[0] : "Local library",
    album: "Local files",
    format: ext.slice(1),
    audioQuality: qualityFor(ext)
  };
}

async function searchInternetArchive(query, limit) {
  const params = new URLSearchParams({
    q: `mediatype:audio AND (${query.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, " ")})`,
    fl: "identifier,title,creator,year,format",
    rows: String(limit),
    page: "1",
    output: "json"
  });
  const response = await fetch(`https://archive.org/advancedsearch.php?${params}`, {
    headers: { "User-Agent": "AvinashDualLossless/1.0" }
  });
  if (!response.ok) throw new Error(`Internet Archive search returned ${response.status}`);
  const data = await response.json();
  return (data.response?.docs || []).map(doc => {
    const formats = Array.isArray(doc.format) ? doc.format : [doc.format || ""];
    const hasFlac = formats.some(f => /flac/i.test(String(f)));
    return {
      id: `ia:${doc.identifier}`,
      title: cleanText(doc.title || doc.identifier),
      artist: cleanText(Array.isArray(doc.creator) ? doc.creator.join(", ") : doc.creator || "Unknown artist"),
      album: "",
      year: doc.year || "",
      format: hasFlac ? "flac" : "audio",
      audioQuality: hasFlac ? "LOSSLESS" : "HIGH"
    };
  });
}

async function getIAFiles(identifier) {
  const response = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, {
    headers: { "User-Agent": "AvinashDualLossless/1.0" }
  });
  if (!response.ok) throw new Error(`Internet Archive metadata returned ${response.status}`);
  const data = await response.json();
  return (data.files || []).filter(f => /\.(flac|mp3|m4a|ogg|opus|wav|aac)$/i.test(f.name || "") && !f.private)
    .sort((a, b) => {
      const rank = f => /\.flac$/i.test(f.name) ? 0 : /\.wav$/i.test(f.name) ? 1 : 2;
      return rank(a) - rank(b);
    });
}
function absoluteUrl(req, pathname) {
  const origin = publicBaseUrl || `${req.protocol}://${req.get("host")}`;
  return `${origin}${pathname}`;
}
function signMedia(id, exp) {
  if (!mediaSecret) throw new Error("MEDIA_SECRET is not configured");
  return createHmac("sha256", mediaSecret).update(`${id}.${exp}`).digest("base64url");
}
function mediaAllowed(id, exp, sig) {
  if (!mediaSecret || !/^\d+$/.test(String(exp)) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(signMedia(id, exp));
  const actual = Buffer.from(String(sig || ""));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function signedMediaUrl(req, id) {
  const exp = Math.floor(Date.now() / 1000) + 1800;
  const sig = signMedia(id, exp);
  return absoluteUrl(req, `/media/${encodeURIComponent(id)}?exp=${exp}&sig=${sig}`);
}

app.get("/search", async (req, res) => {
  const q = cleanText(req.query.q, 180);
  if (!q) return res.status(400).json({ tracks: [] });
  try {
    const [localResult, archiveResult] = await Promise.allSettled([
      Promise.resolve(localFiles().map(localTrack).filter(t =>
        `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q.toLowerCase())
      ).slice(0, 30)),
      searchInternetArchive(q, 30)
    ]);
    const tracks = [
      ...(localResult.status === "fulfilled" ? localResult.value : []),
      ...(archiveResult.status === "fulfilled" ? archiveResult.value : [])
    ];
    res.json({ tracks });
  } catch (error) {
    res.status(502).json({ tracks: [], error: "search_failed", message: error.message });
  }
});

// BitChord calls /stream/{id}; the ID is the same opaque ID returned by /search.
app.get("/stream/:id", async (req, res) => {
  const id = cleanText(req.params.id, 700);
  try {
    if (id.startsWith("local:")) {
      const relative = id.slice(6);
      const file = localPath(relative);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.sendStatus(404);
      const ext = path.extname(file).toLowerCase();
      return res.json({
        url: signedMediaUrl(req, `local:${relative}`),
        format: ext.slice(1), codec: codecFor(ext), container: ext.slice(1),
        manifest: "none", encrypted: false
      });
    }
    if (id.startsWith("ia:")) {
      const identifier = id.slice(3);
      const files = await getIAFiles(identifier);
      if (!files.length) return res.sendStatus(404);
      const selected = files[0];
      const ext = path.extname(selected.name).toLowerCase();
      const mediaId = `ia:${identifier}:${selected.name}`;
      return res.json({
        url: signedMediaUrl(req, mediaId),
        format: ext.slice(1), codec: codecFor(ext), container: ext.slice(1),
        manifest: "none", encrypted: false,
        ...(selected.length ? { bitrate: undefined } : {})
      });
    }
    return res.sendStatus(404);
  } catch (error) {
    res.status(502).json({ error: "stream_failed", message: error.message });
  }
});

// Media route is intentionally public to the BitChord auth middleware: playback
// does not send X-BitChord headers. Its HMAC URL is valid for 30 minutes.
app.get("/media/:id", async (req, res) => {
  const id = req.params.id;
  if (!mediaAllowed(id, req.query.exp, req.query.sig)) return res.sendStatus(403);
  try {
    if (id.startsWith("local:")) {
      const file = localPath(id.slice(6));
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.sendStatus(404);
      const stat = fs.statSync(file);
      const ext = path.extname(file).toLowerCase();
      res.setHeader("Content-Type", mime[ext] || "application/octet-stream");
      res.setHeader("Accept-Ranges", "bytes");
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m) return res.sendStatus(416);
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
        if (start > end || start >= stat.size) return res.sendStatus(416);
        res.status(206).set({
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Content-Length": String(end - start + 1)
        });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.setHeader("Content-Length", stat.size);
      return fs.createReadStream(file).pipe(res);
    }
    if (id.startsWith("ia:")) {
      const [, identifier, ...nameParts] = id.split(":");
      const filename = nameParts.join(":");
      const files = await getIAFiles(identifier);
      if (!files.some(f => f.name === filename)) return res.sendStatus(404);
      const encodedName = filename.split("/").map(encodeURIComponent).join("/");
      const remote = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodedName}`;
      const headers = {};
      if (req.headers.range) headers.Range = req.headers.range;
      const upstream = await fetch(remote, { headers });
      if (!upstream.ok && upstream.status !== 206) return res.status(502).json({ error: "upstream_media_failed" });
      res.status(upstream.status);
      res.setHeader("Content-Type", mime[path.extname(filename).toLowerCase()] || "application/octet-stream");
      for (const h of ["content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers.get(h);
        if (value) res.setHeader(h, value);
      }
      if (!upstream.body) return res.end();
      return await pipeline(Readable.fromWeb(upstream.body), res);
    }
    return res.sendStatus(404);
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ error: "media_proxy_failed", message: error.message });
    else res.destroy(error);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: "internal_error" });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Avinash Dual Lossless listening on ${port}; auth mode=${authMode}`));
