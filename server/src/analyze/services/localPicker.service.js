import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PICKER_TIMEOUT_MS = 20000;

function createError(message, statusCode = 500) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function commandExists(command, args = ['--version']) {
  try {
    await execFileAsync(command, args, {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function runPickerCommand(command, args, { windowsHide = true } = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      windowsHide,
      maxBuffer: 1024 * 1024,
      timeout: PICKER_TIMEOUT_MS,
    });

    const selectedPath = (stdout || '').trim();

    if (!selectedPath) {
      throw createError('Folder selection was canceled.', 400);
    }

    return selectedPath;
  } catch (err) {
    if (err?.statusCode) throw err;
    if (err?.code === 'ETIMEDOUT') {
      throw createError('Folder picker timed out. Please try again.', 408);
    }
    throw err;
  }
}

export async function getLocalPickerCapabilities() {
  if (process.platform === 'win32') {
    return {
      supported: true,
      platform: process.platform,
      provider: 'powershell-winforms',
      message: 'Native folder picker is available.',
    };
  }

  if (process.platform === 'darwin') {
    return {
      supported: true,
      platform: process.platform,
      provider: 'osascript',
      message: 'Native folder picker is available.',
    };
  }

  if (process.platform === 'linux') {
    const hasZenity = await commandExists('zenity', ['--version']);
    if (hasZenity) {
      return {
        supported: true,
        platform: process.platform,
        provider: 'zenity',
        message: 'Native folder picker is available.',
      };
    }

    const hasKDialog = await commandExists('kdialog', ['--version']);
    if (hasKDialog) {
      return {
        supported: true,
        platform: process.platform,
        provider: 'kdialog',
        message: 'Native folder picker is available.',
      };
    }

    return {
      supported: false,
      platform: process.platform,
      provider: null,
      message: 'Native folder picker is unavailable (install zenity or kdialog), paste an absolute path manually.',
    };
  }

  return {
    supported: false,
    platform: process.platform,
    provider: null,
    message: 'Native folder picker is unavailable on this OS, paste an absolute path manually.',
  };
}

async function pickWindowsDirectory() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    "$owner.Text = 'PolyGlot Folder Picker'",
    '$owner.TopMost = $true',
    '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
    '$owner.ShowInTaskbar = $false',
    '$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
    '$null = $owner.Show()',
    '$owner.Activate()',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = 'Select a local repository folder'",
    '$dialog.ShowNewFolderButton = $false',
    '$result = $dialog.ShowDialog($owner)',
    '$owner.Close()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  Write-Output $dialog.SelectedPath',
    '}',
  ].join('\n');

  return runPickerCommand('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    windowsHide: false,
  });
}

async function pickMacDirectory() {
  const script = 'POSIX path of (choose folder with prompt "Select a local repository folder")';
  const selectedPath = await runPickerCommand('osascript', ['-e', script]);
  return selectedPath.replace(/\/$/, '');
}

async function pickLinuxDirectory() {
  const hasZenity = await commandExists('zenity', ['--version']);
  if (hasZenity) {
    return runPickerCommand('zenity', [
      '--file-selection',
      '--directory',
      '--title=Select a local repository folder',
    ]);
  }

  const hasKDialog = await commandExists('kdialog', ['--version']);
  if (hasKDialog) {
    const selectedPath = await runPickerCommand('kdialog', [
      '--getexistingdirectory',
      '.',
      '--title',
      'Select a local repository folder',
    ]);
    return selectedPath.replace(/\/$/, '');
  }

  throw createError(
    'Native folder picker is unavailable on Linux (install zenity or kdialog), paste an absolute path manually.',
    501,
  );
}

export async function pickLocalDirectory() {
  if (process.platform === 'win32') {
    return pickWindowsDirectory();
  }

  if (process.platform === 'darwin') {
    return pickMacDirectory();
  }

  if (process.platform === 'linux') {
    return pickLinuxDirectory();
  }

  throw createError('Native folder picker is unavailable on this OS, paste an absolute path manually.', 501);
}
