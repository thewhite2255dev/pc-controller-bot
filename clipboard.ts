import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Robust Clipboard Module for Windows
 * - Retry pattern with exponential backoff
 * - Uses native clip.exe for text (fast, no PowerShell overhead)
 * - Uses PowerShell scripts on disk for images/files
 * - Thread-safe with isWriting flag to avoid watcher conflicts
 */

// Global flag to pause watcher during write operations
let isWriting = false;

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute PowerShell script from file (avoids -EncodedCommand issues)
 */
async function runPsScript(scriptPath: string, args: string[] = []): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args], { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        // Filter out CLIXML progress noise
        const cleanStderr = stderr?.replace(/<[^>]+>/g, "").trim() || "";
        return reject(new Error(cleanStderr || err.message));
      }
      resolve({ stdout: stdout?.trim() || "", stderr: stderr?.trim() || "" });
    });
  });
}

/**
 * Write text to clipboard using clip.exe (native, fast, supports Unicode/emojis via UTF-16LE stdin)
 * With retry pattern: 10 attempts, 50-100ms delay
 */
export async function writeTextToClipboard(text: string): Promise<void> {
  const maxAttempts = 10;
  const baseDelay = 50; // ms

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Use clip.exe with stdin - native Windows utility, supports emojis via UTF-16LE
      await new Promise<void>((resolve, reject) => {
        const proc = execFile("cmd", ["/c", "clip"], { windowsHide: true }, (err) => {
          if (err) return reject(err);
          resolve();
        });

        // Write UTF-16LE to stdin (clip.exe expects UTF-16LE, supports all Unicode/emojis)
        const buffer = Buffer.from(text, "utf16le");
        proc.stdin?.write(buffer);
        proc.stdin?.end();
      });

      return; // Success
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Check if it's a clipboard lock error
      const isLockError = msg.includes("Access denied") ||
                          msg.includes("Accès refusé") ||
                          msg.includes("CLIPBRD_E_CANT_OPEN") ||
                          msg.includes("OpenClipboard");

      if (attempt === maxAttempts || !isLockError) {
        throw new Error(`Échec écriture presse-papier après ${attempt} tentative(s): ${msg}`);
      }

      // Exponential backoff: 50ms, 75ms, 112ms, 168ms, 252ms, 378ms, 567ms, 850ms, 1275ms, 1912ms
      const delay = Math.floor(baseDelay * Math.pow(1.5, attempt - 1));
      await sleep(Math.min(delay, 2000)); // Cap at 2 seconds
    }
  }
}

/**
 * Read text from clipboard using PowerShell with retry
 * With retry pattern: 10 attempts, 50-100ms delay
 */
export async function readTextFromClipboard(): Promise<string> {
  const maxAttempts = 10;
  const baseDelay = 50; // ms

  // Use a pre-written PowerShell script for reading
  const scriptPath = path.join(__dirname, "scripts", "clipboard_read.ps1");

  // Ensure script exists
  if (!fs.existsSync(scriptPath)) {
    await ensureClipboardScripts();
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { stdout } = await runPsScript(scriptPath);

      if (stdout === "__EMPTY__" || !stdout) {
        return ""; // Empty clipboard or no text
      }

      return stdout;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Check if it's a clipboard lock error
      const isLockError = msg.includes("Access denied") ||
                          msg.includes("Accès refusé") ||
                          msg.includes("CLIPBRD_E_CANT_OPEN") ||
                          msg.includes("OpenClipboard") ||
                          msg.includes("ExternalException");

      if (attempt === maxAttempts || !isLockError) {
        throw new Error(`Échec lecture presse-papier après ${attempt} tentative(s): ${msg}`);
      }

      // Exponential backoff
      const delay = Math.floor(baseDelay * Math.pow(1.5, attempt - 1));
      await sleep(Math.min(delay, 2000));
    }
  }

  return ""; // Should not reach here
}

/**
 * Write image to clipboard using PowerShell script on disk
 * With retry pattern
 */
export async function writeImageToClipboard(imagePath: string): Promise<void> {
  const maxAttempts = 10;
  const baseDelay = 50; // ms

  const scriptPath = path.join(__dirname, "scripts", "clipboard_write_image.ps1");

  // Ensure script exists
  if (!fs.existsSync(scriptPath)) {
    await ensureClipboardScripts();
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Set writing flag to pause watcher
      isWriting = true;

      await runPsScript(scriptPath, [imagePath]);

      isWriting = false;
      return; // Success
    } catch (err) {
      isWriting = false;
      const msg = err instanceof Error ? err.message : String(err);

      const isLockError = msg.includes("Access denied") ||
                          msg.includes("Accès refusé") ||
                          msg.includes("CLIPBRD_E_CANT_OPEN") ||
                          msg.includes("OpenClipboard") ||
                          msg.includes("ExternalException");

      if (attempt === maxAttempts || !isLockError) {
        throw new Error(`Échec écriture image presse-papier après ${attempt} tentative(s): ${msg}`);
      }

      const delay = Math.floor(baseDelay * Math.pow(1.5, attempt - 1));
      await sleep(Math.min(delay, 2000));
    }
  }
}

