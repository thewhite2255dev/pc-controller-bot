import "dotenv/config";
import {
  Bot,
  InlineKeyboard,
  InputFile,
  Context,
  CallbackQueryContext,
} from "grammy";
import { execFile } from "child_process";
import os from "os";
import fs from "fs";
import path from "path";
import ffmpegStatic from "ffmpeg-static";
import {
  writeTextToClipboard,
  readTextFromClipboard,
  writeImageToClipboard,
  writeFilesToClipboard,
  getIsWriting,
} from "./clipboard.js";
const ffmpegPath: string = ffmpegStatic as unknown as string;

// ==========================================
// ⚙️ CONFIGURATION & AUTO-DÉTECTION MATÉRIEL
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MON_ID = Number(process.env.MON_ID);
let WEBCAM_NAME: string | null = process.env.WEBCAM_NAME || null;
let AUDIO_NAME: string | null = process.env.AUDIO_NAME || null;
let LOOPBACK_NAME: string | null = process.env.LOOPBACK_NAME || null; // Stereo Mix / system audio loopback

if (!BOT_TOKEN || !MON_ID) {
  console.error(
    "❌ Erreur : BOT_TOKEN ou MON_ID manquant dans le fichier .env",
  );
  process.exit(1);
}

// 🥷 Exécute n'importe quelle commande Windows sans fenêtre noire cmd
function runSilent(
  exe: string,
  args: string[] = [],
  callback: (error: Error | null, stdout: string, stderr: string) => void,
): void {
  execFile(exe, args, { windowsHide: true }, callback);
}

// 📸 Capture d'écran via PowerShell (plus fiable que screenshot-desktop sur Windows)
function captureScreenshot(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tempPath = path.join(os.tmpdir(), `screenshot_${Date.now()}.png`);
    const psScript = `
      $ProgressPreference = 'SilentlyContinue'
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
      $bitmap.Save('${tempPath.replace(/\\/g, "\\\\")}')
      $graphics.Dispose()
      $bitmap.Dispose()
      Write-Output "OK"
    `;

    const encoded = Buffer.from(psScript, "utf16le").toString("base64");
    runSilent(
      "powershell",
      ["-NoProfile", "-EncodedCommand", encoded],
      async (err, _stdout, stderr) => {
        if (err) {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          return reject(err);
        }
        // Ignorer les messages de progression PowerShell (CLIXML)
        if (
          stderr &&
          stderr.trim() &&
          !stderr.includes("OK") &&
          !stderr.includes("ProgressRecord")
        ) {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          return reject(new Error(stderr));
        }
        try {
          const imgBuffer = fs.readFileSync(tempPath);
          fs.unlinkSync(tempPath);
          resolve(imgBuffer);
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

// 🔍 Détecte automatiquement la webcam et le micro via FFmpeg DirectShow
// Priorité : 1) .env (si défini ET valide)  2) auto-détection FFmpeg
function detectMediaDevices(): Promise<void> {
  return new Promise((resolve) => {
    console.log(
      `🔍 .env — WEBCAM_NAME : ${WEBCAM_NAME ? `"${WEBCAM_NAME}"` : "(non défini → auto)"}`,
    );
    console.log(
      `🔍 .env — AUDIO_NAME  : ${AUDIO_NAME ? `"${AUDIO_NAME}"` : "(non défini → auto)"}`,
    );

    // Si les DEUX sont déjà définis dans le .env, pas besoin de détecter
    if (WEBCAM_NAME && AUDIO_NAME) {
      console.log(
        "✅ Webcam + micro définis manuellement dans .env — détection skippée",
      );
      return resolve();
    }

    // Vérifie que ffmpeg-static a bien installé son binaire
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      console.error(`❌ ffmpeg-static introuvable (path: ${ffmpegPath})`);
      console.error("   → Lance : pnpm rebuild ffmpeg-static");
      return resolve();
    }

    console.log(`🔍 Détection FFmpeg (${ffmpegPath})...`);

    execFile(
      ffmpegPath,
      ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
      { windowsHide: true },
      (_err: Error | null, _stdout: string, stderr: string) => {
        const output = stderr || "";

        // Extrait tous les devices vidéo et audio trouvés
        const videoDevices = [
          ...output.matchAll(/"([^"]+)"\s*\(video\)/gi),
        ].map((m) => m[1]);
        const audioDevices = [
          ...output.matchAll(/"([^"]+)"\s*\(audio\)/gi),
        ].map((m) => m[1]);

        console.log(
          `📷 Vidéo trouvée(s) : ${
            videoDevices.length
              ? videoDevices.map((d) => `"${d}"`).join(", ")
              : "aucune"
          }`,
        );
        console.log(
          `🎙️ Audio trouvée(s) : ${
            audioDevices.length
              ? audioDevices.map((d) => `"${d}"`).join(", ")
              : "aucune"
          }`,
        );

        // Détecte le device de loopback (Stereo Mix / "Ce que vous entendez") pour le son système
        const loopbackKeywords = [
          "stereo mix",
          "ce que vous entendez",
          "what u hear",
          "wave out mix",
          "system audio",
          "loopback",
        ];
        const detectedLoopback = audioDevices.find((d) =>
          loopbackKeywords.some((k) => d.toLowerCase().includes(k)),
        );

        // Vérifie que la valeur du .env existe réellement dans la liste
        if (WEBCAM_NAME && !videoDevices.includes(WEBCAM_NAME)) {
          console.warn(
            `⚠️ WEBCAM_NAME="${WEBCAM_NAME}" introuvable dans la liste — auto-détection...`,
          );
          WEBCAM_NAME = videoDevices[0] || null;
        } else if (!WEBCAM_NAME) {
          WEBCAM_NAME = videoDevices[0] || null;
        }

        if (AUDIO_NAME && !audioDevices.includes(AUDIO_NAME)) {
          console.warn(
            `⚠️ AUDIO_NAME="${AUDIO_NAME}" introuvable dans la liste — auto-détection...`,
          );
          AUDIO_NAME = audioDevices[0] || null;
        } else if (!AUDIO_NAME) {
          AUDIO_NAME = audioDevices[0] || null;
        }

        if (LOOPBACK_NAME && !audioDevices.includes(LOOPBACK_NAME)) {
          console.warn(
            `⚠️ LOOPBACK_NAME="${LOOPBACK_NAME}" introuvable — auto-détection...`,
          );
          LOOPBACK_NAME = detectedLoopback || null;
        } else if (!LOOPBACK_NAME) {
          LOOPBACK_NAME = detectedLoopback || null;
        }

        console.log(
          `📷 Webcam finale : ${WEBCAM_NAME ? `"${WEBCAM_NAME}"` : "❌ Aucune"}`,
        );
        console.log(
          `🎙️ Micro final    : ${AUDIO_NAME ? `"${AUDIO_NAME}"` : "❌ Aucun"}`,
        );
        console.log(
          `🔊 Loopback (son système) : ${LOOPBACK_NAME ? `"${LOOPBACK_NAME}"` : "❌ Non détecté (activer 'Stéréo Mix' dans Windows)"}`,
        );
        resolve();
      },
    );
  });
}

// 🔍 Détecte dynamiquement tous les disques actifs de A:\ à Z:\
function getAvailableDrives(): string[] {
  const drives: string[] = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try {
      if (fs.existsSync(root)) {
        fs.accessSync(root, fs.constants.R_OK);
        drives.push(letter);
      }
    } catch {
      // Ignore les lecteurs vides ou verrouillés
    }
  }
  return drives;
}

// 📂 Résout les chemins réels des 6 dossiers principaux Windows (y compris OneDrive)
const QUICK_FOLDERS: Record<string, string> = {
  desktop: path.join(os.homedir(), "Desktop"),
  downloads: path.join(os.homedir(), "Downloads"),
  documents: path.join(os.homedir(), "Documents"),
  pictures: path.join(os.homedir(), "Pictures"),
  music: path.join(os.homedir(), "Music"),
  videos: path.join(os.homedir(), "Videos"),
};

for (const [key, folderName] of [
  ["desktop", "Desktop"],
  ["documents", "Documents"],
  ["pictures", "Pictures"],
]) {
  const oneDrivePath = path.join(os.homedir(), "OneDrive", folderName);
  if (fs.existsSync(oneDrivePath)) QUICK_FOLDERS[key] = oneDrivePath;
}

const bot = new Bot(BOT_TOKEN);

// 🔒 SÉCURITÉ : Bloque absolument tout le monde sauf toi
bot.use(async (ctx: Context, next: () => Promise<void>) => {
  if (ctx.from?.id !== MON_ID) return;
  await next();
});

// 🧠 État d'attente global (durée, volume, luminosité, frappe clavier)
let pendingAction: string | null = null;

// 🛡️ État du watcher de déverrouillage session
let unlockGuardActive = false;
let unlockWatcherProcess: ReturnType<typeof execFile> | null = null;

// 🚀 Cache des processus (pour kill par index)
interface ProcessInfo {
  name: string;
  pid: number;
  ram: number;
}
let topProcesses: ProcessInfo[] = [];

// 📋 MENU PRINCIPAL PARTAGÉ — Catégories UX
function getMainMenu(): InlineKeyboard {
  return (
    new InlineKeyboard()
      // Système & Sécurité
      .text("📊 Système", "menu_system")
      .text("🛡️ Sécurité", "security_menu")
      .row()
      // Audio & Média
      .text("🔊 Audio / Média", "menu_audio")
      .row()
      // Affichage & Énergie
      .text("🖥️ Affichage / Énergie", "menu_display")
      .row()
      // Caméra & Écran
      .text("📸 Caméra / Écran", "menu_camera")
      .row()
      // Alimentation
      .text("⚡ Alimentation", "menu_power")
      .row()
      // Apps & Ressources
      .text("🚀 Apps / Ressources", "menu_apps")
      .row()
      // 🌐 Réseau (nouveau top-level)
      .text("🌐 Réseau", "menu_network")
      .row()
      // 📋 Presse-papier (nouveau top-level)
      .text("📋 Presse-papier", "menu_clipboard")
      .row()
      // ⌨️ Raccourcis & Fenêtres (nouveau top-level)
      .text("⌨️ Raccourcis & Fenêtres", "menu_shortcuts")
      .row()
      // Entrée / Clavier (saisie texte seulement)
      .text("⌨️ Entrée / Clavier", "menu_input")
      .row()
      // Explorateur
      .text("🗂️ Explorateur", "menu_explorer")
      .row()
      // Actions rapides
      .text("📂 Dossier Bot", "open_folder")
      .text("🔄 Redémarrer le bot", "restart_bot")
  );
}

// ==========================================
// 📋 SOUS-MENUS BUILDERS
// ==========================================

function buildSystemMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📊 Infos PC", "stats")
    .row()
    .text("🛡️ Sécurité / Anti-intrusion", "security_menu")
    .row()
    .text("🔙 Retour", "back_to_main");
}

function buildAudioMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔇 Son PC", "mute")
    .text("🎙️ Micro PC", "mic_mute")
    .row()
    .text("⏮️ Précédent", "media_prev")
    .text("⏯️ Play / Pause", "playpause")
    .text("⏭️ Suivant", "media_next")
    .row()
    .text("⏹️ Stop", "media_stop")
    .row()
    .text("🔈 Vol -", "vol_down")
    .text("🔊 Vol +", "vol_up")
    .row()
    .text("🔈 10%", "set_vol_10")
    .text("🔉 30%", "set_vol_30")
    .text("🔉 60%", "set_vol_60")
    .text("🔊 100%", "set_vol_100")
    .row()
    .text("🔙 Retour", "back_to_main");
}

function buildDisplayMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("☀️ Luminosité", "brightness_menu")
    .text("🌿 Éco Énergie", "saver_menu")
    .row()
    .text("💡 Allumer Écran", "screen_on")
    .text("🖥️ Éteindre Écran", "screen_off")
    .row()
    .text("🔙 Retour", "back_to_main");
}

function buildCameraMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📸 Screenshot", "screen")
    .text("🎥 Record Écran", "record_screen")
    .row()
    .text("📷 Photo Cam", "webcam_photo")
    .text("📹 Vidéo Cam", "webcam_video")
    .row()
    .text("🔙 Retour", "back_to_main");
}

function buildPowerMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔒 Verrouiller", "lock")
    .text("💤 Veille", "sleep")
    .row()
    .text("🛑 Éteindre PC", "shutdown")
    .text("❌ Annuler arrêt", "abort")
    .row()
    .text("🔋 Modes d'alimentation", "power_plans_menu")
    .row()
    .text("🔙 Retour", "back_to_main");
}

// --- Détection dynamique des plans d'alimentation ---
interface PowerPlan {
  guid: string;
  name: string;
  isActive: boolean;
}

async function detectPowerPlans(): Promise<PowerPlan[]> {
  return new Promise((resolve) => {
    runSilent("powercfg", ["/list"], (_err, stdout) => {
      const output = stdout || "";
      const plans: PowerPlan[] = [];

      // powercfg /list output format (Windows FR):
      // Plans d'alimentation existants (* Actif)
      // ------------------------------------
      // GUID du plan : xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  (Nom du plan) *
      // GUID du plan : xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  (Nom du plan)

      const lines = output.split("\n");
      const guidRegex =
        /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s+\(([^)]+)\)\s*(\*)?/;

      for (const line of lines) {
        const match = line.match(guidRegex);
        if (match) {
          const [, guid, name, active] = match;
          plans.push({
            guid: guid.toLowerCase(),
            name: name.trim(),
            isActive: active === "*",
          });
        }
      }

      if (plans.length === 0) {
        // Fallback: tenter en anglais si la locale FR n'a pas matché
        const fallbackRegex =
          /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s+\(([^)]+)\)\s*(\*)?/;
        for (const line of lines) {
          const match = line.match(fallbackRegex);
          if (match) {
            const [, guid, name, active] = match;
            plans.push({
              guid: guid.toLowerCase(),
              name: name.trim(),
              isActive: active === "*",
            });
          }
        }
      }

      resolve(plans);
    });
  });
}

function buildPowerPlansMenu(plans: PowerPlan[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const plan of plans) {
    const activeMark = plan.isActive ? " ✅" : "";
    // Tronque le nom si trop long pour le bouton
    const displayName =
      plan.name.length > 30 ? plan.name.slice(0, 27) + "..." : plan.name;
    kb.text(`${displayName}${activeMark}`, `power_set_${plan.guid}`).row();
  }

  kb.text("🔄 Rafraîchir", "power_plans_menu").text(
    "🔙 Retour",
    "back_to:menu_display",
  );

  return kb;
}

function buildAppsMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🚀 Apps / RAM", "apps_menu")
    .row()
    .text("🔙 Retour", "back_to_main");
}

function buildInputMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⌨️ Taper du texte (à distance)", "type_text_prompt")
    .row()
    .text("🔙 Retour", "back_to_main");
}

function buildExplorerMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🗂️ Explorateur PC", "explore_init")
    .text("📂 Dossier Bot", "open_folder")
    .row()
    .text("🔄 Redémarrer le bot", "restart_bot")
    .row()
    .text("🔙 Retour", "back_to_main");
}

// 🌐 Réseau — Menu top-level
function buildNetworkMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📶 Infos Wi-Fi & IP Publique", "net_info")
    .row()
    .text("🔑 Exporter Mots de passe WiFi", "wifi_export_passwords")
    .row()
    .text("🔙 Retour", "back_to_main");
}

// 📋 Presse-papier — Menu top-level
function buildClipboardMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📋 Lire Presse-papier PC", "read_pc_clip")
    .row()
    .text("🔙 Retour", "back_to_main");
}

// ⌨️ Raccourcis & Fenêtres — Menu top-level
function buildShortcutsMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Alt + Tab", "key_alttab")
    .text("🖥️ Bureau (Win+D)", "key_wind")
    .row()
    .text("❌ Fermer (Alt+F4)", "key_altf4")
    .text("🔁 Rafraîchir (F5)", "key_f5")
    .row()
    .text("↩️ Entrée", "key_enter")
    .text("⌨️ Taper du texte", "type_text_prompt")
    .row()
    .text("🔙 Retour", "back_to_main");
}

// ⏱️ Formate une durée en secondes de manière lisible
function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m}m ${s}s (${sec}s)` : `${m}m (${sec}s)`;
  }
  if (sec < 86400) {
    const h = (sec / 3600).toFixed(1).replace(/\.0$/, "");
    return `${h}h (${sec}s)`;
  }
  const j = (sec / 86400).toFixed(1).replace(/\.0$/, "");
  return `${j}j (${sec}s)`;
}

// 📷 Capture webcam silencieuse (réutilisée par /webcam_photo et l'alarme intrusion)
function captureWebcamPhoto(captionText: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!WEBCAM_NAME) return reject(new Error("Aucune webcam détectée"));
    const camPath = path.join(os.tmpdir(), `webcam_${Date.now()}.jpg`);

    runSilent(
      ffmpegPath,
      [
        "-y",
        "-f",
        "dshow",
        "-i",
        `video=${WEBCAM_NAME}`,
        "-vframes",
        "1",
        camPath,
      ],
      async (err) => {
        if (err) return reject(err);
        try {
          await bot.api.sendPhoto(MON_ID, new InputFile(camPath), {
            caption: captionText,
          });
          if (fs.existsSync(camPath)) fs.unlinkSync(camPath);
          resolve();
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

// 📦 Envoie la vidéo sur Telegram si < 50 Mo, sinon la sauvegarde sur le PC
async function deliverOrSaveVideo(
  ctx: Context,
  tempPath: string,
  finalFileName: string,
  captionText: string,
): Promise<void> {
  const stats = fs.statSync(tempPath);
  const sizeMB = stats.size / (1024 * 1024);

  if (sizeMB <= 49.5) {
    try {
      await ctx.replyWithVideo(new InputFile(tempPath), {
        caption: `${captionText} — ${sizeMB.toFixed(1)} Mo`,
      });
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  } else {
    const downloadDir = path.join(os.homedir(), "Downloads", "Telegram-Bot");
    if (!fs.existsSync(downloadDir))
      fs.mkdirSync(downloadDir, { recursive: true });

    const savedPath = path.join(downloadDir, finalFileName);
    fs.copyFileSync(tempPath, savedPath);
    fs.unlinkSync(tempPath);

    await ctx.reply(
      `📁 **Vidéo trop volumineuse pour Telegram (${sizeMB.toFixed(1)} Mo > 50 Mo)**\n\nElle a été sauvegardée en sécurité sur ton PC :\n\`Downloads\\Telegram-Bot\\${finalFileName}\``,
      { parse_mode: "Markdown" },
    );
  }
}

// ⚙️ Exécute l'action temporisée choisie
async function runTimedAction(
  ctx: Context,
  action: string,
  seconds: number,
): Promise<void> {
  const maxLimit = action === "shutdown" ? 30 * 86400 : 12 * 3600;
  const sec = Math.max(1, Math.min(Number(seconds), maxLimit));
  const label = formatDuration(sec);

  const fps = sec > 1800 ? "10" : "15";
  const crf = sec > 1800 ? "32" : "28";

  if (action === "record_screen") {
    // Priorité : Loopback (son système) > Micro > Pas de son
    const hasLoopback = !!LOOPBACK_NAME;
    const hasMic = !!AUDIO_NAME;
    const audioLabel = hasLoopback
      ? " + son système"
      : hasMic
        ? " + micro"
        : " (sans son)";
    await ctx.reply(
      `🎥 Enregistrement écran (${label})${audioLabel} en cours...`,
    );
    const stamp = Date.now();
    const videoPath = path.join(os.tmpdir(), `screen_${stamp}.mp4`);

    let args: string[];
    if (hasLoopback) {
      // Capture son système (musique, vidéos, etc.) via Stereo Mix / Loopback
      args = [
        "-y",
        "-f",
        "gdigrab",
        "-framerate",
        fps,
        "-t",
        String(sec),
        "-i",
        "desktop",
        "-f",
        "dshow",
        "-t",
        String(sec),
        "-i",
        `audio=${LOOPBACK_NAME}`,
        "-vcodec",
        "libx264",
        "-crf",
        crf,
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "ultrafast",
        "-acodec",
        "aac",
        videoPath,
      ];
    } else if (hasMic) {
      // Fallback : micro seulement
      args = [
        "-y",
        "-f",
        "gdigrab",
        "-framerate",
        fps,
        "-t",
        String(sec),
        "-i",
        "desktop",
        "-f",
        "dshow",
        "-t",
        String(sec),
        "-i",
        `audio=${AUDIO_NAME}`,
        "-vcodec",
        "libx264",
        "-crf",
        crf,
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "ultrafast",
        "-acodec",
        "aac",
        videoPath,
      ];
    } else {
      // Pas de son du tout
      args = [
        "-y",
        "-f",
        "gdigrab",
        "-framerate",
        fps,
        "-t",
        String(sec),
        "-i",
        "desktop",
        "-vcodec",
        "libx264",
        "-crf",
        crf,
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "ultrafast",
        videoPath,
      ];
    }

    runSilent(ffmpegPath, args, async (err) => {
      if (err) return ctx.reply("❌ Erreur record écran : " + err.message);
      await deliverOrSaveVideo(
        ctx,
        videoPath,
        `Screen_${stamp}.mp4`,
        `🎥 Capture écran (${label})`,
      );
    });
  }

  if (action === "webcam_video") {
    if (!WEBCAM_NAME) {
      await ctx.reply("❌ Aucune webcam détectée sur ce PC.");
      return;
    }
    // Toujours essayer de capturer le micro pour le son ambiant
    const hasMic = !!AUDIO_NAME;
    const audioLabel = hasMic ? " + micro (son ambiant)" : " (sans micro ⚠️)";
    await ctx.reply(
      `📹 Enregistrement webcam (${label})${audioLabel} en cours...`,
    );
    const stamp = Date.now();
    const camVideoPath = path.join(os.tmpdir(), `webcam_${stamp}.mp4`);

    // Pas d'échappement individuel : ffmpeg dshow gère les espaces dans les noms de devices
    // L'input complet est passé comme un seul argument
    const inputSource = AUDIO_NAME
      ? `video=${WEBCAM_NAME}:audio=${AUDIO_NAME}`
      : `video=${WEBCAM_NAME}`;

    const args = [
      "-y",
      "-f",
      "dshow",
      "-t",
      String(sec),
      "-i",
      inputSource,
      "-vcodec",
      "libx264",
      "-crf",
      crf,
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "ultrafast",
    ];

    if (AUDIO_NAME) {
      args.push("-acodec", "aac");
    }
    args.push(camVideoPath);

    runSilent(ffmpegPath, args, async (err) => {
      if (err) return ctx.reply("❌ Erreur vidéo webcam : " + err.message);
      await deliverOrSaveVideo(
        ctx,
        camVideoPath,
        `Webcam_${stamp}.mp4`,
        `📹 Vidéo webcam (${label})`,
      );
    });
  }

  if (action === "shutdown") {
    runSilent("shutdown", ["/s", "/t", String(sec)], () => {});
    await ctx.reply(
      `🛑 **Extinction programmée dans ${label}.**\n_(Utilise "❌ Annuler arrêt" dans /pc pour stopper)_`,
      { parse_mode: "Markdown" },
    );
  }
}

// 📱 COMMANDE PRINCIPALE : /pc
bot.command("pc", async (ctx: Context) => {
  pendingAction = null;
  await ctx.reply("🖥️ **Télécommande PC Windows**", {
    reply_markup: getMainMenu(),
    parse_mode: "Markdown",
  });
});

