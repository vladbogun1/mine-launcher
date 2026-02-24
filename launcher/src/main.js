const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { createWriteStream } = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const https = require('https');
const http = require('http');
const { Client, Authenticator } = require('minecraft-launcher-core');

const launcher = new Client();
const appState = {
  manifests: {},
  root: path.join(app.getPath('home'), '.mine-launcher'),
  logLines: []
};

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  appState.logLines.push(line);
  if (appState.logLines.length > 500) appState.logLines.shift();
  BrowserWindow.getAllWindows().forEach((win) => win.webContents.send('log', line));
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
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

function buildsFilePath() {
  return path.join(appState.root, 'builds.json');
}

async function loadBuilds() {
  await fs.mkdir(appState.root, { recursive: true });
  try {
    const content = await fs.readFile(buildsFilePath(), 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveBuilds(builds) {
  await fs.mkdir(appState.root, { recursive: true });
  await fs.writeFile(buildsFilePath(), JSON.stringify(builds, null, 2));
}

function normalizeProtocol(protocol) {
  return protocol === 'https' ? 'https' : 'http';
}

function buildApiUrl(build) {
  return `${build.protocol}://${build.host}:${build.port}/api/modpack`;
}

function buildThemeUrl(build, manifest) {
  if (manifest && manifest.themeUrl) {
    return manifest.themeUrl;
  }
  return `${build.protocol}://${build.host}:${build.port}/theme.html`;
}

ipcMain.handle('list-builds', async () => loadBuilds());

ipcMain.handle('create-build', async (_event, payload) => {
  const builds = await loadBuilds();
  const now = Date.now();
  const build = {
    id: `build-${now}`,
    name: (payload.name || `${payload.host}:${payload.port}`).trim(),
    host: payload.host.trim(),
    port: Number(payload.port || 7777),
    protocol: normalizeProtocol(payload.protocol || 'http'),
    createdAt: now,
    username: (payload.username || 'Player').trim() || 'Player'
  };
  builds.push(build);
  await saveBuilds(builds);
  log(`Build added: ${build.name} (${build.protocol}://${build.host}:${build.port})`);
  return build;
});



ipcMain.handle('delete-build', async (_event, buildId) => {
  const builds = await loadBuilds();
  const filtered = builds.filter((b) => b.id !== buildId);
  await saveBuilds(filtered);
  delete appState.manifests[buildId];
  await fs.rm(path.join(appState.root, 'instances', buildId), { recursive: true, force: true });
  log(`Build deleted: ${buildId}`);
  return { ok: true };
});

ipcMain.handle('update-build-username', async (_event, buildId, username) => {
  const builds = await loadBuilds();
  const idx = builds.findIndex((b) => b.id === buildId);
  if (idx === -1) throw new Error('Build not found.');
  builds[idx].username = (username || 'Player').trim() || 'Player';
  await saveBuilds(builds);
  return builds[idx];
});

ipcMain.handle('fetch-manifest', async (_event, buildId) => {
  const builds = await loadBuilds();
  const build = builds.find((b) => b.id === buildId);
  if (!build) throw new Error('Build not found.');

  const apiUrl = buildApiUrl(build);
  log(`Fetching manifest from ${apiUrl}`);

  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`API request failed with ${response.status}`);
  }

  const manifest = await response.json();
  appState.manifests[build.id] = manifest;
  return {
    manifest,
    apiUrl,
    warning: build.protocol === 'http' ? 'Using HTTP without TLS. Only use trusted servers.' : null,
    themeUrl: buildThemeUrl(build, manifest)
  };
});

ipcMain.handle('load-theme', async (_event, buildId) => {
  const builds = await loadBuilds();
  const build = builds.find((b) => b.id === buildId);
  if (!build) throw new Error('Build not found.');
  const manifest = appState.manifests[build.id];
  const themeUrl = buildThemeUrl(build, manifest);

  try {
    const response = await fetch(themeUrl);
    if (!response.ok) {
      return { ok: false, themeUrl, html: '' };
    }
    const html = await response.text();
    return { ok: true, themeUrl, html };
  } catch {
    return { ok: false, themeUrl, html: '' };
  }
});

ipcMain.handle('get-logs', async () => appState.logLines);

ipcMain.handle('sync-files', async (_event, buildId) => {
  const manifest = appState.manifests[buildId];
  if (!manifest) throw new Error('Manifest is not loaded.');

  const buildRoot = path.join(appState.root, 'instances', buildId);
  await fs.mkdir(buildRoot, { recursive: true });

  const targets = [
    ...(manifest.mods || []).map((x) => ({ ...x, targetPath: `mods/${path.basename(x.file || x.name || 'mod.jar')}` })),
    ...(manifest.configs || []).map((x) => ({ ...x, targetPath: x.path })),
    ...(manifest.resourcePacks || []).map((x) => ({ ...x, targetPath: `resourcepacks/${path.basename(x.file || x.name || 'pack.zip')}` }))
  ];

  let index = 0;
  for (const item of targets) {
    index += 1;
    const absolutePath = path.join(buildRoot, item.targetPath);
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

  return { root: buildRoot, total: targets.length };
});

ipcMain.handle('launch-game', async (_event, buildId, username) => {
  const manifest = appState.manifests[buildId];
  if (!manifest) throw new Error('Manifest is not loaded.');

  const builds = await loadBuilds();
  const build = builds.find((b) => b.id === buildId);
  const launchName = (username || build?.username || 'Player').trim() || 'Player';

  const buildRoot = path.join(appState.root, 'instances', buildId);
  const javaPath = await ensureJava(manifest.javaVersion || '17');
  const versionConfig = await ensureGameVersionProfile(manifest, buildRoot);

  const options = {
    authorization: Authenticator.getAuth(launchName),
    root: buildRoot,
    version: versionConfig,
    memory: {
      max: '4G',
      min: '2G'
    },
    javaPath,
    server: manifest.autoConnect
      ? { ip: manifest.autoConnect.host, port: manifest.autoConnect.port }
      : undefined,
    quickPlay: manifest.autoConnect
      ? {
          type: 'multiplayer',
          identifier: `${manifest.autoConnect.host}:${manifest.autoConnect.port}`
        }
      : undefined,
    overrides: {
      detached: false
    }
  };

  log(`Launching Minecraft ${versionConfig.number} for ${buildId} as ${launchName} with Java ${javaPath}`);
  launcher.launch(options);

  launcher.on('debug', (line) => log(`[MC] ${line}`));
  launcher.on('data', (line) => log(`[MC] ${line}`));

  return { started: true };
});

async function ensureGameVersionProfile(manifest, buildRoot) {
  const mcVersion = manifest.minecraftVersion;
  const loaderType = String(manifest.loader?.type || 'vanilla').toLowerCase();
  const loaderVersion = manifest.loader?.version;

  if (loaderType !== 'fabric' || !loaderVersion) {
    return { number: mcVersion, type: 'release' };
  }

  const versionId = `fabric-loader-${loaderVersion}-${mcVersion}`;
  const versionDir = path.join(buildRoot, 'versions', versionId);
  const versionFile = path.join(versionDir, `${versionId}.json`);

  try {
    await fs.access(versionFile);
  } catch {
    await fs.mkdir(versionDir, { recursive: true });
    const fabricProfileUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
    log(`Downloading Fabric profile ${fabricProfileUrl}`);
    const response = await fetch(fabricProfileUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch Fabric profile: ${response.status}`);
    }
    const profile = await response.json();
    await fs.writeFile(versionFile, JSON.stringify(profile, null, 2), 'utf8');
  }

  return {
    number: mcVersion,
    type: 'release',
    custom: versionId
  };
}

async function existsAndMatchHash(filePath, expectedHash) {
  try {
    const data = await fs.readFile(filePath);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    return hash.toLowerCase() === (expectedHash || '').toLowerCase();
  } catch {
    return false;
  }
}

function downloadFile(url, destination, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;

    client.get(url, (res) => {
      const status = Number(res.statusCode || 0);
      const redirectStatuses = new Set([301, 302, 303, 307, 308]);

      if (redirectStatuses.has(status)) {
        if (redirectCount >= 10) {
          reject(new Error(`Too many redirects while downloading ${url}`));
          return;
        }

        const location = res.headers.location;
        if (!location) {
          reject(new Error(`Redirect response without location for ${url}`));
          return;
        }

        const nextUrl = new URL(location, url).toString();
        res.resume();
        downloadFile(nextUrl, destination, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (status !== 200) {
        reject(new Error(`Failed to download ${url}, status=${status}`));
        return;
      }

      const output = createWriteStream(destination);
      res.pipe(output);
      output.on('finish', () => {
        output.close();
        resolve();
      });
      output.on('error', reject);
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
