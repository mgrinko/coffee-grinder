# Coffee Grinder (News Aggregator)

Автоматизированный пайплайн для создания новостных дайджестов: сбор новостей, суммаризация с помощью AI, создание презентаций и озвучка.

## Основной рабочий процесс

Проект представляет собой конвейер, состоящий из следующих этапов:

1. **Cleanup**: Очистка временных файлов и логов предыдущих запусков.
2. **Load**: Сбор свежих новостей из RSS-фидов (Google News и др.).
3. **Summarize**:
    * Декодирование сокращенных ссылок.
    * Получение полного текста статей (через прямой запрос или Playwright).
    * Суммаризация и категоризация статей с помощью **GPT-4o**.
    * Сохранение данных в Google Sheets для персистентности.
4. **Slides**: Генерация слайдов в Google Slides на основе полученных саммари.
5. **Audio**: Генерация аудио-озвучки для каждого слайда через **ElevenLabs**.
6. **Screenshots**: Снятие скриншотов готовых слайдов (через AutoHotkey).

## Структура проекта

* `/grinder` — Основное Node.js приложение.
  * `/src` — Исходный код пайплайна.
  * `/config` — Конфигурация источников (feeds.js), тем (topics.js) и ID Google-ресурсов.
  * `/extensions` — Браузерные расширения (например, для обхода капчи).
* `/audio` — Сгенерированные MP3 файлы.
* `/img` — Скриншоты и вспомогательные скрипты (AutoHotkey).
* `auto.bat` — Скрипт для полного автоматического запуска всего цикла.

## Требования

* **Node.js**: v18 или выше (используются ES модули и экспериментальный fetch).
* **Google Cloud Platform**: Сервисный аккаунт с доступом к Drive, Sheets и Slides API.
* **OpenAI API Key**: Для работы суммаризатора (GPT-4o).
* **ElevenLabs API Key**: Для генерации голоса.
* **AutoHotkey** (опционально): Для автоматизации скриншотов в Windows-окружении.
* **Google Chrome**: Для работы Playwright в режиме `browse-article`.

## Настройка

1. **Установка зависимостей**:

    ```bash
    cd grinder
    npm install
    ```

2. **Переменные окружения**:
    Создайте файл `grinder/.env` со следующими ключами:

    ```env
    OPENAI_API_KEY=your_openai_key
    ELEVEN_LABS_API_KEY=your_elevenlabs_key
    SERVICE_ACCOUNT_EMAIL=your-service-account@project.iam.gserviceaccount.com
    SERVICE_ACCOUNT_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
    ```

3. **Конфигурация Google Drive**:
    Отредактируйте [grinder/config/google-drive.js](grinder/config/google-drive.js), указав ID ваших таблиц и папок:
    * `mainSpreadsheetId` / `autoSpreadsheetId`: Google Таблицы для хранения новостей.
    * `templatePresentationId`: Шаблон презентации.
    * `rootFolderId`: Корневая папка проекта на Диске.

4. **Источники и темы**:
    * Настройте RSS-ленты в [grinder/config/feeds.js](grinder/config/feeds.js).
    * Настройте категории новостей в [grinder/config/topics.js](grinder/config/topics.js).

## Запуск

### Автоматический запуск (Windows)

Запустите `auto.bat` в корневой директории. Он выполнит обновление кода из Git и последовательно запустит все этапы.

### Ручной запуск этапов

Вы можете запускать отдельные части пайплайна из директории `grinder`:

* `npm run cleanup` — Очистка.
* `npm run load` — Загрузка новостей.
* `npm run summarize` — Суммаризация через AI.
* `npm run slides` — Создание презентации.
* `npm run audio` — Генерация аудио.
* `npm run add-missed` — Добавление пропущенных новостей (см. ниже).

### Добавление пропущенных новостей

После автоматического сбора можно вручную добавить пропущенные статьи. Скрипт выполнит суммаризацию, создаст слайд и сгенерирует аудио.

**Способ 1: Через командную строку**

```bash
cd grinder

# Простой вариант — только URL
npm run add-missed -- "https://news.google.com/articles/..."

# С указанием темы и приоритета
npm run add-missed -- --url "https://example.com/article" --topic "Ukraine" --priority 2

# Несколько URL
npm run add-missed -- "https://url1.com" "https://url2.com"
```

**Способ 2: Через Windows batch-файл**

```batch
4.add_missed.bat "https://news.google.com/articles/..."
4.add_missed.bat "https://example.com" --topic "Tech News" --priority 1
```

**Способ 3: Через Google Sheets**

1. Добавьте URL в колонку `gnUrl` или `url`
2. Установите значение `add` в колонке `manual`
3. Запустите `npm run add-missed` (без аргументов)

Доступные темы: `Big picture`, `America`, `Left Is losing it`, `Ukraine`, `Гадание на кофе`, `World news`, `Маразм крепчал`, `Tech News`, `Crazy news`

## Особенности реализации

* **Persistence**: Состояние очереди новостей хранится непосредственно в Google Sheets. Это позволяет нескольким агентам работать с одними и теми же данными и видеть статус обработки в реальном времени.
* **Browser Automation**: Если обычный fetch не справляется с защитой сайта, используется Playwright (`browse-article.js`) с загрузкой профиля Chrome и расширением для решения капчи.
* **AI Logic**: Суммаризация выполняется через OpenAI Assistants API. Модель не только сокращает текст, но и переводит заголовки, присваивает приоритет и выбирает подходящую категорию.