// 📖 COMMANDE D'AIDE : /help
bot.command("help", async (ctx: Context) => {
  pendingAction = null;

  const helpText = [
    "📖 **GUIDE DE LA TÉLÉCOMMANDE PC**",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    "⌨️ **Commandes disponibles :**",
    "• `/pc` — Ouvrir le panneau de contrôle principal",
    "• `/cd C:\\chemin` — Ouvrir un dossier précis dans l'explorateur",
    "• `/help` — Afficher ce guide d'utilisation",
    "",
    "📋 **AirDrop Maison (Envoi direct au bot) :**",
    "• **Texte / Emojis** → Copié dans le presse-papier du PC (`Ctrl+V`)",
    "• **Lien (`http://...`)** → Ouvert dans le navigateur du PC",
    "• **Photo** → Copiée dans le presse-papier du PC (`Ctrl+V`)",
    "• **Fichier / Document** → Sauvegardé dans `Downloads\\Telegram-Bot`",
    "",
    "⏱️ **Formats de durée acceptés (Record & Extinction) :**",
    "• Secondes : `45` ou `30s`",
    "• Minutes : `5m` ou `15min`",
    "• Heures : `2h` ou `1.5h`",
    "• Jours *(extinction)* : `1j` ou `2jours`",
    "_(Vidéos > 50 Mo : sauvegardées automatiquement sur le PC)_",
    "",
    "🎛️ **Boutons du panneau `/pc` :**",
    "• **📊 Infos PC** : Fiche technique (CPU, RAM, GPU, Disques, IP, Batterie)",
    "• **🔊 Volume / ☀️ Luminosité** : Paliers rapides ou chiffre libre (`0` à `100`)",
    "• **🔇 Son PC / 🎙️ Micro PC / ⏯️ Play-Pause** : Contrôle audio & média",
    "• **🌿 Éco Énergie** : Bascule l'économiseur d'énergie Windows 11",
    "• **📸 Screenshot / 🎥 Record Écran** : Capture fixe ou vidéo + son",
    "• **📷 Photo Cam / 📹 Vidéo Cam** : Capture webcam auto-détectée",
    "• **💤 Veille / 🔒 Verrouiller** : Veille simple ou verrouillage session",
    "• **🖥️ Éteindre Écran / 💡 Allumer Écran** : Coupe ou réveille l'affichage seul",
    "• **🛑 Éteindre / ❌ Annuler arrêt** : Extinction programmée ou annulation",
    "• **🛡️ Sécurité** : Surveillance intrusion (photo auto au déverrouillage) + alarme 100%",
    "• **🚀 Apps / RAM** : Lance VS Code, Chrome, Terminal, Explorateur / tue un processus bloqué",
    "• **⌨️ Clavier** : Alt+Tab, Win+D, Alt+F4, F5, Entrée ou frappe de texte à distance",
    "• **📶 Réseau / Clip** : SSID Wi-Fi, IP publique et lecture du presse-papier PC",
    "• **🗂️ Explorateur PC / 📂 Dossier Bot** : Navigation disques `A:` à `Z:` et téléchargement",
  ].join("\n");

  const kb = new InlineKeyboard().text(
    "🖥️ Ouvrir le panneau /pc",
    "back_to_main",
  );

  await ctx.reply(helpText, { reply_markup: kb, parse_mode: "Markdown" });
});

// 🔙 RETOUR AU MENU PRINCIPAL
bot.callbackQuery(
  "back_to_main",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("🖥️ **Télécommande PC Windows**", {
      reply_markup: getMainMenu(),
      parse_mode: "Markdown",
    });
  },
);

// 🔙 RETOUR GÉNÉRIQUE (un niveau en arrière) — format: "back_to:menu_name"
bot.callbackQuery(
  /^back_to:(.+)$/,
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery();
    const targetMenu = ctx.match[1];

    const menuBuilders: Record<string, () => InlineKeyboard> = {
      menu_system: buildSystemMenu,
      menu_audio: buildAudioMenu,
      menu_display: buildDisplayMenu,
      menu_camera: buildCameraMenu,
      menu_power: buildPowerMenu,
      menu_apps: buildAppsMenu,
      menu_input: buildInputMenu,
      menu_explorer: buildExplorerMenu,
      menu_network: buildNetworkMenu,
      menu_clipboard: buildClipboardMenu,
      menu_shortcuts: buildShortcutsMenu,
    };

    const builder = menuBuilders[targetMenu];
    if (!builder) {
      return ctx.editMessageText("❌ Menu inconnu", {
        reply_markup: getMainMenu(),
        parse_mode: "Markdown",
      });
    }

    const titles: Record<string, string> = {
      menu_system: "📊 **Système**",
      menu_audio: "🔊 **Audio / Média**",
      menu_display: "🖥️ **Affichage / Énergie**",
      menu_camera: "📸 **Caméra / Écran**",
      menu_power: "⚡ **Alimentation**",
      menu_apps: "🚀 **Apps / Ressources**",
      menu_input: "⌨️ **Entrée / Clavier**",
      menu_explorer: "🗂️ **Explorateur**",
      menu_network: "🌐 **Réseau**",
      menu_clipboard: "📋 **Presse-papier**",
      menu_shortcuts: "⌨️ **Raccourcis & Fenêtres**",
    };

    await ctx.editMessageText(titles[targetMenu] || "🖥️ **Menu**", {
      reply_markup: builder(),
      parse_mode: "Markdown",
    });
  },
);

// ==========================================
// 📋 NAVIGATION SOUS-MENUS (Catégories UX)
// ==========================================
bot.callbackQuery("menu_system", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("📊 **Système**", {
    reply_markup: buildSystemMenu(),
    parse_mode: "Markdown",
  });
});

bot.callbackQuery("menu_audio", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("🔊 **Audio / Média**", {
    reply_markup: buildAudioMenu(),
    parse_mode: "Markdown",
  });
});

bot.callbackQuery(
  "menu_display",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("🖥️ **Affichage / Énergie**", {
      reply_markup: buildDisplayMenu(),
      parse_mode: "Markdown",
    });
  },
);

bot.callbackQuery("menu_camera", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("📸 **Caméra / Écran**", {
    reply_markup: buildCameraMenu(),
    parse_mode: "Markdown",
  });
});

bot.callbackQuery("menu_power", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("⚡ **Alimentation**", {
    reply_markup: buildPowerMenu(),
    parse_mode: "Markdown",
  });
});

bot.callbackQuery("menu_apps", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("🚀 **Apps / Ressources**", {
    reply_markup: buildAppsMenu(),
    parse_mode: "Markdown",
  });
});

bot.callbackQuery("menu_input", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("⌨️ **Entrée / Clavier**", {
    reply_markup: buildInputMenu(),
    parse_mode: "Markdown",
  });
});

bot.callbackQuery(
  "menu_explorer",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("🗂️ **Explorateur**", {
      reply_markup: buildExplorerMenu(),
      parse_mode: "Markdown",
    });
  },
);

bot.callbackQuery(
  "menu_network",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("🌐 **Réseau**", {
      reply_markup: buildNetworkMenu(),
      parse_mode: "Markdown",
    });
  },
);

bot.callbackQuery(
  "menu_clipboard",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("📋 **Presse-papier**", {
      reply_markup: buildClipboardMenu(),
      parse_mode: "Markdown",
    });
  },
);

bot.callbackQuery(
  "menu_shortcuts",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("⌨️ **Raccourcis & Fenêtres**", {
      reply_markup: buildShortcutsMenu(),
      parse_mode: "Markdown",
    });
  },
);

// ==========================================
// 📊 FICHE TECHNIQUE COMPLÈTE DU PC
// ==========================================
bot.callbackQuery("stats", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery("📊 Analyse du système...");

  const psScript = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $gpu = Get-CimInstance Win32_VideoController | Select-Object -First 1
    $bat = Get-CimInstance Win32_Battery | Select-Object -First 1
    $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
      @{
        drive = $_.DeviceID
        free  = [math]::Round($_.FreeSpace / 1GB, 1)
        total = [math]::Round($_.Size / 1GB, 1)
      }
    }
    $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1).IPAddress
    $uptime = (Get-Date) - $os.LastBootUpTime

    @{
      pcName   = $cs.Name
      model    = ($cs.Manufacturer + " " + $cs.Model).Trim()
      osName   = $os.Caption -replace "Microsoft ", ""
      osBuild  = $os.BuildNumber
      osArch   = $os.OSArchitecture
      sysType  = $cs.SystemType
      cpuName  = ($cpu.Name -replace "\\s+", " ").Trim()
      cpuLoad  = $cpu.LoadPercentage
      gpuName  = if ($gpu) { $gpu.Name.Trim() } else { "Inconnue" }
      ramTotal = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
      ramFree  = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
      batPct   = if ($bat) { $bat.EstimatedChargeRemaining } else { $null }
      batState = if ($bat) { $bat.BatteryStatus } else { $null }
      uptime   = "{0}j {1}h {2}m" -f $uptime.Days, $uptime.Hours, $uptime.Minutes
      ip       = if ($ip) { $ip } else { "Hors ligne" }
      disks    = @($disks)
    } | ConvertTo-Json -Compress
  `;

  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  runSilent(
    "powershell",
    ["-NoProfile", "-EncodedCommand", encoded],
    async (err, stdout) => {
      if (err) return ctx.reply("❌ Erreur lecture infos PC : " + err.message);

      try {
        interface SystemInfo {
          pcName: string;
          model: string;
          osName: string;
          osBuild: number;
          osArch: string;
          sysType: string;
          cpuName: string;
          cpuLoad?: number;
          gpuName: string;
          ramTotal: number;
          ramFree: number;
          batPct: number | null;
          batState: number | null;
          uptime: string;
          ip: string;
          disks: Array<{ drive: string; free: number; total: number }>;
        }
        const info = JSON.parse(stdout.trim()) as SystemInfo;
        const ramUsed = (info.ramTotal - info.ramFree).toFixed(1);
        const ramPct = Math.round((Number(ramUsed) / info.ramTotal) * 100);

        let batLine = "🔌 Secteur (PC Fixe)";
        if (info.batPct !== null) {
          const charging =
            info.batState === 2 ? " ⚡ (En charge)" : " 🔋 (Sur batterie)";
          batLine = `${info.batPct}%${charging}`;
        }

        const archLabel = info.sysType?.toLowerCase().includes("arm")
          ? "processeur ARM"
          : "processeur x64";
        const systemType = `Système d'exploitation ${info.osArch}, ${archLabel}`;

        const diskLines = info.disks
          .map((d) => {
            const used = (d.total - d.free).toFixed(1);
            return `  • \`${d.drive}\` : **${d.free} Go** libres / ${d.total} Go _(${used} Go utilisés)_`;
          })
          .join("\n");

        const report = [
          `🖥️ **FICHE SYSTÈME — ${info.pcName}**`,
          `━━━━━━━━━━━━━━━━━━━━`,
          `💻 **Modèle :** ${info.model}`,
          `🪟 **Système :** ${info.osName} _(Build ${info.osBuild})_`,
          `🧬 **Type du système :** ${systemType}`,
          `⚙️ **Processeur :** ${info.cpuName}`,
          `📈 **Charge CPU :** ${info.cpuLoad ?? 0}%`,
          `🎮 **Carte graphique :** ${info.gpuName}`,
          `🧠 **RAM :** ${ramUsed} Go / ${info.ramTotal} Go _(${ramPct}% utilisée — ${info.ramFree} Go libres)_`,
          `🔋 **Batterie :** ${batLine}`,
          `⏱️ **Allumé depuis :** ${info.uptime}`,
          `🌐 **IP Locale :** \`${info.ip}\``,
          `📷 **Caméra :** \`${WEBCAM_NAME || "Aucune"}\``,
          `🎙️ **Micro :** \`${AUDIO_NAME || "Aucun"}\``,
          `💾 **Disques installés :**`,
          diskLines,
        ].join("\n");

        await ctx.reply(report, { parse_mode: "Markdown" });
      } catch (parseErr) {
        await ctx.reply(
          "❌ Erreur formatage infos : " + (parseErr as Error).message,
        );
      }
    },
  );
});

// ==========================================
// 🔊 AUDIO & MÉDIA (Mute, Micro, Play/Pause, Volume)
// ==========================================
// Helper: envoie une touche virtuelle via keybd_event (système-wide, sans focus)
function sendVK(vkCode: number): void {
  const psScript = `
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    public class KeySender {
      [DllImport("user32.dll")]
      public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
      public const uint KEYEVENTF_KEYUP = 0x0002;
      public static void Press(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
      }
    }
"@
    [KeySender]::Press(${vkCode})
  `;
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  runSilent("powershell", ["-NoProfile", "-EncodedCommand", encoded], () => {});
}

