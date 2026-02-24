package com.minelauncher.server;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.BindException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class ModpackPlugin extends JavaPlugin {
    private final Gson gson = new GsonBuilder().setPrettyPrinting().create();
    private final Map<String, String> checksumCache = new ConcurrentHashMap<>();
    private HttpServer httpServer;
    private Path repositoryRoot;
    private Path checksumCacheFile;
    private int activeApiPort;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        getConfig().options().copyDefaults(true);
        saveConfig();
        repositoryRoot = getDataFolder().toPath().resolve("repository");
        checksumCacheFile = getDataFolder().toPath().resolve("checksums.yml");

        try {
            Files.createDirectories(repositoryRoot);
            loadChecksumCache();
            startApiServer();
            getLogger().info("Server-driven modpack API started successfully.");
        } catch (Exception ex) {
            getLogger().severe("Failed to start modpack API: " + ex.getMessage());
            getServer().getPluginManager().disablePlugin(this);
        }
    }

    @Override
    public void onDisable() {
        if (httpServer != null) {
            httpServer.stop(1);
        }
    }


    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!"sdmreload".equalsIgnoreCase(command.getName())) {
            return false;
        }

        if (!sender.hasPermission("serverdrivenmodpack.reload")) {
            sender.sendMessage("§cYou don't have permission to run this command.");
            return true;
        }

        try {
            reloadPluginState();
            sender.sendMessage("§aServerDrivenModpack reloaded successfully.");
        } catch (Exception ex) {
            sender.sendMessage("§cFailed to reload plugin: " + ex.getMessage());
            getLogger().severe("Failed to reload plugin: " + ex.getMessage());
        }
        return true;
    }

    private synchronized void reloadPluginState() throws IOException {
        if (httpServer != null) {
            httpServer.stop(1);
            httpServer = null;
        }

        reloadConfig();
        getConfig().options().copyDefaults(true);
        saveConfig();
        startApiServer();
    }

    private void loadChecksumCache() {
        if (!Files.exists(checksumCacheFile)) {
            return;
        }
        YamlConfiguration cacheYaml = YamlConfiguration.loadConfiguration(checksumCacheFile.toFile());
        for (String key : cacheYaml.getKeys(false)) {
            checksumCache.put(key, cacheYaml.getString(key, ""));
        }
    }

    private void persistChecksumCache() throws IOException {
        YamlConfiguration cacheYaml = new YamlConfiguration();
        for (Map.Entry<String, String> entry : checksumCache.entrySet()) {
            cacheYaml.set(entry.getKey(), entry.getValue());
        }
        cacheYaml.save(checksumCacheFile.toFile());
    }

    private void startApiServer() throws IOException {
        FileConfiguration config = getConfig();
        String host = config.getString("server.host", "0.0.0.0");
        int basePort = config.getInt("server.port", 8080);
        String apiPath = config.getString("server.apiPath", "/api/modpack");
        String filesPath = config.getString("server.filesPath", "/files/");
        boolean allowPortAutoIncrement = config.getBoolean("server.allowPortAutoIncrement", true);
        int maxPortRetries = config.getInt("server.maxPortRetries", 20);

        int retries = allowPortAutoIncrement ? Math.max(0, maxPortRetries) : 0;
        int currentPort = basePort;
        IOException lastError = null;

        for (int attempt = 0; attempt <= retries; attempt++) {
            try {
                httpServer = HttpServer.create(new InetSocketAddress(host, currentPort), 0);
                httpServer.createContext(apiPath, this::handleManifestRequest);
                httpServer.createContext(filesPath, this::handleFileRequest);
                httpServer.setExecutor(null);
                httpServer.start();

                activeApiPort = currentPort;
                if (currentPort != basePort) {
                    getLogger().warning("Configured port " + basePort + " was busy. API started on fallback port " + currentPort + ".");
                }
                return;
            } catch (BindException bindEx) {
                lastError = bindEx;
                if (attempt == retries) {
                    break;
                }
                currentPort++;
            }
        }

        throw new IOException("Unable to bind API server on " + host + ":" + basePort + " after " + (retries + 1) + " attempts.", lastError);
    }

    private void handleManifestRequest(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "Method Not Allowed", "text/plain");
            return;
        }

        try {
            JsonObject response = buildManifest();
            respond(exchange, 200, gson.toJson(response), "application/json");
        } catch (Exception ex) {
            getLogger().severe("Failed to build modpack manifest: " + ex.getMessage());
            JsonObject error = new JsonObject();
            error.addProperty("error", "Failed to build modpack manifest");
            error.addProperty("message", ex.getMessage());
            respond(exchange, 500, gson.toJson(error), "application/json");
        }
    }

    private void handleFileRequest(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "Method Not Allowed", "text/plain");
            return;
        }

        String filesPath = getConfig().getString("server.filesPath", "/files/");
        String requestPath = exchange.getRequestURI().getPath();
        String relativePath = requestPath.replaceFirst("^" + filesPath, "");

        Path target = repositoryRoot.resolve(relativePath).normalize();
        if (!target.startsWith(repositoryRoot) || !Files.exists(target) || Files.isDirectory(target)) {
            respond(exchange, 404, "File not found", "text/plain");
            return;
        }

        exchange.getResponseHeaders().add("Content-Type", "application/octet-stream");
        exchange.sendResponseHeaders(200, Files.size(target));
        try (OutputStream os = exchange.getResponseBody(); InputStream is = Files.newInputStream(target)) {
            is.transferTo(os);
        }
    }

    private JsonObject buildManifest() throws IOException {
        FileConfiguration cfg = getConfig();
        JsonObject root = new JsonObject();

        root.addProperty("minecraftVersion", cfg.getString("minecraftVersion"));
        root.addProperty("javaVersion", cfg.getString("javaVersion"));

        JsonObject loader = new JsonObject();
        loader.addProperty("type", cfg.getString("loader.type", "vanilla"));
        loader.addProperty("version", cfg.getString("loader.version", ""));
        root.add("loader", loader);

        JsonObject autoConnect = new JsonObject();
        autoConnect.addProperty("host", cfg.getString("autoConnect.host", ""));
        autoConnect.addProperty("port", cfg.getInt("autoConnect.port", 25565));
        root.add("autoConnect", autoConnect);

        root.add("mods", buildEntriesArray(cfg.getMapList("mods"), "mods"));
        root.add("configs", buildEntriesArray(cfg.getMapList("configs"), "configs"));
        root.add("resourcePacks", buildEntriesArray(cfg.getMapList("resourcePacks"), "resourcepacks"));
        return root;
    }

    private JsonArray buildEntriesArray(List<Map<?, ?>> entries, String typeDirectory) throws IOException {
        JsonArray jsonArray = new JsonArray();
        for (Map<?, ?> rawEntry : entries) {
            String file = String.valueOf(rawEntry.get("file") == null ? "" : rawEntry.get("file"));
            String sha256 = String.valueOf(rawEntry.get("sha256") == null ? "" : rawEntry.get("sha256"));

            if (sha256.isBlank()) {
                sha256 = resolveChecksum(file);
            }

            JsonObject item = new JsonObject();
            if (rawEntry.containsKey("name")) {
                item.addProperty("name", rawEntry.get("name").toString());
            }
            if (rawEntry.containsKey("version")) {
                item.addProperty("version", rawEntry.get("version").toString());
            }
            if (rawEntry.containsKey("path")) {
                item.addProperty("path", rawEntry.get("path").toString());
            }

            item.addProperty("sha256", sha256);
            item.addProperty("url", buildPublicUrl(file));
            item.addProperty("file", file);
            item.addProperty("type", typeDirectory);
            jsonArray.add(item);
        }
        return jsonArray;
    }

    private String buildPublicUrl(String relativeFile) {
        String configuredBase = getConfig().getString("server.publicBaseUrl", "").trim();
        String filesPath = getConfig().getString("server.filesPath", "/files/");
        String cleanPath = filesPath.startsWith("/") ? filesPath.substring(1) : filesPath;

        String base = configuredBase;
        if (base.isBlank()) {
            String host = getConfig().getString("server.publicHost", "localhost");
            String scheme = getConfig().getString("server.publicScheme", "http");
            base = scheme + "://" + host + ":" + activeApiPort;
        } else {
            try {
                URI uri = URI.create(base);
                if (uri.getPort() == -1 && activeApiPort > 0) {
                    String authority = uri.getHost() + ":" + activeApiPort;
                    URI withPort = new URI(uri.getScheme(), authority, uri.getPath(), uri.getQuery(), uri.getFragment());
                    base = withPort.toString();
                }
            } catch (Exception ignored) {
                // Keep configured base as-is if URI parsing failed.
            }
        }

        if (!base.endsWith("/")) {
            base += "/";
        }
        return base + cleanPath + relativeFile;
    }

    private String resolveChecksum(String relativeFile) throws IOException {
        String cached = checksumCache.get(relativeFile);
        if (cached != null && !cached.isBlank()) {
            return cached;
        }

        Path file = repositoryRoot.resolve(relativeFile).normalize();
        if (!Files.exists(file)) {
            throw new IOException("Configured file does not exist: " + file);
        }

        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(Files.readAllBytes(file));
            String result = HexFormat.of().formatHex(hash);
            checksumCache.put(relativeFile, result);
            persistChecksumCache();
            return result;
        } catch (NoSuchAlgorithmException ex) {
            throw new IOException("SHA-256 unavailable", ex);
        }
    }

    private void respond(HttpExchange exchange, int status, String body, String contentType) throws IOException {
        byte[] payload = body.getBytes();
        exchange.getResponseHeaders().add("Content-Type", contentType);
        exchange.sendResponseHeaders(status, payload.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(payload);
        }
    }
}
