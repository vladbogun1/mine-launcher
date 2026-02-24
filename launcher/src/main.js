const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { createWriteStream } = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const https = require('https');
const { Client, Authenticator } = require('minecraft-launcher-core');

const launcher = new Client();
const appState = {
  manifest: null,
  root: path.join(app.getPath('home'), '.mine-launcher'),
  logLines: []
};

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  appState.logLines.push(line);
  if (appState.logLines.length > 200) appState.logLines.shift();
  BrowserWindow.getAllWindows().forEach((win) => win.webContents.send('log', line));
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('fetch-manifest', async (_event, apiUrl) => {
  log(`Fetching manifest from ${apiUrl}`);
  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`API request failed with ${response.status}`);
  }
  appState.manifest = await response.json();
  return appState.manifest;
});

ipcMain.handle('get-logs', async () => appState.logLines);

ipcMain.handle('sync-files', async () => {
  if (!appState.manifest) throw new Error('Manifest is not loaded.');
  await fs.mkdir(appState.root, { recursive: true });
  const targets = [
    ...appState.manifest.mods.map((x) => ({ ...x, targetPath: `mods/${path.basename(x.file || x.name)}` })),
    ...appState.manifest.configs.map((x) => ({ ...x, targetPath: x.path })),
    ...appState.manifest.resourcePacks.map((x) => ({ ...x, targetPath: `resourcepacks/${path.basename(x.file || x.name)}` }))
  ];

  let index = 0;
  for (const item of targets) {
    index += 1;
    const absolutePath = path.join(appState.root, item.targetPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    const needsDownload = !(await existsAndMatchHash(absolutePath, item.sha256));
    if (needsDownload) {
      log(`Downloading ${item.url}`);
      await downloadFile(item.url, absolutePath);
      const valid = await existsAndMatchHash(absolutePath, item.sha256);
      if (!valid) {
        throw new Error(`SHA256 mismatch for ${item.targetPath}`);
      }
      log(`Downloaded and verified ${item.targetPath}`);
    } else {
      log(`Already up-to-date: ${item.targetPath}`);
    }

    BrowserWindow.getAllWindows().forEach((win) =>
      win.webContents.send('sync-progress', { current: index, total: targets.length, file: item.targetPath })
    );
  }

  return { root: appState.root, total: targets.length };
});

ipcMain.handle('launch-game', async () => {
  if (!appState.manifest) throw new Error('Manifest is not loaded.');

  const javaPath = await ensureJava(appState.manifest.javaVersion || '17');
  const versionNumber = appState.manifest.minecraftVersion;

  const options = {
    authorization: Authenticator.getAuth('MineLauncherPlayer'),
    root: appState.root,
    version: {
      number: versionNumber,
      type: 'release'
    },
    memory: {
      max: '4G',
      min: '2G'
    },
    javaPath,
    server: appState.manifest.autoConnect
      ? { ip: appState.manifest.autoConnect.host, port: appState.manifest.autoConnect.port }
      : undefined,
    overrides: {
      detached: false
    }
  };

  log(`Launching Minecraft ${versionNumber} with Java ${javaPath}`);
  launcher.launch(options);

  launcher.on('debug', (line) => log(`[MC] ${line}`));
  launcher.on('data', (line) => log(`[MC] ${line}`));

  return { started: true };
});

async function existsAndMatchHash(filePath, expectedHash) {
  try {
    const data = await fs.readFile(filePath);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    return hash.toLowerCase() === (expectedHash || '').toLowerCase();
  } catch {
    return false;
  }
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(destination);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}, status=${res.statusCode}`));
        return;
      }

      res.pipe(output);
      output.on('finish', () => {
        output.close();
        resolve();
      });
    }).on('error', reject);
  });
}

async function ensureJava(javaVersion) {
  const javaHome = path.join(appState.root, 'java', `jdk-${javaVersion}`);
  const executable = process.platform === 'win32'
    ? path.join(javaHome, 'bin', 'java.exe')
    : path.join(javaHome, 'bin', 'java');

  try {
    await fs.access(executable);
    return executable;
  } catch {
    log(`Java ${javaVersion} not found locally, downloading Temurin...`);
  }

  if (process.platform !== 'win32') {
    log('Automatic Java install currently implemented for Windows. Falling back to system java.');
    return 'java';
  }

  await fs.mkdir(path.dirname(javaHome), { recursive: true });
  const archivePath = path.join(appState.root, `jdk-${javaVersion}.zip`);
  const api = `https://api.adoptium.net/v3/binary/latest/${javaVersion}/ga/windows/x64/jdk/hotspot/normal/eclipse`;
  await downloadFile(api, archivePath);

  const zip = new AdmZip(archivePath);
  zip.extractAllTo(path.dirname(javaHome), true);
  const extractedDir = zip.getEntries()[0].entryName.split('/')[0];
  await fs.rm(javaHome, { recursive: true, force: true });
  await fs.rename(path.join(path.dirname(javaHome), extractedDir), javaHome);
  await fs.rm(archivePath, { force: true });

  return executable;
}