bot.callbackQuery("mute", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  // VK_VOLUME_MUTE = 0xAD (173)
  sendVK(0xad);
  await ctx.answerCallbackQuery("🔇 Son basculé !");
});

bot.callbackQuery("playpause", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  // VK_MEDIA_PLAY_PAUSE = 0xB3 (179)
  sendVK(0xb3);
  await ctx.answerCallbackQuery("⏯️ Play / Pause !");
});

// ⏮️ Précédent
bot.callbackQuery("media_prev", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  // VK_MEDIA_PREV_TRACK = 0xB1 (177)
  sendVK(0xb1);
  await ctx.answerCallbackQuery("⏮️ Précédent !");
});

// ⏭️ Suivant
bot.callbackQuery("media_next", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  // VK_MEDIA_NEXT_TRACK = 0xB0 (176)
  sendVK(0xb0);
  await ctx.answerCallbackQuery("⏭️ Suivant !");
});

// ⏹️ Stop
bot.callbackQuery("media_stop", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  // VK_MEDIA_STOP = 0xB2 (178)
  sendVK(0xb2);
  await ctx.answerCallbackQuery("⏹️ Stop !");
});

bot.callbackQuery("mic_mute", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  const psScript = `
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume {
      [PreserveSig] int f(); [PreserveSig] int g(); [PreserveSig] int h(); [PreserveSig] int i();
      [PreserveSig] int j(); [PreserveSig] int k(); [PreserveSig] int l(); [PreserveSig] int m();
      [PreserveSig] int n(); [PreserveSig] int o(); [PreserveSig] int p();
      [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
      [PreserveSig] int GetMute(out bool pbMute);
    }
    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
      [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
      [PreserveSig] int f();
      [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    }
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
    public class MicControl {
      public static string Toggle() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice dev;
        enumerator.GetDefaultAudioEndpoint(1, 0, out dev);
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object o;
        dev.Activate(ref iid, 23, IntPtr.Zero, out o);
        var vol = (IAudioEndpointVolume)o;
        bool muted;
        vol.GetMute(out muted);
        Guid ctx = Guid.Empty;
        vol.SetMute(!muted, ref ctx);
        return !muted ? "MUTED" : "UNMUTED";
      }
    }
"@
    [MicControl]::Toggle()
  `;

  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  runSilent(
    "powershell",
    ["-NoProfile", "-EncodedCommand", encoded],
    async (err, stdout) => {
      if (err)
        return ctx.answerCallbackQuery("❌ Erreur micro : " + err.message);
      const state =
        stdout.trim() === "MUTED" ? "🔇 Micro coupé !" : "🎙️ Micro activé !";
      await ctx.answerCallbackQuery(state);
    },
  );
});

bot.callbackQuery("playpause", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  runSilent(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys('{MEDIA_PLAY_PAUSE}')",
    ],
    () => {},
  );
  await ctx.answerCallbackQuery("⏯️ Play / Pause !");
});

// ⏮️ Précédent
bot.callbackQuery("media_prev", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  runSilent(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys('{MEDIA_PREV_TRACK}')",
    ],
    () => {},
  );
  await ctx.answerCallbackQuery("⏮️ Précédent !");
});

// ⏭️ Suivant
bot.callbackQuery("media_next", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  runSilent(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys('{MEDIA_NEXT_TRACK}')",
    ],
    () => {},
  );
  await ctx.answerCallbackQuery("⏭️ Suivant !");
});

// 🔊 Volume + (incrément de ~5%) - VK_VOLUME_UP = 0xAF (175)
bot.callbackQuery("vol_up", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  for (let i = 0; i < 3; i++) sendVK(0xaf);
  await ctx.answerCallbackQuery("🔊 Volume +");
});

// 🔈 Volume - (décrément de ~5%) - VK_VOLUME_DOWN = 0xAE (174)
bot.callbackQuery("vol_down", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  for (let i = 0; i < 3; i++) sendVK(0xae);
  await ctx.answerCallbackQuery("🔈 Volume -");
});

bot.callbackQuery("volume_menu", async (ctx: CallbackQueryContext<Context>) => {
  await ctx.answerCallbackQuery();
  pendingAction = "volume";

  const volMenu = new InlineKeyboard()
    .text("🔇 Mute / Unmute", "mute")
    .row()
    .text("🔈 Vol -", "vol_down")
    .text("🔊 Vol +", "vol_up")
    .row()
    .text("🔈 10%", "set_vol_10")
    .text("🔉 30%", "set_vol_30")
    .text("🔉 60%", "set_vol_60")
    .text("🔊 100%", "set_vol_100")
    .row()
    .text("🔙 Retour", "back_to:menu_audio")
    .text("🏠 Retour principal", "back_to_main");

  await ctx.editMessageText(
    "🔊 **Volume du PC**\n\nUtilise **Vol+/Vol-** pour ajuster par pas de 5%, ou choisis un preset.\nTu peux aussi **envoyer un chiffre (0-100)** dans le chat.",
    { reply_markup: volMenu, parse_mode: "Markdown" },
  );
});

function setVolume(
  level: string | number,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
): number {
  const val = Math.max(0, Math.min(100, Number(level)));
  if (Number.isNaN(val)) return 0;
  const stepsUp = Math.round(val / 2);

  const psScript = `
    $wshell = New-Object -ComObject WScript.Shell
    for ($i = 0; $i -lt 50; $i++) { $wshell.SendKeys([char]174) }
    for ($i = 0; $i -lt ${stepsUp}; $i++) { $wshell.SendKeys([char]175) }
  `;

  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  runSilent("powershell", ["-NoProfile", "-EncodedCommand", encoded], callback);
  return val;
}

bot.callbackQuery(
  /^set_vol_(\d+)$/,
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    const val = setVolume(ctx.match[1], async (err) => {
      if (err) await ctx.reply("❌ Erreur volume : " + err.message);
    });
    await ctx.answerCallbackQuery(`🔊 Volume réglé à ${val}%`);
    // Retour au menu Audio (volume intégré) au lieu du menu principal
    await ctx.editMessageText(`🔊 **Audio / Média**\n_(Volume : ${val}%)_`, {
      reply_markup: buildAudioMenu(),
      parse_mode: "Markdown",
    });
  },
);

// ==========================================
// ☀️ LUMINOSITÉ & 🌿 ÉCONOMISEUR D'ÉNERGIE
// ==========================================
bot.callbackQuery(
  "brightness_menu",
  async (ctx: CallbackQueryContext<Context>) => {
    await ctx.answerCallbackQuery();
    pendingAction = "brightness";

    const brightMenu = new InlineKeyboard()
      .text("🌑 10%", "set_bright_10")
      .text("🌘 30%", "set_bright_30")
      .text("🌗 60%", "set_bright_60")
      .text("☀️ 100%", "set_bright_100")
      .row()
      .text("🔅 Lum -", "bright_down")
      .text("🔆 Lum +", "bright_up")
      .row()
      .text("🔙 Retour", "back_to:menu_display")
      .text("🏠 Retour principal", "back_to_main");

    await ctx.editMessageText(
      "☀️ **Luminosité de l'écran**\n\nChoisis un niveau, **Lum-/Lum+ (pas de 10%)**, ou **envoie un chiffre entre 0 et 100** dans le chat :",
      { reply_markup: brightMenu, parse_mode: "Markdown" },
    );
  },
);

function setBrightness(
  level: string | number,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
): number {
  const val = Math.max(0, Math.min(100, Number(level)));
  if (Number.isNaN(val)) return 0;
  const psCmd = `(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${val})`;
  runSilent("powershell", ["-NoProfile", "-Command", psCmd], callback);
  return val;
}

bot.callbackQuery(
  /^set_bright_(\d+)$/,
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    const val = setBrightness(ctx.match[1], async (err) => {
      if (err) await ctx.reply("❌ Erreur luminosité : " + err.message);
    });
    await ctx.answerCallbackQuery(`☀️ Luminosité réglée à ${val}%`);
    // Retour au menu Luminosité (sous-menu) au lieu du menu Affichage
    await ctx.editMessageText(
      `☀️ **Luminosité de l'écran**\n_(Actuelle : ${val}%)_`,
      {
        reply_markup: new InlineKeyboard()
          .text("🌑 10%", "set_bright_10")
          .text("🌘 30%", "set_bright_30")
          .text("🌗 60%", "set_bright_60")
          .text("☀️ 100%", "set_bright_100")
          .row()
          .text("🔅 Lum -", "bright_down")
          .text("🔆 Lum +", "bright_up")
          .row()
          .text("🔙 Retour", "back_to:menu_display")
          .text("🏠 Retour principal", "back_to_main"),
        parse_mode: "Markdown",
      },
    );
  },
);

// ☀️ Lum + (pas de 10%)
bot.callbackQuery("bright_up", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  const psScript = `
    $ErrorActionPreference = "Stop"
    try {
      # Lire la luminosité actuelle depuis WmiMonitorBrightness (classe lecture seule)
      $brightness = Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness
      $current = $brightness.CurrentBrightness

      # Calculer la nouvelle valeur
      $new = [math]::Min(100, $current + 10)

      # Appliquer via WmiMonitorBrightnessMethods
      $methods = Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods
      $methods.WmiSetBrightness(1, $new)

      Write-Output $new
    } catch {
      Write-Output "ERROR: $($_.Exception.Message)"
    }
  `;
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  runSilent(
    "powershell",
    ["-NoProfile", "-EncodedCommand", encoded],
    async (err, stdout) => {
      const out = stdout?.trim() || "";
      if (err || out.startsWith("ERROR")) {
        return ctx.answerCallbackQuery("❌ Erreur luminosité");
      }
      const newBrightness = Number(out);
      if (Number.isNaN(newBrightness))
        return ctx.answerCallbackQuery("🔆 Lum +");
      await ctx.answerCallbackQuery(`🔆 Lum + → ${newBrightness}%`);
      // Rester dans le menu luminosité avec la nouvelle valeur
      await ctx.editMessageText(
        `☀️ **Luminosité de l'écran**\n_(Actuelle : ${newBrightness}%)_`,
        {
          reply_markup: new InlineKeyboard()
            .text("🌑 10%", "set_bright_10")
            .text("🌘 30%", "set_bright_30")
            .text("🌗 60%", "set_bright_60")
            .text("☀️ 100%", "set_bright_100")
            .row()
            .text("🔅 Lum -", "bright_down")
            .text("🔆 Lum +", "bright_up")
            .row()
            .text("🔙 Retour", "back_to:menu_display")
            .text("🏠 Retour principal", "back_to_main"),
          parse_mode: "Markdown",
        },
      );
    },
  );
});

// 🔅 Lum - (pas de 10%)
bot.callbackQuery("bright_down", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  const psScript = `
    $ErrorActionPreference = "Stop"
    try {
      # Lire la luminosité actuelle depuis WmiMonitorBrightness (classe lecture seule)
      $brightness = Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness
      $current = $brightness.CurrentBrightness

      # Calculer la nouvelle valeur
      $new = [math]::Max(0, $current - 10)

      # Appliquer via WmiMonitorBrightnessMethods
      $methods = Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods
      $methods.WmiSetBrightness(1, $new)

      Write-Output $new
    } catch {
      Write-Output "ERROR: $($_.Exception.Message)"
    }
  `;
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  runSilent(
    "powershell",
    ["-NoProfile", "-EncodedCommand", encoded],
    async (err, stdout) => {
      const out = stdout?.trim() || "";
      if (err || out.startsWith("ERROR")) {
        return ctx.answerCallbackQuery("❌ Erreur luminosité");
      }
      const newBrightness = Number(out);
      if (Number.isNaN(newBrightness))
        return ctx.answerCallbackQuery("🔅 Lum -");
      await ctx.answerCallbackQuery(`🔅 Lum - → ${newBrightness}%`);
      // Rester dans le menu luminosité avec la nouvelle valeur
      await ctx.editMessageText(
        `☀️ **Luminosité de l'écran**\n_(Actuelle : ${newBrightness}%)_`,
        {
          reply_markup: new InlineKeyboard()
            .text("🌑 10%", "set_bright_10")
            .text("🌘 30%", "set_bright_30")
            .text("🌗 60%", "set_bright_60")
            .text("☀️ 100%", "set_bright_100")
            .row()
            .text("🔅 Lum -", "bright_down")
            .text("🔆 Lum +", "bright_up")
            .row()
            .text("🔙 Retour", "back_to:menu_display")
            .text("🏠 Retour principal", "back_to_main"),
          parse_mode: "Markdown",
        },
      );
    },
  );
});