/**
 * Write file paths to clipboard (for file copy/paste)
 * With retry pattern
 */
export async function writeFilesToClipboard(filePaths: string[]): Promise<void> {
  const maxAttempts = 10;
  const baseDelay = 50; // ms

  const scriptPath = path.join(__dirname, "scripts", "clipboard_write_files.ps1");

  // Ensure script exists
  if (!fs.existsSync(scriptPath)) {
    await ensureClipboardScripts();
  }

  // Create a temp file with the list of paths
  const listPath = path.join(os.tmpdir(), `clip_files_${Date.now()}.txt`);
  fs.writeFileSync(listPath, filePaths.join("\n"), "utf8");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      isWriting = true;

      await runPsScript(scriptPath, [listPath]);

      isWriting = false;

      // Clean up temp file
      try { fs.unlinkSync(listPath); } catch {}

      return; // Success
    } catch (err) {
      isWriting = false;
      const msg = err instanceof Error ? err.message : String(err);

      const isLockError = msg.includes("Access denied") ||
                          msg.includes("Accès refusé") ||
                          msg.includes("CLIPBRD_E_CANT_OPEN") ||
                          msg.includes("OpenClipboard") ||
                          msg.includes("ExternalException");

      if (attempt === maxAttempts || !isLockError) {
        try { fs.unlinkSync(listPath); } catch {}
        throw new Error(`Échec écriture fichiers presse-papier après ${attempt} tentative(s): ${msg}`);
      }

      const delay = Math.floor(baseDelay * Math.pow(1.5, attempt - 1));
      await sleep(Math.min(delay, 2000));
    }
  }
}

/**
 * Check if clipboard contains text (non-blocking, fast)
 */
export async function clipboardHasText(): Promise<boolean> {
  try {
    const text = await readTextFromClipboard();
    return text.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the isWriting flag status (for watcher coordination)
 */
export function getIsWriting(): boolean {
  return isWriting;
}

/**
 * Ensure PowerShell scripts exist on disk
 */
async function ensureClipboardScripts(): Promise<void> {
  const scriptsDir = path.join(__dirname, "scripts");
  if (!fs.existsSync(scriptsDir)) {
    fs.mkdirSync(scriptsDir, { recursive: true });
  }

  // clipboard_read.ps1 - Read text from clipboard
  const readScript = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Force UTF-8 output encoding for emoji/special character support
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

try {
  if ([System.Windows.Forms.Clipboard]::ContainsText()) {
    $text = [System.Windows.Forms.Clipboard]::GetText()
    if ($text -and $text.Trim()) {
      Write-Output $text
      exit 0
    }
  }
  Write-Output "__EMPTY__"
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`;

  // clipboard_write_image.ps1 - Write image to clipboard
  const writeImageScript = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
param([string]$ImagePath)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

try {
  $img = [System.Drawing.Image]::FromFile($ImagePath)
  [System.Windows.Forms.Clipboard]::SetImage($img)
  $img.Dispose()
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`;

  // clipboard_write_files.ps1 - Write file list to clipboard
  const writeFilesScript = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
param([string]$ListPath)

Add-Type -AssemblyName System.Windows.Forms

try {
  $paths = Get-Content $ListPath -Raw -Encoding UTF8
  $files = $paths.Split("\`n", [StringSplitOptions]::RemoveEmptyEntries)

  $dataObj = New-Object System.Windows.Forms.DataObject
  $dataObj.SetFileDropList($files)
  [System.Windows.Forms.Clipboard]::SetDataObject($dataObj, $true)

  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`;

  fs.writeFileSync(path.join(scriptsDir, "clipboard_read.ps1"), readScript, "utf8");
  fs.writeFileSync(path.join(scriptsDir, "clipboard_write_image.ps1"), writeImageScript, "utf8");
  fs.writeFileSync(path.join(scriptsDir, "clipboard_write_files.ps1"), writeFilesScript, "utf8");
}

// Initialize scripts on module load
ensureClipboardScripts().catch(console.error);

export { isWriting };