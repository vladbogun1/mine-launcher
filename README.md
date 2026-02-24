# Minecraft Server-Driven Launcher

Монорепозиторий содержит две части:

1. **Paper plugin** (`server-plugin`) — публикует JSON-манифест модпака и раздаёт файлы.
2. **Electron launcher** (`launcher`) — синхронизирует клиентские файлы, проверяет SHA-256, запускает Minecraft и авто-коннект к серверу.

## 1) Серверный плагин (Paper)

### Возможности
- Для каждой сборки можно хранить кастомную тему интерфейса на сервере: по умолчанию лаунчер запрашивает `http(s)://<host>:<port>/theme.html` (или `themeUrl` из манифеста).
- Разрешены HTTP и HTTPS; для HTTP лаунчер показывает предупреждение о рисках безопасности.
- В репозитории добавлены примеры кастомных тем: `theme-template-examples/prado.html` и `theme-template-examples/netherwave.html` (ресурсы: `theme-template-examples/assets/`).
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
- `server.publicBaseUrl` — публичный базовый URL для ссылок в манифесте. Важно указывать порт (например, `http://150.136.127.73:25570`). Если оставить пустым, плагин соберёт URL из `server.publicScheme`, `server.publicHost` и фактического API-порта.
- При старте плагин автоматически дополняет существующий `config.yml` новыми полями из дефолтного конфига (старые конфиги мигрируются без ручного пересоздания).
- Сами файлы должны лежать в `repository/` относительно data folder плагина.
- Если порт занят, плагин может автоматически пробовать следующий порт (настраивается `server.allowPortAutoIncrement` и `server.maxPortRetries`).
- Если файл из `mods/configs/resourcePacks` отсутствует в `repository`, API вернёт JSON-ошибку `500` (вместо пустого ответа), и причина попадёт в лог сервера.


### Структура файлов на сервере
После первого запуска плагина структура в `plugins/ServerDrivenModpack/` должна выглядеть так:

```text
plugins/
└── ServerDrivenModpack/
    ├── config.yml               # основной конфиг плагина (версии, URL, список файлов)
    ├── checksums.yml            # кэш SHA-256, генерируется автоматически
    └── repository/              # корень файлов, которые раздаются лаунчеру
        ├── mods/
        │   └── *.jar
        ├── configs/
        │   └── ...
        └── resourcepacks/
            └── *.zip
```

Важно:
- `file` в секциях `mods/configs/resourcePacks` указывается **относительно `repository/`**.
  - пример для мода: `mods/sodium-fabric.jar`
  - пример для конфига: `configs/example.json`
  - пример для ресурспака: `resourcepacks/example.zip`
- `path` в секции `configs` — это путь, куда файл должен попасть у клиента (например, `config/example.json`).
- Если `sha256` пустой, плагин посчитает его автоматически и сохранит в `checksums.yml`.



### Где хранить темы на сервере
Лаунчер поддерживает 2 варианта источника темы:

1. `themeUrl` в JSON манифесте (`/api/modpack`) — полный URL до HTML темы.
2. Fallback по умолчанию: `http(s)://<host>:<port>/theme.html`.

Рекомендуемая структура рядом с API/файлами:

```text
<server-root>/
├── plugins/
│   └── ServerDrivenModpack/
│       ├── config.yml
│       ├── checksums.yml
│       └── repository/
│           ├── mods/
│           ├── configs/
│           └── resourcepacks/
└── web/                       # любой ваш web-root (nginx/caddy/apache/static)
    ├── theme.html             # дефолтная тема для этой сборки
    └── assets/
        ├── logo.png
        ├── bg.jpg
        └── custom.css
```

Важно:
- Тема — обычный HTML, который лаунчер вставляет в блок превью сборки.
- Все ресурсы темы (картинки/шрифты/CSS) должны быть доступны по HTTP(S) URL.
- Если используете относительные пути в теме (`./assets/...`), они должны быть корректны относительно URL самой темы.
- Если у вас несколько сборок, удобно отдавать разные темы по разным URL, например:
  - `https://cdn.example.com/themes/prado/theme.html`
  - `https://cdn.example.com/themes/nether/theme.html`
  и указывать эти ссылки в `themeUrl` для соответствующего манифеста.

## 2) Лаунчер (Electron + Node.js)

### Возможности
- Для каждой сборки можно хранить кастомную тему интерфейса на сервере: по умолчанию лаунчер запрашивает `http(s)://<host>:<port>/theme.html` (или `themeUrl` из манифеста).
- Разрешены HTTP и HTTPS; для HTTP лаунчер показывает предупреждение о рисках безопасности.
- В репозитории добавлены примеры кастомных тем: `theme-template-examples/prado.html` и `theme-template-examples/netherwave.html` (ресурсы: `theme-template-examples/assets/`).
- Запрос манифеста с сервера.
- Дифф локальных файлов и manifest-файлов.
- Скачивание отсутствующих/устаревших файлов.
- Проверка SHA-256 после скачивания.
- Сборка структуры инстанса (`mods/`, `config/`, `resourcepacks/`).
- Запуск Minecraft через `minecraft-launcher-core` с поддержкой Fabric профиля из манифеста (`loader.type=fabric`, `loader.version`).
- Auto-connect к серверу (через modern quickPlay, без устаревших JVM-флагов `--server/--port`).
- Авто-установка Java 17 (Temurin) для Windows x64.
- UI с главным экраном множества сборок, кнопками «Добавить сборку»/«Удалить сборку», и одной кнопкой «Играть» (она сама проверяет/обновляет файлы перед запуском), встроенными логами.
- Поле «Ник для запуска» для offline-mode серверов (без Microsoft/Xbox авторизации).

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