bot.callbackQuery("saver_menu", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery();

  const saverMenu = new InlineKeyboard()
    .text("🌿 Activer Éco Énergie", "saver_on")
    .row()
    .text("⚡ Désactiver (Normal)", "saver_off")
    .row()
    .text("🔙 Retour", "back_to:menu_display")
    .text("🏠 Retour principal", "back_to_main");

  await ctx.editMessageText(
    "🌿 **Économiseur d'énergie Windows 11**\n\nActiver ou désactiver le mode Économie d'énergie :",
    { reply_markup: saverMenu, parse_mode: "Markdown" },
  );
});

bot.callbackQuery(
  ["saver_on", "saver_off"],
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    const wantOn = ctx.callbackQuery.data === "saver_on";

    // Méthode officielle : powercfg /setactive avec les GUIDs des plans d'alimentation
    // GUIDs trouvés/testés : Économie=a1841308-3541-4fab-bc81-f71556f20b4a, Normal=381b4222-f694-41f0-9685-ff5bb260df2e
    const psScript = `
    $ErrorActionPreference = "Stop"
    try {
      $guidOn  = "a1841308-3541-4fab-bc81-f71556f20b4a"  # Plan Économie d'énergie
      $guidOff = "381b4222-f694-41f0-9685-ff5bb260df2e"  # Plan Normal / Équilibré

      $targetGuid = $(if ($${wantOn}) { $guidOn } else { $guidOff })

      # Vérifier le plan actif actuel
      $active = powercfg /getactivescheme
      $isAlreadyActive = $active -like "*$targetGuid*"

      if ($isAlreadyActive) {
        Write-Output "ALREADY_SET"
        exit 0
      }

      # Activer le plan cible
      powercfg /setactive $targetGuid

      Write-Output "OK"
    } catch {
      Write-Output "ERROR: $($_.Exception.Message)"
    }
  `;

    const encoded = Buffer.from(psScript, "utf16le").toString("base64");
    runSilent(
      "powershell",
      ["-NoProfile", "-EncodedCommand", encoded],
      async (err, stdout) => {
        const out = stdout?.trim() || "";
        if (err || out.startsWith("ERROR")) {
          return ctx.reply(
            "⚠️ Impossible de basculer l'Économiseur d'énergie (registre/powercfg).\n" +
              `Détail: ${out || err?.message || "inconnu"}`,
          );
        }
        if (out === "ALREADY_SET") {
          return ctx.answerCallbackQuery(
            wantOn ? "🌿 Déjà activé" : "⚡ Déjà désactivé",
          );
        }
        const label = wantOn
          ? "🌿 Économiseur d'énergie activé !"
          : "⚡ Économiseur d'énergie désactivé !";
        await ctx.answerCallbackQuery(label);
        await ctx.editMessageText(
          `🖥️ **Télécommande PC Windows**\n_(${label})_`,
          {
            reply_markup: getMainMenu(),
            parse_mode: "Markdown",
          },
        );
      },
    );
  },
);

// ==========================================
// 🔋 GESTION DES PLANS D'ALIMENTATION (DYNAMIQUE)
// ==========================================
bot.callbackQuery(
  "power_plans_menu",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery("Chargement des plans...");

    const plans = await detectPowerPlans();

    if (plans.length === 0) {
      await ctx.editMessageText(
        "Aucun plan d'alimentation detecte\n\nImpossible de lire la liste via powercfg /list.",
        {
          reply_markup: new InlineKeyboard().text(
            "Retour",
            "back_to:menu_power",
          ),
          parse_mode: "Markdown",
        },
      );
      return;
    }

    await ctx.editMessageText(
      "Modes d'alimentation Windows\n\n= Actif actuellement\n\nClique sur un plan pour l'activer :",
      { reply_markup: buildPowerPlansMenu(plans), parse_mode: "Markdown" },
    );
  },
);

bot.callbackQuery(
  /^power_set_(.+)$/,
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    const guid = ctx.match[1];

    // Validation stricte du format GUID pour prévenir l'injection de commande
    const guidRegex =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!guidRegex.test(guid)) {
      return ctx.answerCallbackQuery("❌ GUID invalide");
    }

    await ctx.answerCallbackQuery("Basculement en cours...");

    // Utilisation de guillemets simples PowerShell pour empêcher l'expansion de variables
    const psScript = `
    $ErrorActionPreference = "Stop"
    try {
      powercfg /setactive '${guid}'
      Write-Output "OK"
    } catch {
      Write-Output "ERROR: $($_.Exception.Message)"
    }
  `;

    const encoded = Buffer.from(psScript, "utf16le").toString("base64");
    runSilent(
      "powershell",
      ["-NoProfile", "-EncodedCommand", encoded],
      async (err, stdout) => {
        const out = stdout?.trim() || "";
        if (err || out.startsWith("ERROR")) {
          return ctx.reply(
            "Impossible de basculer le plan d'alimentation.\n" +
              `Detail: ${out || err?.message || "inconnu"}`,
          );
        }

        // Rafraichir le menu pour montrer le nouveau plan actif
        const plans = await detectPowerPlans();
        await ctx.answerCallbackQuery("Plan active !");
        await ctx.editMessageText(
          "Modes d'alimentation Windows\n\n= Actif actuellement\n\nClique sur un plan pour l'activer :",
          { reply_markup: buildPowerPlansMenu(plans), parse_mode: "Markdown" },
        );
      },
    );
  },
);

// ==========================================
// 📸 CAPTURES ÉCRAN & WEBCAM
// ==========================================
bot.callbackQuery("screen", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery("Capture en cours...");
  try {
    const imgBuffer = await captureScreenshot();
    await ctx.replyWithPhoto(new InputFile(imgBuffer, "screen.png"), {
      caption: "📸 Écran actuel",
    });
  } catch (err) {
    await ctx.reply("❌ Erreur capture : " + (err as Error).message);
  }
});

bot.callbackQuery(
  "webcam_photo",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    if (!WEBCAM_NAME) {
      return ctx.answerCallbackQuery("❌ Aucune webcam détectée sur ce PC.");
    }
    await ctx.answerCallbackQuery("📷 Capture webcam...");
    try {
      await captureWebcamPhoto("📷 Photo depuis la webcam du PC");
    } catch (err) {
      await ctx.reply("❌ Erreur webcam : " + (err as Error).message);
    }
  },
);

// ==========================================
// ⏱️ DURÉES PERSONNALISÉES (Record Écran, Vidéo Cam, Extinction)
// ==========================================
bot.callbackQuery(
  ["record_screen", "webcam_video", "shutdown"],
  async (ctx: CallbackQueryContext<Context>) => {
    await ctx.answerCallbackQuery();
    const action = ctx.callbackQuery.data;

    if (action === "webcam_video" && !WEBCAM_NAME) {
      return ctx.reply("❌ Aucune webcam détectée sur ce PC.");
    }

    pendingAction = action;

    const titles: Record<string, string> = {
      record_screen: "🎥 **Durée du Record Écran**",
      webcam_video: "📹 **Durée de la Vidéo Webcam**",
      shutdown: "🛑 **Délai avant extinction du PC**",
    };

    // Parent menu for "Retour" button
    const parentMenu = action === "shutdown" ? "menu_power" : "menu_camera";

    const timeMenu =
      action === "shutdown"
        ? new InlineKeyboard()
            .text("10s", "timed_shutdown_10")
            .text("5m", "timed_shutdown_300")
            .text("1h", "timed_shutdown_3600")
            .text("2h", "timed_shutdown_7200")
            .row()
            .text("🔙 Retour", `back_to:${parentMenu}`)
            .text("🏠 Retour principal", "back_to_main")
        : new InlineKeyboard()
            .text("5s", `timed_${action}_5`)
            .text("15s", `timed_${action}_15`)
            .text("30s", `timed_${action}_30`)
            .text("1m", `timed_${action}_60`)
            .row()
            .text("🔙 Retour", `back_to:${parentMenu}`)
            .text("🏠 Retour principal", "back_to_main");

    await ctx.editMessageText(
      `${titles[action]}\n\nChoisis un raccourci ou envoie une durée libre dans le chat (ex: \`45\`, \`30s\`, \`5m\`, \`2h\`, \`1.5h\`, \`1j\`) :`,
      { reply_markup: timeMenu, parse_mode: "Markdown" },
    );
  },
);

bot.callbackQuery(
  /^timed_(record_screen|webcam_video|shutdown)_(\d+)$/,
  async (ctx: CallbackQueryContext<Context>) => {
    await ctx.answerCallbackQuery();
    const [, action, seconds] = ctx.match;
    pendingAction = null;

    await ctx.editMessageText("🖥️ **Télécommande PC Windows**", {
      reply_markup: getMainMenu(),
      parse_mode: "Markdown",
    });

    await runTimedAction(ctx, action, Number(seconds));
  },
);

// ==========================================
// 💤 VEILLE SIMPLE, VERROUILLAGE & ÉCRAN ON/OFF
// ==========================================
bot.callbackQuery("sleep", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery();
  const confirmMenu = new InlineKeyboard()
    .text("✅ Oui, mettre en veille", "confirm_sleep")
    .row()
    .text("🔙 Retour", "back_to:menu_power")
    .text("🏠 Retour principal", "back_to_main");

  await ctx.editMessageText(
    "💤 **Confirmation requise**\n\nEs-tu sûr de vouloir mettre ton PC en veille simple ?",
    { reply_markup: confirmMenu, parse_mode: "Markdown" },
  );
});

bot.callbackQuery(
  "confirm_sleep",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery("💤 Mise en veille simple...");
    await ctx.editMessageText("💤 **PC mis en veille simple.**", {
      reply_markup: getMainMenu(),
      parse_mode: "Markdown",
    });

    setTimeout(() => {
      runSilent(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)",
        ],
        () => {},
      );
    }, 400);
  },
);

bot.callbackQuery("lock", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery("🔒 PC verrouillé !");
  runSilent("rundll32.exe", ["user32.dll,LockWorkStation"], () => {});
});

bot.callbackQuery("screen_off", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery("🖥️ Écran éteint (PC toujours actif) !");

  const psScript = `
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    public class Monitor {
      [DllImport("user32.dll")]
      public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam);
    }
"@
    [Monitor]::SendMessage(-1, 0x0112, 0xF170, 2)
  `;

  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  setTimeout(() => {
    runSilent(
      "powershell",
      ["-NoProfile", "-EncodedCommand", encoded],
      () => {},
    );
  }, 400);
});

bot.callbackQuery("screen_on", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery("💡 Écran rallumé !");

  const psScript = `
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    public class WakeUp {
      [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
      [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
    }
"@
    [WakeUp]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)
    [WakeUp]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 100
    [WakeUp]::mouse_event(0x0001, 5, 0, 0, [UIntPtr]::Zero)
    [WakeUp]::mouse_event(0x0001, -5, 0, 0, [UIntPtr]::Zero)
  `;

  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  runSilent("powershell", ["-NoProfile", "-EncodedCommand", encoded], () => {});
});

bot.callbackQuery("abort", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  runSilent("shutdown", ["/a"], () => {});
  await ctx.answerCallbackQuery("✅ Extinction annulée !");
});

