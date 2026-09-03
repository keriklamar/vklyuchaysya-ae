# Включайся!

Автоматизация утреннего эфирного блока графики для телепередачи «Включайся!»
(After Effects): панель управления + проект-шаблон + установщик.

Один клик по кнопке подтягивает в проект погоду, курс валют, дату, именины,
новости и гороскоп из внешних источников и расставляет все анимационные
переходы.

---

## Структура репозитория

```
panel/
  AutoPogodaPanel/        CEP-расширение AE (готово к установке как есть)
    CSXS/manifest.xml     bundle id by.autopogoda.panel, CSXS 9.0+, AEFT 18.0+
    client/               UI: index.html + js/main.js (+ CSInterface.js, jszip.min.js)
    host/host.jsx         вся логика ExtendScript (~230 КБ, ES3)
project/
  подложка утро_0.3.aep   основной проект
  подложка.psd            исходник подложки
  Анимашки/               исходники иконок погоды (Weather icons *.aep)
  icons/                  PNG/SVG иконок погоды
  новости пример.docx     образец .docx с новостями
fonts/                    Cousine + Manrope (.ttf)
installer/
  vklyuchaysya.iss        скрипт Inno Setup 6
  README.txt              инструкция для конечного пользователя
```

---

## Как устроена панель

`client/js/main.js` (CEP, браузерная среда с Node.js) собирает данные из сети и
`.docx`, затем вызывает функции из `host/host.jsx` (ExtendScript) через
`CSInterface.evalScript`. `host.jsx` пишет данные в слои/композиции проекта.

Кнопки (сверху вниз — в порядке подготовки выпуска):

| Блок | Источник данных | Ключевые функции `host.jsx` |
|---|---|---|
| День выпуска | выбор даты (влияет на погоду и дату) | `getLocalDateInfoShort` |
| Погода | pogoda.by `numeric-weather/12/<station>` (публичный) | `buildWeatherCycleTimeline`, `applyWeatherTransitions`, `weatherTargets` |
| Курс валют | НБ РБ | `applyCurrency` |
| Дата / день недели | системная дата на выбранный день | `applyDate` |
| Именины | Google Calendar (виджет kalendarik.com.ua) через `curl.exe` | `fetchNamedaysToday`, `applyBirthdayNames` |
| Новости | `.docx`, 6 абзацев | `applyNewsItems` |
| Гороскоп | `.docx`, 12 абзацев | `applyHoroscopeItems` |
| Переходы | — | `applyAllBlockTransitions`, `resetAllTransitions` |

Проект содержит две главные композиции: **`ОСНОВА`** (197 с, полный выпуск) и
**`ОСНОВА без др`** (187.62 с — тот же выпуск без блока «дни рождения»). Панель
работает по **активной** композиции, имя которой содержит «ОСНОВА»
(`getOsnova` / `getPodlozhka`).

Имена слоёв и композиций регистрозависимы — по ним `host.jsx` находит цели.

---

## Установка (конечный пользователь)

Собранный `Vklyuchaysya_Setup.exe` — в разделе **Releases**. Ставит всё на
уровне текущего пользователя, **без прав администратора и UAC**:

- панель → `%APPDATA%\Adobe\CEP\extensions\AutoPogodaPanel`
- проект → `%USERPROFILE%\Documents\Включайся\Graph\`
- шрифты Cousine + Manrope → пользовательские шрифты
- `HKCU\Software\Adobe\CSXS.9…12\PlayerDebugMode = "1"` (иначе AE не грузит
  неподписанную панель)

Единственный ручной шаг после установки — в AE включить
**Preferences → Scripting & Expressions → Allow Scripts to Write Files and
Access Network** и перезапустить AE. Подробности — `installer/README.txt`.

### Установка панели вручную (без инсталлятора)

1. Скопировать `panel/AutoPogodaPanel` в
   `%APPDATA%\Adobe\CEP\extensions\AutoPogodaPanel`.
2. `regedit` → `HKCU\Software\Adobe\CSXS.<N>` → строковый `PlayerDebugMode` = `1`
   (`<N>` — версия CSXS вашей AE: 9–12).
3. Установить шрифты из `fonts/`.
4. Открыть проект `project/подложка утро_0.3.aep`.
5. AE → `Window → Extensions → Включайся!`.

---

## Сборка установщика

Нужен [Inno Setup 6](https://jrsoftware.org/isdl.php) (`winget install
JRSoftware.InnoSetup`).

```
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\vklyuchaysya.iss
```

→ `installer\Output\Vklyuchaysya_Setup.exe` (папка `Output/` в `.gitignore`;
готовый бинарь публикуется как ассет GitHub Release).

---

## Замечание о ключах

Репозиторий публичный. `host.jsx` содержит `KALENDARIK_API_KEY` — ключ Google
Calendar API виджета kalendarik.com.ua, ограниченный по HTTP-Referer их
доменом (вне их сайта бесполезен). Погода берётся с публичного эндпоинта
pogoda.by без ключа. Секретов, дающих доступ к чему-либо приватному, в коде нет.
