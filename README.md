# Minecraft Server-Driven Launcher

Монорепозиторий содержит две части:

1. **Paper plugin** (`server-plugin`) — публикует JSON-манифест модпака и раздаёт файлы.
2. **Electron launcher** (`launcher`) — синхронизирует клиентские файлы, проверяет SHA-256, запускает Minecraft и авто-коннект к серверу.

## 1) Серверный плагин (Paper)

### Возможности
- REST API `GET /api/modpack` с данными:
  - `minecraftVersion`
  - `javaVersion`
  - `loader` (`fabric|forge|vanilla`)
  - `mods`, `configs`, `resourcePacks`
  - `autoConnect` (ip/port)
- Раздача файлов по URL `GET /files/...` из каталога `plugins/ServerDrivenModpack/repository`.
- Кэш SHA-256 в `checksums.yml`.
- Если `sha256` пустой в конфиге — считается автоматически и кэшируется.

### Запуск
```bash
cd server-plugin
mvn -B package
```

Готовый JAR: `server-plugin/target/server-driven-modpack-plugin-1.0.0.jar`

### Конфигурация
Файл: `server-plugin/src/main/resources/config.yml`
- `server.publicBaseUrl` должен указывать на HTTPS URL, доступный лаунчеру.
- Сами файлы должны лежать в `repository/` относительно data folder плагина.
- Если порт занят, плагин может автоматически пробовать следующий порт (настраивается `server.allowPortAutoIncrement` и `server.maxPortRetries`).

## 2) Лаунчер (Electron + Node.js)

### Возможности
- Запрос манифеста с сервера.
- Дифф локальных файлов и manifest-файлов.
- Скачивание отсутствующих/устаревших файлов.
- Проверка SHA-256 после скачивания.
- Сборка структуры инстанса (`mods/`, `config/`, `resourcepacks/`).
- Запуск Minecraft через `minecraft-launcher-core`.
- Auto-connect к серверу.
- Авто-установка Java 17 (Temurin) для Windows x64.
- UI с прогрессом, списком модов, кнопкой «Играть», встроенными логами.

### Запуск локально
```bash
cd launcher
npm install
npm start
```

## Безопасность
- Используйте только HTTPS для API и файлов.
- Проверка SHA-256 обязательна.
- В UI добавлено предупреждение пользователю перед синхронизацией.

## CI/CD pipeline

Workflow: `.github/workflows/build.yml`

### Что делает pipeline
1. **build-plugin** (Ubuntu):
   - `mvn -B package` в `server-plugin`
   - публикует JAR как artifact `paper-plugin-jar`
2. **build-launcher-windows** (Windows):
   - `npm install`
   - `npm run dist:win`
   - публикует `.exe` установщик как artifact `launcher-exe`

Таким образом автоматически генерируются:
- серверный plugin JAR
- Windows `.exe` для клиента