// ==========================================
// 🛡️ SÉCURITÉ & ANTI-INTRUSION
// ==========================================
function startUnlockWatcher(): void {
  if (unlockWatcherProcess) return;

  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    $handler = [Microsoft.Win32.SessionSwitchEventHandler]{
      param($sender, $e)
      if ($e.Reason -eq [Microsoft.Win32.SessionSwitchReason]::SessionUnlock) {
        [Console]::WriteLine("UNLOCKED")
        [Console]::Out.Flush()
      }
    }
    [Microsoft.Win32.SystemEvents]::add_SessionSwitch($handler)
    while ($true) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 250
    }
  `;

  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  unlockWatcherProcess = execFile(
    "powershell",
    ["-STA", "-NoProfile", "-EncodedCommand", encoded],
    { windowsHide: true },
  );

  unlockWatcherProcess.stdout?.on("data", async (chunk: Buffer) => {
    if (chunk.toString().includes("UNLOCKED") && unlockGuardActive) {
      const now = new Date().toLocaleTimeString("fr-FR");
      try {
        await captureWebcamPhoto(
          `🚨 ALERTE INTRUSION : Session Windows déverrouillée à ${now} !`,
        );
      } catch {
        try {
          await bot.api.sendMessage(
            MON_ID,
            `🚨 **ALERTE :** Session Windows déverrouillée à **${now}** (caméra indisponible).`,
            { parse_mode: "Markdown" },
          );
        } catch {
          // ignore
        }
      }
    }
  });
}

function stopUnlockWatcher(): void {
  if (unlockWatcherProcess) {
    unlockWatcherProcess.kill();
    unlockWatcherProcess = null;
  }
}

function buildSecurityMenu(): InlineKeyboard {
  const statusLabel = unlockGuardActive
    ? "🟢 Surveillance Unlock : ON"
    : "🔴 Surveillance Unlock : OFF";

  return new InlineKeyboard()
    .text(statusLabel, "toggle_unlock_guard")
    .row()
    .text("🚨 Alarme / Trouver mon PC", "trigger_alarm")
    .row()
    .text("🔙 Retour", "back_to_main");
}

bot.callbackQuery(
  "security_menu",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery();

    await ctx.editMessageText(
      "🛡️ **Sécurité & Anti-intrusion**\n\n" +
        "• **Surveillance Unlock** : Prend une photo webcam silencieuse dès qu'on déverrouille ta session.\n" +
        "• **Alarme** : Met le volume à 100% et fait parler le PC.",
      { reply_markup: buildSecurityMenu(), parse_mode: "Markdown" },
    );
  },
);

bot.callbackQuery(
  "toggle_unlock_guard",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    unlockGuardActive = !unlockGuardActive;

    if (unlockGuardActive) startUnlockWatcher();
    else stopUnlockWatcher();

    await ctx.answerCallbackQuery(
      unlockGuardActive
        ? "🛡️ Surveillance activée !"
        : "Surveillance désactivée",
    );
    await ctx.editMessageReplyMarkup({ reply_markup: buildSecurityMenu() });
  },
);

bot.callbackQuery(
  "trigger_alarm",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery("🚨 Alarme déclenchée à 100% !");

    setVolume(100, () => {
      const psScript = `
      Add-Type -AssemblyName System.Speech
      [console]::Beep(1200, 500)
      [console]::Beep(1600, 500)
      $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
      $synth.Volume = 100
      $synth.Speak("Alerte sécurité. Cet ordinateur est localisé à distance.")
    `;
      const encoded = Buffer.from(psScript, "utf16le").toString("base64");
      runSilent(
        "powershell",
        ["-NoProfile", "-EncodedCommand", encoded],
        () => {},
      );
    });
  },
);

// ==========================================
// 🚀 APPS & GESTIONNAIRE DE TÂCHES (RAM)
// ==========================================
bot.callbackQuery("apps_menu", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery();

  const appsMenu = new InlineKeyboard()
    .text("📊 Top 5 Processus (Tuer)", "top_procs")
    .row()
    .text("💻 VS Code", "launch_code")
    .text("🌐 Chrome", "launch_chrome")
    .row()
    .text("⬛ Terminal", "launch_wt")
    .text("📁 Explorateur", "launch_explorer")
    .row()
    .text("🔙 Retour", "back_to:menu_apps")
    .text("🏠 Retour principal", "back_to_main");

  await ctx.editMessageText(
    "🚀 **Apps & Gestionnaire de tâches**\n\nLance une app ou ferme un processus bloqué :",
    { reply_markup: appsMenu, parse_mode: "Markdown" },
  );
});

bot.callbackQuery(
  ["launch_code", "launch_chrome", "launch_wt", "launch_explorer"],
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;

    const map: Record<string, { cmd: string; label: string }> = {
      launch_code: { cmd: "code", label: "💻 VS Code lancé !" },
      launch_chrome: { cmd: "chrome", label: "🌐 Chrome lancé !" },
      launch_wt: { cmd: "wt", label: "⬛ Terminal lancé !" },
      launch_explorer: { cmd: "explorer", label: "📁 Explorateur lancé !" },
    };

    const item = map[ctx.callbackQuery.data];
    runSilent("cmd", ["/c", "start", "", item.cmd], () => {});
    await ctx.answerCallbackQuery(item.label);
  },
);

bot.callbackQuery("top_procs", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery("Analyse des processus...");

  const psScript = `
    Get-Process |
      Sort-Object WorkingSet64 -Descending |
      Select-Object -First 5 |
      ForEach-Object {
        @{ name = $_.ProcessName; pid = $_.Id; ram = [math]::Round($_.WorkingSet64 / 1MB, 0) }
      } |
      ConvertTo-Json -Compress
  `;

  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  runSilent(
    "powershell",
    ["-NoProfile", "-EncodedCommand", encoded],
    async (err, stdout) => {
      if (err) return ctx.reply("❌ Erreur lecture processus : " + err.message);

      try {
        const parsed = JSON.parse(stdout.trim());
        topProcesses = Array.isArray(parsed) ? parsed : [parsed];

        const kb = new InlineKeyboard();
        topProcesses.forEach((p: ProcessInfo, i: number) => {
          kb.text(`❌ ${p.name} (${p.ram} Mo)`, `kill_proc_${i}`).row();
        });
        kb.text("🔄 Rafraîchir", "top_procs").text("🔙 Retour", "apps_menu");

        await ctx.editMessageText(
          "📊 **Top 5 Processus gourmands en RAM**\n_(Clique sur un processus pour le fermer de force)_ :",
          { reply_markup: kb, parse_mode: "Markdown" },
        );
      } catch (parseErr) {
        await ctx.reply(
          "❌ Erreur parsing processus : " + (parseErr as Error).message,
        );
      }
    },
  );
});

bot.callbackQuery(
  /^kill_proc_(\d+)$/,
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    const proc = topProcesses[Number(ctx.match[1])];
    if (!proc) return ctx.answerCallbackQuery("⚠️ Liste expirée.");

    runSilent("taskkill", ["/F", "/PID", String(proc.pid)], async (err) => {
      if (err)
        return ctx.answerCallbackQuery("❌ Impossible de fermer (protégé)");
      await ctx.answerCallbackQuery(`💥 ${proc.name} fermé !`);
    });
  },
);

// ==========================================
// ⌨️ CLAVIER & FENÊTRES À DISTANCE
// ==========================================
bot.callbackQuery(
  "keyboard_menu",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery();

    const kbMenu = new InlineKeyboard()
      .text("🔄 Alt + Tab", "key_alttab")
      .text("🖥️ Bureau (Win+D)", "key_wind")
      .row()
      .text("❌ Fermer (Alt+F4)", "key_altf4")
      .text("🔁 Rafraîchir (F5)", "key_f5")
      .row()
      .text("↩️ Entrée", "key_enter")
      .text("⌨️ Taper du texte", "type_text_prompt")
      .row()
      .text("🔙 Retour", "back_to:menu_input")
      .text("🏠 Retour principal", "back_to_main");

    await ctx.editMessageText("⌨️ **Contrôle Clavier & Fenêtres**", {
      reply_markup: kbMenu,
      parse_mode: "Markdown",
    });
  },
);

bot.callbackQuery(
  ["key_alttab", "key_wind", "key_altf4", "key_f5", "key_enter"],
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    const action = ctx.callbackQuery.data;
    let psScript = "";

    if (action === "key_wind") {
      psScript = `
      Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }'
      [K]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
      [K]::keybd_event(0x44, 0, 0, [UIntPtr]::Zero)
      [K]::keybd_event(0x44, 0, 2, [UIntPtr]::Zero)
      [K]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
    `;
    } else {
      const keys: Record<string, string> = {
        key_alttab: "%{TAB}",
        key_altf4: "%{F4}",
        key_f5: "{F5}",
        key_enter: "{ENTER}",
      };
      psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait("${keys[action]}")
    `;
    }

    const encoded = Buffer.from(psScript, "utf16le").toString("base64");
    runSilent(
      "powershell",
      ["-STA", "-NoProfile", "-EncodedCommand", encoded],
      () => {},
    );
    await ctx.answerCallbackQuery("⌨️ Touche envoyée !");
  },
);

bot.callbackQuery(
  "type_text_prompt",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = "type_text";
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      "⌨️ **Frappe clavier à distance**\n\nEnvoie le texte dans le chat : le PC va le taper directement là où se trouve le curseur.",
      {
        reply_markup: new InlineKeyboard()
          .text("🔙 Retour", "back_to:menu_input")
          .text("🏠 Retour principal", "back_to_main"),
        parse_mode: "Markdown",
      },
    );
  },
);

// ==========================================
// 📶 RÉSEAU, WI-FI (called from menu_network)
// ==========================================
bot.callbackQuery(
  "network_menu",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery();

    const netMenu = new InlineKeyboard()
      .text("📶 Infos Wi-Fi & IP Publique", "net_info")
      .row()
      .text("🔑 Exporter Mots de passe WiFi", "wifi_export_passwords")
      .row()
      .text("🔙 Retour", "back_to:menu_network")
      .text("🏠 Retour principal", "back_to_main");

    await ctx.editMessageText("🌐 **Réseau**", {
      reply_markup: netMenu,
      parse_mode: "Markdown",
    });
  },
);

bot.callbackQuery("net_info", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery("Analyse du réseau...");

  const psScript = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $wifi = netsh wlan show interfaces | Out-String
    $ssid = if ($wifi -match "SSID\\s*:\\s*(.+)") { $matches[1].Trim() } else { "Câble Ethernet / Déconnecté" }
    $sig  = if ($wifi -match "Signal\\s*:\\s*(.+)") { $matches[1].Trim() } else { "N/A" }
    $localIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
      $_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -notlike "169.254.*"
    } | Select-Object -First 1).IPAddress
    try { $pubIp = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 4) } catch { $pubIp = "Indisponible" }
    "$ssid|$sig|$localIp|$pubIp"
  `;

  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  runSilent(
    "powershell",
    ["-NoProfile", "-EncodedCommand", encoded],
    async (err, stdout) => {
      if (err) return ctx.reply("❌ Erreur réseau : " + err.message);

      const [ssid, sig, localIp, pubIp] = stdout.trim().split("|");

      await ctx.reply(
        `📶 **ÉTAT DU RÉSEAU**\n━━━━━━━━━━━━━━━━━━━━\n` +
          `📡 **Wi-Fi :** \`${ssid}\`\n` +
          `📶 **Signal :** ${sig}\n` +
          `🏠 **IP Locale :** \`${localIp || "N/A"}\`\n` +
          `🌍 **IP Publique :** \`${pubIp}\``,
        { parse_mode: "Markdown" },
      );
    },
  );
});

bot.callbackQuery(
  "read_pc_clip",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery("Lecture du presse-papier...");

    try {
      const text = await readTextFromClipboard();

      if (!text) {
        return ctx.reply(
          "📋 Le presse-papier du PC est vide (ou contient une image/fichier).",
        );
      }

      await ctx.reply(`📋 Contenu actuel du presse-papier PC :\n\n${text}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply("❌ Erreur lecture presse-papier : " + msg);
    }
  },
);

// 🔗 Gestion des liens (Ouvrir / Copier)
bot.callbackQuery(
  /^link_open\|(.+)$/,
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery("Ouverture dans le navigateur...");
    const url = ctx.match[1];
    runSilent("cmd", ["/c", "start", "", url], () => {});
    await ctx.editMessageText(`✅ Lien ouvert dans le navigateur :\n\`${url}\``, {
      parse_mode: "Markdown",
    });
  },
);

bot.callbackQuery(
  /^link_copy\|(.+)$/,
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery("Copie dans le presse-papier...");
    const url = ctx.match[1];
    try {
      await writeTextToClipboard(url);
      await ctx.editMessageText(`✅ Lien copié dans le presse-papier :\n\`${url}\``, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.editMessageText(`❌ Erreur presse-papier : ${msg}`, {
        parse_mode: "Markdown",
      });
    }
  },
);

// 🔑 Export mots de passe WiFi (netsh wlan export profile)
bot.callbackQuery(
  "wifi_export_passwords",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery("Export des profils WiFi en cours...");

    const tempDir = path.join(os.tmpdir(), `wifi_export_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const psScript = `
    $ErrorActionPreference = "Stop"
    try {
      # Exporter les profils WiFi avec mots de passe en clair
      netsh wlan export profile folder="${tempDir.replace(/\\/g, "\\\\")}" key=clear

      # Lire tous les fichiers XML générés
      $files = Get-ChildItem -Path "${tempDir.replace(/\\/g, "\\\\")}" -Filter "Wi-Fi-*.xml"
      $results = @()

      # Configurer le gestionnaire de namespaces XML (le XML WiFi a un namespace par défaut)
      $ns = New-Object System.Xml.XmlNamespaceManager((New-Object System.Xml.XmlDocument).NameTable)
      $ns.AddNamespace("wlan", "http://www.microsoft.com/networking/WLAN/profile/v1")

      foreach ($file in $files) {
        $xml = [xml](Get-Content $file.FullName -Raw)

        # Extraire le nom SSID et le mot de passe en utilisant XPath avec namespace
        $ssidNode = $xml.SelectSingleNode("//wlan:SSID/wlan:name", $ns)
        $passwordNode = $xml.SelectSingleNode("//wlan:MSM/wlan:security/wlan:sharedKey/wlan:keyMaterial", $ns)

        if ($ssidNode -and $ssidNode.InnerText) {
          $name = $ssidNode.InnerText.Trim()
        } else {
          $name = "Inconnu"
        }

        if ($passwordNode -and $passwordNode.InnerText) {
          $password = $passwordNode.InnerText.Trim()
        } else {
          $password = "(pas de mot de passe / ouvert)"
        }

        $results += "$name|$password"
      }

      if ($results.Count -eq 0) {
        Write-Output "EMPTY"
      } else {
        $results -join "\`n"
      }
    } catch {
      Write-Output "ERROR: $($_.Exception.Message)"
    }
  `;

    const encoded = Buffer.from(psScript, "utf16le").toString("base64");
    runSilent(
      "powershell",
      ["-NoProfile", "-EncodedCommand", encoded],
      async (err, stdout) => {
        try {
          // Nettoyer le dossier temporaire
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        } catch {}

        const out = stdout?.trim() || "";

        if (err || out.startsWith("ERROR")) {
          try {
            await ctx.reply(
              "❌ Erreur export WiFi : " +
                (out.startsWith("ERROR")
                  ? out.replace("ERROR: ", "")
                  : err?.message || "inconnu"),
            );
          } catch {}
          return;
        }

        if (!out || out === "EMPTY") {
          try {
            await ctx.reply(
              "📶 Aucun profil WiFi avec mot de passe trouvé sur ce PC.",
            );
          } catch {}
          return;
        }

        // Formater le résultat
        const lines = out.split("\n").filter((l) => l.trim());
        let message =
          "🔑 **Mots de passe WiFi exportés**\n━━━━━━━━━━━━━━━━━━━━\n\n";

        for (const line of lines) {
          const parts = line.split("|");
          if (parts.length < 2) continue;
          const name = parts[0]?.trim() || "Inconnu";
          const password = parts.slice(1).join("|").trim() || "(vide)";
          message += `📶 **${name}**\n   \` ${password}\`\n\n`;
        }

        // Si trop long, envoyer en fichier
        try {
          if (message.length > 3500) {
            const filePath = path.join(
              os.tmpdir(),
              `wifi_passwords_${Date.now()}.txt`,
            );
            fs.writeFileSync(filePath, message);
            await ctx.replyWithDocument(
              new InputFile(filePath, "wifi_passwords.txt"),
              {
                caption: "🔑 Mots de passe WiFi (fichier texte)",
              },
            );
            fs.unlinkSync(filePath);
          } else {
            await ctx.reply(message, { parse_mode: "Markdown" });
          }
        } catch (replyErr) {
          // Fallback: essayer sans Markdown
          try {
            await ctx.reply(message);
          } catch {}
        }
      },
    );
  },
);

// ==========================================
// 🗂️ EXPLORATEUR DE FICHIERS PC (A:\ à Z:\ + 6 Dossiers Principaux)
// ==========================================
let currentPath = os.homedir();
let currentItems: Array<{ name: string; isDir: boolean; fullPath: string }> =
  [];
const ITEMS_PER_PAGE = 10;

function renderExplorer(
  dirPath: string,
  page = 0,
): { text: string; keyboard: InlineKeyboard } {
  currentPath = dirPath;

  const rawEntries = fs.readdirSync(dirPath, { withFileTypes: true });
  const dirs: Array<{ name: string; isDir: true; fullPath: string }> = [];
  const files: Array<{ name: string; isDir: false; fullPath: string }> = [];

  for (const entry of rawEntries) {
    try {
      const fullPath = path.join(dirPath, entry.name);
      fs.accessSync(fullPath, fs.constants.R_OK);
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, isDir: true, fullPath });
      } else {
        files.push({ name: entry.name, isDir: false, fullPath });
      }
    } catch {
      // Ignore les éléments système verrouillés
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  currentItems = [...dirs, ...files];

  const totalPages = Math.max(
    1,
    Math.ceil(currentItems.length / ITEMS_PER_PAGE),
  );
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = currentItems.slice(
    safePage * ITEMS_PER_PAGE,
    (safePage + 1) * ITEMS_PER_PAGE,
  );

  const kb = new InlineKeyboard();

  const parentDir = path.dirname(dirPath);
  if (parentDir !== dirPath) kb.text("⬆️ Parent", "exp_up");
  kb.text("🏠 Profil", "exp_home");

  for (const letter of getAvailableDrives()) {
    kb.text(`💽 ${letter}:`, `exp_drive_${letter}`);
  }
  kb.row();

  kb.text("🖥️ Bureau", "exp_quick_desktop")
    .text("📥 Télécharg.", "exp_quick_downloads")
    .text("📄 Documents", "exp_quick_documents")
    .row()
    .text("🖼️ Images", "exp_quick_pictures")
    .text("🎵 Musique", "exp_quick_music")
    .text("🎬 Vidéos", "exp_quick_videos")
    .row();

  slice.forEach((item, idx) => {
    const globalIndex = safePage * ITEMS_PER_PAGE + idx;
    const icon = item.isDir ? "📁" : "📄";
    const label =
      item.name.length > 28 ? item.name.slice(0, 25) + "..." : item.name;
    kb.text(`${icon} ${label}`, `exp_open_${globalIndex}`).row();
  });

  if (totalPages > 1) {
    if (safePage > 0) kb.text("⬅️ Préc.", `exp_page_${safePage - 1}`);
    kb.text(`${safePage + 1}/${totalPages}`, "noop");
    if (safePage < totalPages - 1)
      kb.text("Suiv. ➡️", `exp_page_${safePage + 1}`);
    kb.row();
  }

  kb.text("🔙 Menu Principal", "back_to_main");

  return {
    text: `🗂️ **Explorateur PC**\n📍 \`${dirPath}\`\n_(Dossier = ouvrir • Fichier = télécharger)_`,
    keyboard: kb,
  };
}

bot.command("cd", async (ctx: Context) => {
  pendingAction = null;
  const match = ctx.match;
  const target = typeof match === "string" ? match.trim() : match?.[0]?.trim();
  if (!target) {
    return ctx.reply("⚠️ Précise un chemin, ex : `/cd C:\\Users`", {
      parse_mode: "Markdown",
    });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return ctx.reply("❌ Dossier introuvable : `" + target + "`", {
      parse_mode: "Markdown",
    });
  }
  const view = renderExplorer(target, 0);
  await ctx.reply(view.text, {
    reply_markup: view.keyboard,
    parse_mode: "Markdown",
  });
});

bot.callbackQuery(
  "explore_init",
  async (ctx: CallbackQueryContext<Context>) => {
    pendingAction = null;
    await ctx.answerCallbackQuery();
    const view = renderExplorer(currentPath, 0);
    await ctx.editMessageText(view.text, {
      reply_markup: view.keyboard,
      parse_mode: "Markdown",
    });
  },
);

bot.callbackQuery("exp_up", async (ctx: CallbackQueryContext<Context>) => {
  await ctx.answerCallbackQuery();
  const view = renderExplorer(path.dirname(currentPath), 0);
  await ctx.editMessageText(view.text, {
    reply_markup: view.keyboard,
    parse_mode: "Markdown",
  });
});

bot.callbackQuery("exp_home", async (ctx: CallbackQueryContext<Context>) => {
  await ctx.answerCallbackQuery();
  const view = renderExplorer(os.homedir(), 0);
  await ctx.editMessageText(view.text, {
    reply_markup: view.keyboard,
    parse_mode: "Markdown",
  });
});

bot.callbackQuery(
  /^exp_drive_([A-Z])$/,
  async (ctx: CallbackQueryContext<Context>) => {
    await ctx.answerCallbackQuery();
    const drive = `${ctx.match[1]}:\\`;
    if (!fs.existsSync(drive))
      return ctx.answerCallbackQuery("❌ Disque introuvable.");
    const view = renderExplorer(drive, 0);
    await ctx.editMessageText(view.text, {
      reply_markup: view.keyboard,
      parse_mode: "Markdown",
    });
  },
);

bot.callbackQuery(
  /^exp_quick_(desktop|downloads|documents|pictures|music|videos)$/,
  async (ctx: CallbackQueryContext<Context>) => {
    await ctx.answerCallbackQuery();
    const targetDir = QUICK_FOLDERS[ctx.match[1]];
    if (!targetDir || !fs.existsSync(targetDir)) {
      return ctx.answerCallbackQuery("❌ Dossier introuvable.");
    }
    const view = renderExplorer(targetDir, 0);
    await ctx.editMessageText(view.text, {
      reply_markup: view.keyboard,
      parse_mode: "Markdown",
    });
  },
);

bot.callbackQuery(
  /^exp_page_(\d+)$/,
  async (ctx: CallbackQueryContext<Context>) => {
    await ctx.answerCallbackQuery();
    const view = renderExplorer(currentPath, Number(ctx.match[1]));
    await ctx.editMessageText(view.text, {
      reply_markup: view.keyboard,
      parse_mode: "Markdown",
    });
  },
);

bot.callbackQuery("noop", (ctx: CallbackQueryContext<Context>) =>
  ctx.answerCallbackQuery(),
);

bot.callbackQuery(
  /^exp_open_(\d+)$/,
  async (ctx: CallbackQueryContext<Context>) => {
    const item = currentItems[Number(ctx.match[1])];
    if (!item)
      return ctx.answerCallbackQuery(
        "⚠️ Élément expiré, rafraîchis le dossier.",
      );

    if (item.isDir) {
      await ctx.answerCallbackQuery();
      try {
        const view = renderExplorer(item.fullPath, 0);
        await ctx.editMessageText(view.text, {
          reply_markup: view.keyboard,
          parse_mode: "Markdown",
        });
      } catch {
        await ctx.answerCallbackQuery("❌ Accès refusé à ce dossier.");
      }
    } else {
      const stats = fs.statSync(item.fullPath);
      const sizeMB = stats.size / (1024 * 1024);

      if (sizeMB > 50) {
        return ctx.answerCallbackQuery(
          `❌ Trop lourd (${sizeMB.toFixed(1)} Mo > 50 Mo max)`,
        );
      }
      if (stats.size === 0) {
        return ctx.answerCallbackQuery("⚠️ Fichier vide (0 octet).");
      }

      await ctx.answerCallbackQuery(`📤 Envoi de ${item.name}...`);
      try {
        await ctx.replyWithDocument(new InputFile(item.fullPath), {
          caption: `📄 \`${item.fullPath}\` (${sizeMB.toFixed(2)} Mo)`,
          parse_mode: "Markdown",
        });
      } catch (err) {
        await ctx.reply("❌ Erreur d'envoi : " + (err as Error).message);
      }
    }
  },
);

// 📂 Ouvrir le dossier Téléchargements\Telegram-Bot sur le PC
bot.callbackQuery("open_folder", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  const downloadDir = path.join(os.homedir(), "Downloads", "Telegram-Bot");
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }
  execFile("explorer", [downloadDir]);
  await ctx.answerCallbackQuery("📂 Dossier ouvert sur le PC !");
});

// 🔄 Redémarrer le bot via PM2 avec rebuild (compile TS puis restart)
bot.callbackQuery("restart_bot", async (ctx: CallbackQueryContext<Context>) => {
  pendingAction = null;
  await ctx.answerCallbackQuery("🔄 Rebuild + redémarrage...");
  await ctx.reply(
    "🔨 Compilation TypeScript en cours...\n♻️ Puis redémarrage PM2...",
  );

  // Run pnpm build first, then pm2 restart
  const { spawn } = await import("child_process");
  const buildProcess = spawn("pnpm", ["build"], {
    cwd: process.cwd(),
    shell: true,
    windowsHide: true,
  });

  buildProcess.stdout.on("data", (data) => {
    console.log(`[build] ${data}`);
  });

  buildProcess.stderr.on("data", (data) => {
    console.error(`[build] ${data}`);
  });

  buildProcess.on("close", (code) => {
    if (code === 0) {
      console.log("[restart] Build successful, restarting PM2...");
      const restartProcess = spawn(
        "pm2",
        ["restart", "z-ctrl", "--update-env"],
        {
          cwd: process.cwd(),
          shell: true,
          windowsHide: true,
        },
      );
      restartProcess.on("close", () => {
        process.exit(0);
      });
    } else {
      console.error(`[restart] Build failed with code ${code}`);
      ctx
        .reply(`❌ Build échoué (code ${code}). Redémarrage annulé.`)
        .catch(() => {});
      // Don't exit, let the bot continue running
    }
  });
});

// ==========================================
// 📥 AIRDROP MAISON & SAISIES EN ATTENTE
// ==========================================
bot.on("message:text", async (ctx: Context) => {
  if (!ctx.message || !ctx.message.text) return;
  const rawText = ctx.message.text;
  const text = rawText.trim();
  if (text.startsWith("/")) return;

  // 1️⃣ PRIORITÉ : Frappe clavier à distance (accepte TOUT texte)
  if (pendingAction === "type_text") {
    pendingAction = null;
    try {
      // Copy to clipboard using robust module (with retry)
      await writeTextToClipboard(rawText);

      // Then paste via SendKeys (PowerShell for SendKeys only)
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        Start-Sleep -Milliseconds 100
        [System.Windows.Forms.SendKeys]::SendWait("^v")
      `;
      const encoded = Buffer.from(psScript, "utf16le").toString("base64");

      runSilent(
        "powershell",
        ["-STA", "-NoProfile", "-EncodedCommand", encoded],
        async (err) => {
          if (err) {
            const msg = err.message || "";
            if (
              msg.includes("Accès refusé") ||
              msg.includes("Access denied") ||
              msg.includes("SendWait")
            ) {
              return ctx.reply(
                "🔒 **Impossible : PC verrouillé (Secure Desktop)**\n\n" +
                  "Windows bloque la saisie à distance sur l'écran de verrouillage.\n\n" +
                  "✅ **Actions dispo via le bot :**\n" +
                  "• 💤 Veille\n" +
                  "• 🛑 Éteindre (délai)\n" +
                  "• ❌ Annuler extinction\n" +
                  "• 💡 Allumer l'écran",
                { parse_mode: "Markdown", reply_markup: getMainMenu() },
              );
            }
            return ctx.reply("❌ Erreur frappe clavier : " + msg);
          }
          await ctx.reply("⌨️ Texte tapé sur le PC !", {
            reply_markup: getMainMenu(),
          });
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply("❌ Erreur presse-papier : " + msg);
    }
    return;
  }

  // 2️⃣ PRIORITÉ : Volume en attente (0 à 100)
  if (pendingAction === "volume") {
    const volMatch = text.match(/^(\d{1,3})\s*%?$/);
    if (volMatch) {
      pendingAction = null;
      // Conversion stricte en entier pour éviter tout arrondi (ex: 35 → 35, pas 36)
      const val = Math.max(0, Math.min(100, Math.floor(Number(volMatch[1]))));
      setVolume(val, async (err) => {
        if (err) await ctx.reply("❌ Erreur volume : " + err.message);
      });
      await ctx.reply(`🔊 Volume réglé à **${val}%** !`, {
        reply_markup: buildAudioMenu(),
        parse_mode: "Markdown",
      });
      return;
    }
  }

  // 3️⃣ PRIORITÉ : Luminosité en attente (0 à 100)
  if (pendingAction === "brightness") {
    const brightMatch = text.match(/^(\d{1,3})\s*%?$/);
    if (brightMatch) {
      pendingAction = null;
      // Conversion stricte en entier pour éviter tout arrondi (ex: 35 → 35, pas 36)
      const val = Math.max(
        0,
        Math.min(100, Math.floor(Number(brightMatch[1]))),
      );
      setBrightness(val, async (err) => {
        if (err) await ctx.reply("❌ Erreur luminosité : " + err.message);
      });
      await ctx.reply(`☀️ Luminosité réglée à **${val}%** !`, {
        reply_markup: buildDisplayMenu(),
        parse_mode: "Markdown",
      });
      return;
    }
  }

  // 4️⃣ PRIORITÉ : Durée en attente (record_screen, webcam_video, shutdown)
  if (
    pendingAction &&
    ["record_screen", "webcam_video", "shutdown"].includes(pendingAction)
  ) {
    const durationMatch = text.match(
      /^(\d+(?:[.,]\d+)?)\s*(s|sec|secondes?|m|min|minutes?|h|heures?|j|jours?|d|days?)?$/i,
    );
    if (durationMatch) {
      const action = pendingAction;
      pendingAction = null;

      const value = parseFloat(durationMatch[1].replace(",", "."));
      const unit = (durationMatch[2] || "s").toLowerCase();

      let multiplier = 1;
      if (unit.startsWith("m")) multiplier = 60;
      else if (unit.startsWith("h")) multiplier = 3600;
      else if (unit.startsWith("j") || unit.startsWith("d")) multiplier = 86400;

      const totalSeconds = Math.round(value * multiplier);
      await runTimedAction(ctx, action, totalSeconds);
      return;
    }
  }

  // Réinitialise une éventuelle action en attente
  pendingAction = null;

  // 5️⃣ SINON : Détection lien -> boutons interactifs (Ouvrir / Copier)
  const urlRegex = /^https?:\/\/\S+$/i;
  if (urlRegex.test(text)) {
    const linkKeyboard = new InlineKeyboard()
      .text("🌐 Ouvrir dans le navigateur", `link_open|${text}`)
      .text("📋 Copier dans presse-papier", `link_copy|${text}`)
      .row()
      .text("❌ Annuler", "back_to_main");

    await ctx.reply(`🔗 **Lien détecté**\n\`${text}\`\n\nQue faire ?`, {
      reply_markup: linkKeyboard,
      parse_mode: "Markdown",
    });
  } else {
    // Texte normal -> copie dans presse-papier
    try {
      await writeTextToClipboard(rawText);
      await ctx.reply(
        "📋 Texte et emojis copiés dans le presse-papier (Ctrl+V prêt) !",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply("❌ Erreur presse-papier : " + msg);
    }
  }
});

// 🖼️ Photos -> Presse-papier Windows
bot.on("message:photo", async (ctx: Context) => {
  if (!ctx.message || !ctx.message.photo) return;
  pendingAction = null;
  try {
    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    const file = await ctx.api.getFile(bestPhoto.file_id);

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    const tempPath = path.join(os.tmpdir(), `tg_clip_${Date.now()}.png`);
    fs.writeFileSync(tempPath, buffer);

    try {
      await writeImageToClipboard(tempPath);
      await ctx.reply(
        "🖼️ Image copiée dans le presse-papier du PC (Ctrl + V prêt) !",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply("❌ Erreur presse-papier : " + msg);
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  } catch (err) {
    await ctx.reply(
      "❌ Impossible de récupérer l'image : " + (err as Error).message,
    );
  }
});

// 📁 Fichiers / Documents -> Téléchargements\Telegram-Bot
bot.on("message:document", async (ctx: Context) => {
  if (!ctx.message || !ctx.message.document) return;
  pendingAction = null;
  try {
    const doc = ctx.message.document;
    const file = await ctx.api.getFile(doc.file_id);

    const downloadDir = path.join(os.homedir(), "Downloads", "Telegram-Bot");
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    const rawFileName = doc.file_name || `fichier_${Date.now()}`;
    // Sanitize filename to prevent path traversal
    const fileName = path
      .basename(rawFileName)
      .replace(/[^a-zA-Z0-9._-]/g, "_");
    const savePath = path.join(downloadDir, fileName);
    fs.writeFileSync(savePath, buffer);

    if (doc.mime_type?.startsWith("image/")) {
      try {
        await writeImageToClipboard(savePath);
        await ctx.reply(
          `📥 Image HD sauvegardée dans \`Downloads\\Telegram-Bot\\${fileName}\` et copiée dans le presse-papier !`,
          { parse_mode: "Markdown" },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(
          `📥 Image HD sauvegardée dans \`Downloads\\Telegram-Bot\\${fileName}\`\n⚠️ Erreur copie presse-papier : ${msg}`,
          { parse_mode: "Markdown" },
        );
      }
    } else {
      await ctx.reply(
        `📥 Fichier sauvegardé dans :\n\`Downloads\\Telegram-Bot\\${fileName}\``,
        { parse_mode: "Markdown" },
      );
    }
  } catch (err) {
    await ctx.reply(
      "❌ Erreur lors du téléchargement : " + (err as Error).message,
    );
  }
});

// 🛡️ Rend le bot résistant aux coupures réseau
bot.catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  // Masque le token dans les logs
  const safe = msg.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***:***");
  console.error("⚠️ Bot error (recoverable) :", safe);
});

// Ne crash pas sur les erreurs réseau transitoires
process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const safe = msg.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***:***");
  console.error("⚠️ Unhandled rejection :", safe);
});

// Ne crash pas non plus sur les erreurs non catch
process.on("uncaughtException", (err) => {
  const msg = String(err?.message || err).replace(
    /bot\d+:[A-Za-z0-9_-]+/g,
    "bot***:***",
  );
  console.error("⚠️ Uncaught exception :", msg);
});

// 🚀 DÉMARRAGE + AUTO-DÉTECTION MATÉRIEL + MENU COMMANDES & PANNEAU
bot.start({
  drop_pending_updates: true,
  onStart: async () => {
    await detectMediaDevices();
    console.log("🚀 Télécommande PC active !");
    try {
      await bot.api.setMyCommands([
        { command: "pc", description: "Ouvrir la télécommande PC" },
        {
          command: "cd",
          description: "Ouvrir un dossier (ex: /cd D:\\Projets)",
        },
        { command: "help", description: "Afficher le guide des commandes" },
      ]);

      await bot.api.sendMessage(
        MON_ID,
        `🟢 **PC en ligne / Bot redémarré !**\n📷 Caméra : \`${WEBCAM_NAME || "Aucune"}\`\n🎙️ Micro : \`${AUDIO_NAME || "Aucun"}\`\n\n🖥️ **Télécommande PC Windows**`,
        {
          reply_markup: getMainMenu(),
          parse_mode: "Markdown",
        },
      );
    } catch (err) {
      console.error(
        "Impossible d'envoyer le menu au démarrage :",
        (err as Error).message,
      );
    }
  },
});
