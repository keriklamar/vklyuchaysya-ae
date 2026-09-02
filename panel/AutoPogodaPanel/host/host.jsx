// ============================================================
// host.jsx — ExtendScript, выполняется ВНУТРИ After Effects.
// Панель вызывает эти функции через CSInterface.evalScript(...).
// Все входные данные приходят как JSON-строки (ExtendScript
// не умеет JSON.parse изначально в старых версиях, поэтому
// используем встроенный полифилл ниже).
// ============================================================

// --- Полифилл JSON (в некоторых версиях ExtendScript его нет) ---
if (typeof JSON === "undefined") {
    JSON = {};
}
if (!JSON.parse) {
    JSON.parse = function (str) {
        // eslint-disable-next-line no-eval
        return eval("(" + str + ")");
    };
}

// Список из 8 возможных слоёв-иконок в карточке погоды.
// ВАЖНО: имена должны точно совпадать с именами слоёв в AE-проекте.
var ICON_LAYER_NAMES = [
    "icon_clear",
    "icon_cloudy",
    "icon_overcast",
    "icon_rain",
    "icon_storm",
    "icon_snow",
    "icon_fog",
    "icon_wind"
];

// Находит композицию по точному имени среди всех элементов проекта
// (включая вложенные в папки).
function findCompByName(name) {
    for (var i = 1; i <= app.project.numItems; i++) {
        var item = app.project.item(i);
        if (item instanceof CompItem && item.name === name) {
            return item;
        }
    }
    return null;
}

// В проекте есть ДВЕ композиции с именем "подложка" (id 1 — пустая
// неиспользуемая, id 138 — настоящая с 15 слоями-плашками). Обычный
// findCompByName берёт первую по порядку в проекте — это может оказаться
// пустышка. Тут берём ту, у которой реально больше слоёв — не завязано
// на конкретный id (переживёт пересборку проекта).
function findNonEmptyCompByName(name) {
    var best = null;
    for (var i = 1; i <= app.project.numItems; i++) {
        var item = app.project.item(i);
        if (item instanceof CompItem && item.name === name) {
            if (!best || item.numLayers > best.numLayers) best = item;
        }
    }
    return best;
}

// РАБОЧАЯ ОСНОВА (2026-08-31): если сейчас открыта/активна композиция, в имени
// которой есть "ОСНОВА" (напр. "ОСНОВА без др") — работаем с НЕЙ; иначе — первая
// "ОСНОВА". Так панель применяет переходы/погоду к той версии, что открыл
// пользователь, без переименования композиций.
function getOsnova() {
    var a = app.project.activeItem;
    if (a && (a instanceof CompItem) && a.name.indexOf("ОСНОВА") !== -1) return a;
    return findCompByName("ОСНОВА");
}

// Подложка, соответствующая рабочей ОСНОВА: источник её слоя, чьё имя начинается
// на "подложка" (у "ОСНОВА без др" слой называется "подложка без др" — его
// источник comp "подложка без др"). Fallback — findNonEmptyCompByName.
function getPodlozhka() {
    var o = getOsnova();
    if (o) {
        for (var i = 1; i <= o.numLayers; i++) {
            var l = o.layer(i);
            if (l.source && (l.source instanceof CompItem) && l.name.indexOf("подложка") === 0) return l.source;
        }
    }
    return findNonEmptyCompByName("подложка");
}

// Находит слой в композиции по точному имени.
function findLayerByName(comp, name) {
    for (var i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === name) {
            return comp.layer(i);
        }
    }
    return null;
}

// Целевые ЦЕНТРЫ элементов — те же, что в build_template.jsx.
// Если координаты когда-нибудь поменяются, менять нужно в обоих местах.
var CITY_TEXT_POS = [526.75, 988.34];
var TEMP_TEXT_POS = [745.84, 987.97];
var NEWS_TEXT_POS = [1296.97, 988.08];
var SHAPES_MAX_NEWS_WIDTH = 769; // ширина bg_news из build_template.jsx

// Безопасно ставит текст в текстовый слой (TextDocument) И заново
// центрирует его по целевой точке — без этого при подстановке реальных
// данных (другая длина слова/числа) текст съезжает от подложки.
function setLayerTextCentered(layer, text, targetPos) {
    if (!layer) return false;
    try {
        var textProp = layer.property("Source Text");
        var textDocument = textProp.value;
        textDocument.text = text;
        textProp.setValue(textDocument);

        var rect = layer.sourceRectAtTime(0, false);
        layer.property("Anchor Point").setValue([rect.left + rect.width / 2, rect.top + rect.height / 2]);
        layer.property("Position").setValue(targetPos);
        return true;
    } catch (e) {
        return false;
    }
}

// Обновляет одну карточку погоды: город, температуру и включает
// ровно одну нужную иконку (остальные 7 выключает).
function updateWeatherCard(compName, cityName, tempText, iconLayerName) {
    var comp = findCompByName(compName);
    if (!comp) return "ERROR: comp not found: " + compName;

    var cityLayer = findLayerByName(comp, "txt_city");
    var tempLayer = findLayerByName(comp, "txt_temp");
    setLayerTextCentered(cityLayer, cityName, CITY_TEXT_POS);
    setLayerTextCentered(tempLayer, tempText, TEMP_TEXT_POS);

    for (var i = 0; i < ICON_LAYER_NAMES.length; i++) {
        var iconName = ICON_LAYER_NAMES[i];
        var iconLayer = findLayerByName(comp, iconName);
        if (iconLayer) {
            iconLayer.enabled = (iconName === iconLayerName);
        }
    }
    return "OK";
}

// (updateNewsCard больше не используется — см. applyNewsSequence ниже,
// новости теперь не по отдельным карточкам, а ключевыми кадрами)

// Правило (обновлено 2026-08-27, по прямому указанию пользователя):
// размер шрифта ОДИН И ТОТ ЖЕ независимо от того, 1 строка получилась
// или 2 — различие TEXT_FONT_SIZE/TEXT_FONT_SIZE_1LINE, которое было
// здесь раньше (введено ошибочно днём ранее), убрано. Перенос на 1/2
// строки (по числу слов) остаётся как раньше — это только вопрос
// разбиения текста, к размеру шрифта отношения не имеет.
// TEXT_FONT_SIZE — единственная константа размера (используется для
// именин всегда; для новостей/гороскопа — как fontSize и 1-, и
// 2-строчного случая, см. ниже).
// 28 (2026-08-31): было 27. restyleAllTextItems() проставляет это значение
// на эталонные слои и переразкладывает все пункты — без повторной загрузки docx.
var TEXT_FONT_SIZE = 28;
var NEWS_SHORT_WORD_LIMIT = 4;

// Последнее известное ПРАВИЛЬНОЕ (не испорченное) значение Y "новость 1",
// снятое живьём 2026-08-28 ДО того, как реальный текст пункта №1 стал
// 2-строчным и испортил его. Используется РОВНО ОДИН РАЗ — как начальная
// позиция нового постоянного слоя-эталона "новость 1_эталон" при его
// автосоздании (см. ensureNewsOneLineTemplate) — дальше этот слой
// живёт своей жизнью, эта константа больше ни на что не влияет.
var NEWS_ONELINE_SEED_Y = 74.0678817108274;

// ============================================================
// ЕДИНЫЙ ЭТАЛОН (2026-08-28, прямое указание пользователя): новости/
// гороскоп/др берут позицию/размер из ОДНОГО источника — comp "новости
// текст". Старые эталонные слои гороскопа/др ("_верохний"/"_нижний",
// "верх"/"низ") остаются в проекте нетронутыми, но код их больше не
// читает.
//
// ФИКС САМОПОРЧИ (2026-08-28, по выбору пользователя — "Завести отдельный
// слой-эталон"): раньше 1-строчная X/Y/anchor читались у "новость 1" —
// а это тот же самый слой, который каждый прогон переписывается реальным
// текстом пункта №1 ротации. Когда этот текст оказался длинным (стал
// 2-строчным), Position "новость 1" переписалась на upperY — и эталон
// "уехал" сразу для ВСЕХ трёх comp'ов (гороскоп/др тоже показывали 1-строчные
// пункты на месте верхней строки). Устранено заведением ОТДЕЛЬНОГО слоя
// "новость 1_эталон" в comp "новости текст" — код создаёт его САМ при
// первом вызове (см. ensureNewsOneLineTemplate) и НИКОГДА больше не
// трогает. Если понадобится подвинуть общую 1-строчную позицию для всех
// трёх comp — двигать нужно ИМЕННО "новость 1_эталон" (выключенный слой)
// в AE, а не "новость 1".
function ensureNewsOneLineTemplate(comp, refUpper) {
    var existing = findLayerByName(comp, "новость 1_эталон");
    if (existing) return existing;
    if (!refUpper) return null;
    var dup = refUpper.duplicate();
    dup.name = "новость 1_эталон";
    dup.enabled = false;
    var pos = refUpper.property("Position").value;
    dup.property("Position").setValue([pos[0], NEWS_ONELINE_SEED_Y]);
    return dup;
}

// Последняя известная ПРАВИЛЬНАЯ позиция "именины" для 1-строчного
// случая — снята ДО того, как др начали унифицировать с новостями
// (2026-08-28). ВАЖНО (посчитано, не гадание): у др другой шрифт
// (LucidaConsole) и другой anchor, чем у новостей — сырые X/Y от
// новостей физически не могут дать тот же экранный результат (формула
// screen = Position + (sourceRect − Anchor), и у др эта разница иная).
// Расчёт по формуле для 1-строчного случая даёт X≈398.8, Y≈58.5 — это
// совпадает с историческим значением ниже: др изначально была
// откалибрована пользователем под тот же визуальный ряд, что и новости,
// просто в СВОИХ, других сырых числах. Поэтому др — как и новости —
// получает СВОЙ собственный постоянный слой-эталон, а не берёт сырые
// числа новостей.
var DR_ONELINE_SEED_X = 399;
var DR_ONELINE_SEED_Y = 58.6517219543457;

function ensureBirthdayOneLineTemplate(comp, drRefUpper) {
    var existing = findLayerByName(comp, "именины_эталон");
    if (existing) return existing;
    if (!drRefUpper) return null;
    var dup = drRefUpper.duplicate();
    dup.name = "именины_эталон";
    dup.enabled = false;
    dup.property("Position").setValue([DR_ONELINE_SEED_X, DR_ONELINE_SEED_Y]);
    return dup;
}

function getTemplateTextMetrics() {
    var comp = findCompByName("новости текст");
    if (!comp) return null;
    var ref1 = findLayerByName(comp, "новость 1");
    if (!ref1) return null;

    var ref1Pos = ref1.property("Position").value;
    var refUpper = findLayerByName(comp, "новость 1_верхняя");
    var refLower = findLayerByName(comp, "новость 1_нижняя");
    var refOneLine = ensureNewsOneLineTemplate(comp, refUpper);

    // fontSize (2026-08-28, фикс самопорчи): ОДИН и тот же fontSize для
    // 1- и 2-строчного случая — по прямому правилу пользователя ("высота
    // текста должна быть всегда одинаковая, безразлично в сколько строк
    // текст"). Берём его ТОЛЬКО у "_верхняя"/"_нижняя" — эти слои код
    // никогда не переписывает, значит fontSize там всегда живой и точный.
    var sharedFontSize = refUpper ? refUpper.property("Source Text").value.fontSize
        : (refLower ? refLower.property("Source Text").value.fontSize : TEXT_FONT_SIZE);

    // X/Y/anchor для 1-строчного случая — у постоянного "новость 1_эталон"
    // (НЕ у "новость 1" — та мутируемая, см. комментарий выше). Fallback на
    // "новость 1" оставлен только на случай, если refUpper тоже не нашёлся
    // и эталон создать было не из чего — тогда работаем по-старому и
    // предупреждаем через hasTwoLineRef=false.
    var oneLineSource = refOneLine || ref1;

    return {
        oneLineX: oneLineSource.property("Position").value[0],
        oneLineY: oneLineSource.property("Position").value[1],
        oneLineFontSize: sharedFontSize,
        oneLineAnchor: oneLineSource.property("Anchor Point").value,
        twoLineX: refUpper ? refUpper.property("Position").value[0] : ref1Pos[0],
        upperY: refUpper ? refUpper.property("Position").value[1] : null,
        lowerY: refLower ? refLower.property("Position").value[1] : null,
        twoLineFontSize: sharedFontSize,
        upperAnchor: refUpper ? refUpper.property("Anchor Point").value : null,
        lowerAnchor: refLower ? refLower.property("Anchor Point").value : null,
        hasTwoLineRef: !!(refUpper && refLower)
    };
}

// mode: "1" — принудительно 1 строка, "2" — принудительно 2 строки
// (авто-перенос пополам по словам), "auto"/не задан — старое поведение
// (<=4 слов -> 1 строка, иначе -> 2). Если в text уже есть перенос строки
// (пользователь сам нажал Enter в поле панели) — это явное намерение,
// используем ЕГО как есть и mode/авто-логику полностью игнорируем, чтобы
// не получить перенос поверх переноса (3 строки вместо 2).
function prepareNewsText(text, mode) {
    var raw = text || "";
    var leading = TEXT_FONT_SIZE * 1.15;
    if (raw.indexOf("\n") !== -1 || raw.indexOf("\r") !== -1) {
        var manualLines = raw.split(/\r\n|\r|\n/);
        return { text: manualLines.join("\r"), fontSize: TEXT_FONT_SIZE, leading: leading };
    }

    var words = raw.split(" ");
    if (mode === "1" || (mode !== "2" && words.length <= NEWS_SHORT_WORD_LIMIT)) {
        return { text: raw, fontSize: TEXT_FONT_SIZE, leading: leading };
    }
    var mid = Math.ceil(words.length / 2);
    var wrapped = words.slice(0, mid).join(" ") + "\r" + words.slice(mid).join(" ");
    return { text: wrapped, fontSize: TEXT_FONT_SIZE, leading: leading };
}

// Новая архитектура: один текстовый слой txt_news внутри LANE_NEWS,
// значения меняются по ключевым кадрам Source Text (мгновенно,
// подложка bg_auto при этом никогда не выключается).
function applyNewsSequence(newsArrayJson) {
    var newsArray = JSON.parse(newsArrayJson);
    var comp = findCompByName("LANE_NEWS");
    if (!comp) return "ERROR: comp not found: LANE_NEWS";

    var newsLayer = findLayerByName(comp, "txt_news");
    if (!newsLayer) return "ERROR: txt_news layer not found in LANE_NEWS";

    app.beginUndoGroup("Включайся!: обновление новостей");
    try {
        var sourceTextProp = newsLayer.property("Source Text");
        var anchorProp = newsLayer.property("Anchor Point");
        // Position держим постоянной (целевая точка), меняется только
        // anchor — так текст всегда центрируется на одном и том же месте,
        // независимо от длины конкретной новости.
        newsLayer.property("Position").setValue(NEWS_TEXT_POS);

        var maxTextWidth = SHAPES_MAX_NEWS_WIDTH - 60; // отступы слева/справа

        for (var i = 0; i < 10; i++) {
            var t = i * 20;
            var prepared = prepareNewsText(newsArray[i] || ("Новость " + (i + 1)));
            var doc = sourceTextProp.value;
            doc.text = prepared.text;
            doc.fontSize = prepared.fontSize;
            doc.autoLeading = false;
            doc.leading = prepared.leading;
            sourceTextProp.setValueAtTime(t, doc);

            // Защита от переполнения по ширине — если даже после подбора
            // размера строка шире подложки, аккуратно уменьшаем шрифт.
            var rect = newsLayer.sourceRectAtTime(t, false);
            var guard = 0;
            while (rect.width > maxTextWidth && doc.fontSize > 14 && guard < 20) {
                doc.fontSize -= 2;
                doc.leading = doc.fontSize * 1.15;
                sourceTextProp.setValueAtTime(t, doc);
                rect = newsLayer.sourceRectAtTime(t, false);
                guard++;
            }

            anchorProp.setValueAtTime(t, [rect.left + rect.width / 2, rect.top + rect.height / 2]);
        }

        // КРИТИЧНО: по умолчанию Anchor Point интерполируется ПЛАВНО
        // между ключевыми кадрами (как обычная анимация позиции) — из-за
        // этого центр текста медленно "заезжал" от одной новости к другой
        // весь 20-секундный показ. Принудительно ставим Hold — мгновенно,
        // как и у самого текста.
        for (var k = 1; k <= anchorProp.numKeys; k++) {
            anchorProp.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
        }
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "OK";
}

// ------------------------------------------------------------
// Массовые функции — вызываются панелью одним запросом,
// принимают JSON-массив со всеми 6 городами / 10 новостями сразу.
// ------------------------------------------------------------

// weatherJson — строка вида:
// [{"comp":"Card_Weather_01","city":"Минск","temp":"+20°","icon":"icon_clear"}, ...]
function applyAllWeather(weatherJson) {
    var data = JSON.parse(weatherJson);
    var results = [];
    app.beginUndoGroup("Включайся!: обновление погоды");
    for (var i = 0; i < data.length; i++) {
        var d = data[i];
        results.push(updateWeatherCard(d.comp, d.city, d.temp, d.icon));
    }
    app.endUndoGroup();
    return results.join(" | ");
}

// newsJson теперь не используется — см. applyNewsSequence выше.

// ============================================================
// ПОРТАТИВНЫЕ ПУТИ (2026-08-29) — раньше ниже было зашито "E:/включайся/..."
// напрямую (несколько констант) - работало только пока проект лежит
// именно на диске E:. Теперь считаем корень проекта от РЕАЛЬНОГО
// расположения открытого .aep: он лежит в "Graph/", а "icons/"/"шрифты/"/
// "preview/" — папки-соседи "Graph/", на уровень выше. Значит корень —
// на 2 уровня выше самого .aep. Если структура папок при установке на
// другую машину сохранена такой же (см. установщик) — всё работает с
// любого диска/пути без правок кода. Fallback на диск E: — только если
// проект почему-то ещё не сохранён (app.project.file == null).
// ============================================================
function getProjectRootFolder() {
    if (app.project.file) {
        return app.project.file.parent.parent.fsName;
    }
    return "E:/включайся";
}

// ============================================================
// Экспорт стоп-кадра в PNG — чтобы Claude мог САМ посмотреть, что
// получилось, не полагаясь на скриншоты от руки. Без рендер-очереди,
// напрямую через CompItem.saveFrameToPng().
// ============================================================
// Функция, а не var: если host.jsx загрузится ДО того, как открыт
// проект (app.project.file ещё null), значение — не число, а функция
// вызывается заново при каждом использовании, а не кэшируется один раз
// на старте (host.jsx кэшируется движком AE на всю сессию — см. другие
// комментарии об этом в файле).
function getPreviewOutDir() { return getProjectRootFolder() + "/preview/"; }

function exportPreviewFrame(argsJson) {
    var args = JSON.parse(argsJson); // { compName: "MASTER", time: 4.2 }
    var comp = findCompByName(args.compName || "MASTER");
    if (!comp) return "ERROR: comp not found: " + (args.compName || "MASTER");

    var previewDir = getPreviewOutDir();
    var dir = new Folder(previewDir);
    if (!dir.exists) dir.create();

    var fileName = "frame_" + String(args.time).replace(".", "_") + ".png";
    var outFile = new File(previewDir + fileName);

    try {
        comp.saveFrameToPng(args.time, outFile);
        return "OK: " + outFile.fsName;
    } catch (e) {
        return "ERROR: " + e.toString();
    }
}

// Пакетный экспорт — несколько кадров за один клик, чтобы не гонять
// панель по одному разу за кадр.
// argsJson: { compName: "MASTER", times: [0, 3.6, 4, 4.2] }
function exportPreviewFrames(argsJson) {
    var args = JSON.parse(argsJson);
    var comp = findCompByName(args.compName || "MASTER");
    if (!comp) return "ERROR: comp not found: " + (args.compName || "MASTER");

    var previewDir = getPreviewOutDir();
    var dir = new Folder(previewDir);
    if (!dir.exists) dir.create();

    var results = [];
    for (var i = 0; i < args.times.length; i++) {
        var t = args.times[i];
        var fileName = "frame_" + String(t).replace(".", "_") + ".png";
        var outFile = new File(previewDir + fileName);
        try {
            comp.saveFrameToPng(t, outFile);
            results.push("OK " + t);
        } catch (e) {
            results.push("ERROR " + t + ": " + e.toString());
        }
    }
    return results.join(" | ");
}

// ============================================================
// Растягивает duration каждой композиции + outPoint каждого слоя
// в каждой композиции до newDuration. Раньше это был отдельный
// run-script файл (set_total_duration.jsx) — перенесено сюда, т.к.
// Run Script File у пользователя временно заблокирован ("modal dialog"
// висит на уровне AE, не лечится перезапуском). Кнопка в панели —
// более надёжный канал прямо сейчас.
// ============================================================
function setTotalDuration(newDurationStr) {
    var newDuration = parseFloat(newDurationStr);
    if (!newDuration || newDuration <= 0) return "ERROR: некорректная длительность";

    app.beginUndoGroup("Растянуть всё до " + newDuration + " сек");
    var report = [];
    var errors = 0;

    for (var i = 1; i <= app.project.numItems; i++) {
        var item = app.project.item(i);
        if (!(item instanceof CompItem)) continue;

        try {
            var old = item.duration;
            item.duration = newDuration;
            report.push(item.name + " (comp id " + item.id + "): duration " + old.toFixed(2) + "->" + item.duration.toFixed(2));
        } catch (e) {
            errors++;
            report.push("!! ОШИБКА duration на " + item.name + ": " + e.toString());
        }

        for (var li = 1; li <= item.numLayers; li++) {
            try {
                var layer = item.layer(li);
                var oldOut = layer.outPoint;
                if (layer.outPoint < newDuration) {
                    layer.outPoint = newDuration;
                    report.push("  [" + item.name + "] layer '" + layer.name + "': outPoint " + oldOut.toFixed(2) + "->" + layer.outPoint.toFixed(2));
                }
            } catch (e2) {
                errors++;
                report.push("  !! ОШИБКА outPoint на [" + item.name + "] слой #" + li + ": " + e2.toString());
            }
        }
    }
    app.endUndoGroup();

    var logFile = new File(getProjectRootFolder() + "/Graph/подлоджка/set_total_duration_report.txt");
    logFile.open("w");
    logFile.write(report.join("\n"));
    logFile.close();

    return "OK, отчёт в set_total_duration_report.txt (" + errors + " ошибок из " + report.length + " строк)";
}

// Снимает текущую (возможно, вручную поправленную пользователем)
// геометрию "город": размер комп-а, позицию/якорь/масштаб текстового
// слоя внутри неё, и как сама "город" сидит слоем внутри "основы".
// Тоже перенесено сюда вместо отдельного run-script файла.
function dumpCityGeometry() {
    function layerInfo(layer) {
        if (!layer) return null;
        var rect = layer.sourceRectAtTime(0, false);
        return {
            name: layer.name,
            position: layer.property("Position").value,
            anchorPoint: layer.property("Anchor Point").value,
            scale: layer.property("Scale").value,
            sourceRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        };
    }
    function findFirstTextLayer(comp) {
        for (var i = 1; i <= comp.numLayers; i++) {
            if (comp.layer(i) instanceof TextLayer) return comp.layer(i);
        }
        return null;
    }

    var result = {};
    var cityComp = findCompByName("город");
    if (cityComp) {
        result.cityComp = { width: cityComp.width, height: cityComp.height, duration: cityComp.duration };
        result.cityTextLayer = layerInfo(findFirstTextLayer(cityComp));
    } else {
        result.error = "город comp not found";
    }
    var osnova = findCompByName("ОСНОВА");
    if (osnova) {
        result.cityLayerInOsnova = layerInfo(findLayerByName(osnova, "город"));
    }

    var outFile = new File(getProjectRootFolder() + "/Graph/подлоджка/city_geometry.json");
    outFile.open("w");
    outFile.write(result.toSource());
    outFile.close();
    return "OK: city_geometry.json записан";
}

// ============================================================
// ДЛИННАЯ ПЛАШКА (правый слот 761x89) — ротация новости → курс валют
// → др. Упрощённая (жёсткая) смена, как и погода — без вытеснения.
//
// Слот физически занят слоем "валюта" в "основа" — его позицию/размер
// используем как эталон для новых слоёв (новости-контент, др-контент,
// подписи-шапки). "подложка" не редактируем контентно — трогаем только
// Opacity её 4 уже существующих растровых плашек (что-то ещё/новости
// основа/курс валют/др), это чисто переключение видимости.
// ============================================================

// Тайминг блоков — см. restructureToNewSequence() (2026-08-25): новости
// без отдельного заголовка (первая новость расщеплена на хвост 0-6с и
// голову T-2..T — склейка лупа), именины сокращены до 2 эл-тов, валюта
// продлена до 8с, добавлен новый блок гороскоп (12 эл-тов). Итоговая
// длина "ОСНОВА" = 206с. Границы блоков считаются из этих констант в
// restructureToNewSequence(), не хардкодятся.
var NEWS_HEADER_DUR = 0; // отдельного заголовка у новостей больше нет
var NEWS_ITEM_DUR = 8;
// 6 (2026-08-31, по указанию пользователя): было 10, слои "новость 7..10"
// удалены из compа "новости текст" вручную, слой обрезан под 6 пунктов,
// петля в MASTER выставлена руками. Панель взаимодействует с первыми 6.
var NEWS_ITEM_COUNT = 6;
var NEWS_TAIL_DUR = 6;  // "новость 1" хвост — в начале ОСНОВА (0..6)
var NEWS_HEAD_DUR = 2;  // "новость 1" голова — в конце ОСНОВА (T-2..T)

var BIRTHDAY_HEADER_DUR = 2;
var BIRTHDAY_ITEM_DUR = 8;
var BIRTHDAY_ITEM_COUNT = 2;

var CURRENCY_HEADER_DUR = 2;
var CURRENCY_CONTENT_DUR = 8;

var HOROSCOPE_HEADER_DUR = 2;
var HOROSCOPE_ITEM_DUR = 8;
var HOROSCOPE_ITEM_COUNT = 12;

var CAPTION_FONT_SIZE = 32;
var CAPTION_COLOR = [1, 1, 1];

// Ставит Hold-keyframe на Opacity, форсируя Hold-интерполяцию у всех
// уже имеющихся ключей свойства (иначе между дальними кадрами поедет
// плавным тином). Общая утилита, как setOpacityHold, но принимает
// голое имя свойства — используется и для слоёв, и переиспользуема.
function holdOpacityAt(layer, value, t) {
    setOpacityHold(layer, value, t);
}

// Находит/создаёт композицию нужного размера (под слот 761x89) —
// используется для "новости"-контента и "др"-контента.
function ensureSlotComp(name, widthRef, heightRef, durationRef) {
    var comp = findCompByName(name);
    if (!comp) {
        // Частота кадров — как у "ОСНОВА" (50fps в проекте), а не жёсткие
        // 25 — иначе новый преком создаётся на другой частоте кадров, чем
        // весь остальной проект (эта функция раньше не вызывалась ни разу
        // вживую — см. restructureToNewSequence, 2026-08-25 — ошибка не
        // проявлялась просто потому, что кода никто не запускал).
        var osnovaRef = findCompByName("ОСНОВА");
        var frameRate = osnovaRef ? osnovaRef.frameRate : 25;
        comp = app.project.items.addComp(name, widthRef, heightRef, 1, durationRef, frameRate);
    } else {
        if (comp.width !== widthRef) comp.width = widthRef;
        if (comp.height !== heightRef) comp.height = heightRef;
        if (comp.duration < durationRef) comp.duration = durationRef;
    }
    return comp;
}

// Находит/добавляет слой compItem в osnovaComp, копируя позицию/масштаб
// с эталонного слоя (валюта) — так новый контент садится ровно в слот.
function ensureLayerLikeReference(osnovaComp, compItem, referenceLayer) {
    var layer = findLayerByName(osnovaComp, compItem.name);
    if (!layer) {
        layer = osnovaComp.layers.add(compItem);
        layer.name = compItem.name;
        layer.property("Position").setValue(referenceLayer.property("Position").value);
        layer.property("Anchor Point").setValue(referenceLayer.property("Anchor Point").value);
        layer.property("Scale").setValue(referenceLayer.property("Scale").value);
    }
    return layer;
}

// Добавляет (или переиспользует) текстовый слой-подпись в osnovaComp
// на месте эталонного слоя (той же точке, что и контент).
function ensureCaptionLayer(osnovaComp, name, text, referenceLayer) {
    var layer = findLayerByName(osnovaComp, name);
    if (!layer) {
        layer = osnovaComp.layers.addText(text);
        layer.name = name;
        var doc = layer.property("Source Text").value;
        doc.font = "Manrope-Medium";
        doc.fontSize = CAPTION_FONT_SIZE;
        doc.fillColor = CAPTION_COLOR;
        // Левое выравнивание (по образцу шапок, выровненных пользователем
        // вручную 2026-08-25: "ИМЕНИНЫ"/"ГОРОСКОП"/"КУРСЫ ВАЛЮТ") — статичный
        // anchor в [0,0], без пересчёта под центр, иначе текст "плавает" при
        // смене длины.
        doc.justification = ParagraphJustification.LEFT_JUSTIFY;
        layer.property("Source Text").setValue(doc);

        layer.property("Anchor Point").setValue([0, 0]);
        layer.property("Position").setValue(referenceLayer.property("Position").value);
    }
    return layer;
}

function findFirstTextLayerIn(comp) {
    for (var i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i) instanceof TextLayer) return comp.layer(i);
    }
    return null;
}

// ============================================================
// ПОСЛЕДОВАТЕЛЬНЫЕ ТЕКСТОВЫЕ СЛОИ — общая схема для новостей и
// именин: КАЖДЫЙ пункт — свой отдельный текстовый слой с
// обрезанными in/out point под свой тайминг (а не один слой с
// Hold-ключами на Source Text, как раньше). Так каждый пункт
// открывается и правится в AE напрямую — ключей искать не нужно,
// порядок/тайминг видно прямо на таймлайне.
// ============================================================

// Удаляет слои с данным префиксом — безопасный повторный запуск.
function removeLayersByPrefix(comp, prefix) {
    for (var i = comp.numLayers; i >= 1; i--) {
        var l = comp.layer(i);
        if (l.name.indexOf(prefix) === 0) l.remove();
    }
}

// Ищет эталонный слой пользователя — единственный текстовый слой в comp,
// чьё имя ещё не занято нашей схемой (layerPrefix). Сначала смотрит прямые
// слои comp; если там ничего нет, заглядывает на ОДИН уровень во вложенные
// прекомпы (у пользователя текст иногда лежит в под-композиции внутри
// "новости"/"др", а не прямо в них) — глубже не лезет, чтобы не хватать
// случайные текстовые слои из совсем другой части проекта.
function findExemplarLayer(comp, layerPrefix) {
    function firstMatch(c) {
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            if (l instanceof TextLayer && l.name.indexOf(layerPrefix) !== 0) return l;
        }
        return null;
    }
    var direct = firstMatch(comp);
    if (direct) return direct;
    for (var j = 1; j <= comp.numLayers; j++) {
        var lj = comp.layer(j);
        try {
            if (lj.source && lj.source instanceof CompItem) {
                var nested = firstMatch(lj.source);
                if (nested) return nested;
            }
        } catch (e) {}
    }
    return null;
}

// Дублирует эталонный слой пользователя N раз — 100% те же настройки
// (шрифт/цвет/размер/эффекты/всё), ничего не читаем и не угадываем.
// Дубль появляется в ТОЙ ЖЕ композиции, где реально лежит эталон (может
// быть под-композиция внутри comp — см. findExemplarLayer), поэтому
// работаем с exemplar.containingComp, а не с исходным comp напрямую.
function buildSequentialLayersByDuplication(comp, items, itemDur, headerDur, layerPrefix, placeholderPrefix) {
    var exemplar = findExemplarLayer(comp, layerPrefix);
    if (!exemplar) return { ok: false, message: "эталонный слой не найден в '" + comp.name + "' (и в её прямых под-композициях)" };

    var targetComp = exemplar.containingComp;
    removeLayersByPrefix(targetComp, layerPrefix);

    var cx = targetComp.width / 2, cy = targetComp.height / 2;
    var maxTextWidth = targetComp.width - 60;

    for (var i = 0; i < items.length; i++) {
        var raw = items[i] || (placeholderPrefix + " " + (i + 1));
        var layer = exemplar.duplicate(); // ключевая идея — сохраняет ВСЕ настройки эталона
        layer.name = layerPrefix + (i + 1);
        layer.enabled = true;

        var prepared = prepareNewsText(raw);
        var doc = layer.property("Source Text").value;
        doc.text = prepared.text;
        doc.fontSize = prepared.fontSize;
        doc.autoLeading = false;
        doc.leading = prepared.leading;
        layer.property("Source Text").setValue(doc);

        // авто-уменьшение шрифта, если после prepareNewsText всё равно шире слота
        var rect = layer.sourceRectAtTime(0, false);
        var guard = 0;
        while (rect.width > maxTextWidth && doc.fontSize > 14 && guard < 20) {
            doc.fontSize -= 2;
            doc.leading = doc.fontSize * 1.15;
            layer.property("Source Text").setValue(doc);
            rect = layer.sourceRectAtTime(0, false);
            guard++;
        }

        // Центрируем на том же месте, где стоял эталон (а не жёстко по
        // центру компы) — так дубль остаётся ровно там, куда его поставил
        // пользователь, даже если это не геометрический центр кадра.
        var exemplarPos = exemplar.property("Position").value;
        layer.property("Anchor Point").setValue([rect.left + rect.width / 2, rect.top + rect.height / 2]);
        layer.property("Position").setValue(exemplarPos);

        // Свежий дубль наследует inPoint/outPoint эталона как есть — если
        // целевой inPoint окажется правее ЭТОГО унаследованного outPoint
        // (типичный случай: эталон "Др 1" стоит на 80-88с, а новый блок
        // начинается на 108с), прямое присвоение layer.inPoint кинет
        // ошибку AE ("invalid in/out point") на промежуточном шаге —
        // используем ту же безопасную схему, что и setLayerTimingSafe.
        var targetIn = headerDur + i * itemDur;
        var targetOut = headerDur + (i + 1) * itemDur;
        var safelyFar = Math.max(layer.inPoint, layer.outPoint, targetIn, targetOut) + 100;
        layer.outPoint = safelyFar;
        layer.inPoint = targetIn;
        layer.outPoint = targetOut;
    }
    exemplar.enabled = false; // эталон больше не нужен как контент — прячем
    return { ok: true };
}

// ============================================================
// СХЕМА БЛОКА "новости → др → валюта" — инфраструктура, не
// зависящая от контента: композиции-слоты, их положение в
// "основа" (по образцу уже существующего слоя "валюта" — он же
// эталон позиции/масштаба/размера), подписи-шапки и Opacity-Hold
// расписание видимости трёх блоков подряд (0–59 новости / 59–118
// др / 118–126 валюта — границы считаются из констант вверху
// файла). Идемпотентна — безопасно звать перед каждым apply*.
// ============================================================
function ensureRightBlockScaffold() {
    var osnova = findCompByName("ОСНОВА");
    var podlozhka = findCompByName("подложка");
    var valutaLayerRef = findLayerByName(osnova, "валюта");
    if (!osnova) return "ERROR: comp not found: основа";
    if (!valutaLayerRef) return "ERROR: layer 'валюта' not found in основа (нужен как эталон позиции/размера)";

    var TD = osnova.duration;
    var newsHeaderEnd = NEWS_HEADER_DUR;
    var newsContentEnd = newsHeaderEnd + NEWS_ITEM_COUNT * NEWS_ITEM_DUR;
    var birthdayHeaderEnd = newsContentEnd + BIRTHDAY_HEADER_DUR;
    var birthdayContentEnd = birthdayHeaderEnd + BIRTHDAY_ITEM_COUNT * BIRTHDAY_ITEM_DUR;
    var currencyHeaderEnd = birthdayContentEnd + CURRENCY_HEADER_DUR;
    var currencyContentEnd = currencyHeaderEnd + CURRENCY_CONTENT_DUR; // == TD, если константы сходятся

    // "валюта" уже существует как готовая композиция — берём её размер
    // эталоном для "новости"/"др", вместо того чтобы гадать пиксели.
    var valutaComp = findCompByName("валюта");
    var refW = valutaComp ? valutaComp.width : 761;
    var refH = valutaComp ? valutaComp.height : 89;

    // --- 1) Композиции-контейнеры для новостей/др ---
    var newsComp = ensureSlotComp("новости", refW, refH, TD);
    var birthdayComp = ensureSlotComp("др", refW, refH, TD);

    // --- 2) Слои в "основа" на месте валюты (та же поз/якорь/масштаб) ---
    var newsLayer = ensureLayerLikeReference(osnova, newsComp, valutaLayerRef);
    var birthdayLayer = ensureLayerLikeReference(osnova, birthdayComp, valutaLayerRef);

    // КРИТИЧНО: без этого смещения локальный ноль композиции "др" совпадает
    // с глобальным нулём "основа" — то есть в момент, когда "др" должна быть
    // видна (глобальные 59–118), она показывает свои же локальные 59–118, а
    // весь контент лежит в локальных 0–59. "новости" это не задевало только
    // потому что её блок и так стартует с глобального 0 (совпадение).
    newsLayer.startTime = 0;
    birthdayLayer.startTime = newsContentEnd;

    var newsCaption = ensureCaptionLayer(osnova, "cap_news", "новости", valutaLayerRef);
    var birthdayCaption = ensureCaptionLayer(osnova, "cap_birthday", "именины", valutaLayerRef);
    var currencyCaption = ensureCaptionLayer(osnova, "cap_currency", "курс валют", valutaLayerRef);

    // --- 3) Opacity-расписание в "основа": новости / др / валюта ---
    var elems = [newsLayer, birthdayLayer, valutaLayerRef, newsCaption, birthdayCaption, currencyCaption];
    for (var e = 0; e < elems.length; e++) {
        clearKeyframes(elems[e].property("Opacity"));
    }

    holdOpacityAt(newsCaption, 100, 0);
    holdOpacityAt(newsCaption, 0, newsHeaderEnd);

    holdOpacityAt(newsLayer, 0, 0);
    holdOpacityAt(newsLayer, 100, newsHeaderEnd);
    holdOpacityAt(newsLayer, 0, newsContentEnd);

    holdOpacityAt(birthdayCaption, 0, 0);
    holdOpacityAt(birthdayCaption, 100, newsContentEnd);
    holdOpacityAt(birthdayCaption, 0, birthdayHeaderEnd);

    holdOpacityAt(birthdayLayer, 0, 0);
    holdOpacityAt(birthdayLayer, 100, birthdayHeaderEnd);
    holdOpacityAt(birthdayLayer, 0, birthdayContentEnd);

    holdOpacityAt(currencyCaption, 0, 0);
    holdOpacityAt(currencyCaption, 100, birthdayContentEnd);
    holdOpacityAt(currencyCaption, 0, currencyHeaderEnd);

    holdOpacityAt(valutaLayerRef, 0, 0);
    holdOpacityAt(valutaLayerRef, 100, currencyHeaderEnd);

    // --- 4) Opacity-расписание для растровых плашек в "подложка" ---
    // (только видимость, дизайн/позиции не трогаем) — сопоставляем по
    // ИМЕНИ плашки с её блоком-контентом, а не по старому порядку.
    if (podlozhka) {
        var plateChtoTo = findLayerByName(podlozhka, "что-то ещё");
        var plateNewsBase = findLayerByName(podlozhka, "новости основа");
        var plateBirthday = findLayerByName(podlozhka, "др");
        var plateCurrency = findLayerByName(podlozhka, "курс валют");
        var plates = [plateChtoTo, plateNewsBase, plateBirthday, plateCurrency];
        for (var p = 0; p < plates.length; p++) {
            if (plates[p]) clearKeyframes(plates[p].property("Opacity"));
        }

        if (plateChtoTo) {
            holdOpacityAt(plateChtoTo, 100, 0);
            holdOpacityAt(plateChtoTo, 0, newsHeaderEnd);
        }
        if (plateNewsBase) {
            holdOpacityAt(plateNewsBase, 0, 0);
            holdOpacityAt(plateNewsBase, 100, newsHeaderEnd);
            holdOpacityAt(plateNewsBase, 0, newsContentEnd);
        }
        if (plateBirthday) {
            holdOpacityAt(plateBirthday, 0, 0);
            holdOpacityAt(plateBirthday, 100, newsContentEnd);
            holdOpacityAt(plateBirthday, 0, birthdayContentEnd);
        }
        if (plateCurrency) {
            holdOpacityAt(plateCurrency, 0, 0);
            holdOpacityAt(plateCurrency, 100, birthdayContentEnd);
        }
    }

    return "OK: шапка_новостей 0-" + newsHeaderEnd +
        ", новости " + newsHeaderEnd + "-" + newsContentEnd +
        ", шапка_др " + newsContentEnd + "-" + birthdayHeaderEnd +
        ", др " + birthdayHeaderEnd + "-" + birthdayContentEnd +
        ", шапка_валют " + birthdayContentEnd + "-" + currencyHeaderEnd +
        ", валюта " + currencyHeaderEnd + "-" + currencyContentEnd;
}

// itemsJson: JSON-массив из 10 строк (новости_черновик.docx через панель).
// Композиция "новости текст" уже готова руками пользователя — в ней лежат
// 10 отдельных текстовых слоёв "новость 1".."новость 10" со своим таймингом.
// Ничего не создаём и не дублируем — только меняем Source Text у каждого
// существующего слоя. Применяем ту же адаптацию под размер плашки, что и
// везде в файле (prepareNewsText + shrink-guard по sourceRectAtTime) —
// иначе длинная новость переносится на 2-ю строку и вылезает за нижний
// край 89px-плашки. Позицию/якорь пересчитываем так, чтобы видимый центр
// текста остался там же, где его поставил пользователь (а не съехал).
// items[i] теперь объект {text, mode} — mode приходит с кнопки-переключателя
// в панели ("auto"/"1"/"2"). Для обратной совместимости, если прилетела
// голая строка (старый вызов), тоже работает — просто mode будет "auto".
function applyNewsItems(itemsJson) {
    var items = JSON.parse(itemsJson);
    var comp = findCompByName("новости текст");
    if (!comp) return "ERROR: comp not found: новости текст";

    app.beginUndoGroup("Включайся!: новости (10 слоёв, 2 строки)");
    var results = [];
    try {
        // Левое выравнивание (2026-08-25): базовая X/Y-точка берётся у
        // "новость 1" — эталона, который пользователь выровнял вручную —
        // читаем её ОДИН РАЗ здесь, ДО цикла (иначе после того, как цикл
        // перезапишет саму "новость 1" своим же новым текстом, эталон уже
        // не будет совпадать с тем, что видел пользователь при ручной
        // правке).
        // Метрики (позиция/anchor/fontSize для 1- и 2-строчного случая) —
        // единый эталон "новость 1"/"_верхняя"/"_нижняя" (2026-08-28, см.
        // getTemplateTextMetrics) — используется теперь и гороскопом, и др.
        var metrics = getTemplateTextMetrics();
        if (!metrics) { app.endUndoGroup(); return "ERROR: эталонный слой 'новость 1' не найден"; }
        if (!metrics.hasTwoLineRef) {
            results.push("ВНИМАНИЕ: эталон верх/низ не найден ('новость 1_верхняя'/'новость 1_нижняя') — 2-строчные пункты позиционируются формулой baseY±leading/2 (fallback)");
        }

        for (var i = 1; i <= NEWS_ITEM_COUNT; i++) {
            var layerName = "новость " + i;
            var line1 = findLayerByName(comp, layerName);
            if (!line1) { results.push(layerName + ": слой не найден"); continue; }
            var line2 = ensureLine2Layer(comp, line1, layerName + " _2");

            var itemVal = items[i - 1];
            var isObj = itemVal && typeof itemVal === "object";
            var raw = (isObj ? itemVal.text : itemVal) || ("Новость " + i);
            var mode = (isObj && itemVal.mode) || "auto";

            var prepared = prepareNewsText(raw, mode);
            var lines = prepared.text.split("\r");
            applyLinesLayoutCore(line1, line2, lines, metrics);
            results.push(layerName + ": OK (" + (line2.enabled ? "2 стр." : "1 стр.") + ")");
            // Примечание: "новость 1" не расщеплена на отдельный слой внутри
            // этого compа — склейка лупа сделана слоем-дублем ВСЕГО compа
            // "новости текст" на уровне ОСНОВА ("новости текст первая
            // новость", отдельный инстанс той же композиции, окно 204-206с,
            // показывает первые 2с "новости 1"). Раз это тот же самый comp,
            // а не копия слоя — текст синхронизируется сам собой, отдельно
            // ничего мирpoжить не нужно.
        }
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "OK: " + results.join(" | ");
}

// itemsJson: JSON-массив из 10 {text, mode} (др_черновик.docx через панель).
// Композиция "др текст" уже готова руками пользователя — в ней лежат 10
// отдельных текстовых слоёв "Др 1".."Др 10" со своим таймингом. Зеркало
// applyNewsItems (см. её комментарий) — ничего не создаём/не дублируем,
// только текст + подгонка размера под плашку (89px, box-текст переносит
// строку сам, поэтому проверяем и ширину, и реальную высоту рендера).
function applyBirthdayItems(itemsJson) {
    var items = JSON.parse(itemsJson);
    var comp = findCompByName("др текст");
    if (!comp) return "ERROR: comp not found: др текст";

    app.beginUndoGroup("Включайся!: именины (10 слоёв, 2 строки)");
    var results = [];
    try {
        var maxTextWidth = comp.width - 60;
        var maxTextHeight = comp.height - 10;
        var targetCenterX = comp.width / 2;
        var targetCenterY = comp.height / 2;

        for (var i = 1; i <= BIRTHDAY_ITEM_COUNT; i++) {
            var layerName = "Др " + i;
            var line1 = findLayerByName(comp, layerName);
            if (!line1) { results.push(layerName + ": слой не найден"); continue; }
            var line2 = ensureLine2Layer(comp, line1, layerName + " _2");

            var itemVal = items[i - 1];
            var isObj = itemVal && typeof itemVal === "object";
            var raw = (isObj ? itemVal.text : itemVal) || ("Именинник " + i);
            var mode = (isObj && itemVal.mode) || "auto";

            applyTwoLineLayout(line1, line2, raw, mode, targetCenterX, targetCenterY, maxTextWidth, maxTextHeight);
            results.push(layerName + ": OK (" + (line2.enabled ? "2 стр." : "1 стр.") + ")");
        }
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "OK: " + results.join(" | ");
}

// ============================================================
// ИМЕНИНЫ v3 (2026-08-25) — вернулись к ОДНОЙ плашке с текстом (v2 —
// сетка 2x2 из 4 слоёв на плашку — отменена пользователем). Все до 8
// имён идут ЧЕРЕЗ ЗАПЯТУЮ в ОДИН текстовый слой, в 2 строки (первая
// половина имён — строка 1, вторая половина — строка 2) — по тому же
// принципу, что новости/гороскоп. Размер шрифта — тот же фиксированный
// TEXT_FONT_SIZE (26pt), что у новостей/др/гороскопа (см. prepareNewsText).
// Идемпотентно консолидирует: если в comp'е ещё остались старые слоты
// из v2 (несколько текстовых слоёв "Др N") — оставляет ПЕРВЫЙ найденный
// как основу, остальные удаляет, переименовывает в "именины".
// ============================================================

// kalendarik.com.ua/kalendar-imenin сам берёт имена из ПУБЛИЧНОГО Google-
// календаря через встроенный виджет fullCalendar (видно в исходном коде
// их страницы) — используем тот же calendarId/apiKey напрямую. Ключ
// ограничен по HTTP Referer (только их домен) — из браузера панели
// (CEF) подделать Referer не вышло (403, CEF режет fetch()'s referrer-
// override), поэтому дёргаем через system.callSystem() + curl.exe (он
// есть в Windows 10+ из коробки) — это уже обычный процесс ОС, а не
// браузер, никаких referrer-ограничений CEF на него не действует.
var KALENDARIK_CALENDAR_ID = "cqpsf8p8gdtlqgct8214ogksp8@group.calendar.google.com";
var KALENDARIK_API_KEY = "AIzaSyB7c92Fs1XpRLuUhJVH5lS4JGH0Esldo2w";
var KALENDARIK_REFERRER = "https://www.kalendarik.com.ua/kalendar-imenin";

function pad2(n) { return (n < 10 ? "0" : "") + n; }

// Возвращает JSON-массив строк (имена на выбранный день, обычно 20-30 штук)
// или "ERROR: ...". Панель сама выбирает из него 8 случайных.
// argsJson: { dateISO: "yyyy-mm-dd" } — день выпуска из панели; без него — сегодня.
function fetchNamedaysToday(argsJson) {
    var args = {};
    try { args = argsJson ? JSON.parse(argsJson) : {}; } catch (e) { args = {}; }
    var base;
    if (args.dateISO && /^\d{4}-\d{2}-\d{2}$/.test(args.dateISO)) {
        var p = args.dateISO.split("-");
        base = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    } else {
        base = new Date();
    }
    var dateStr = base.getFullYear() + "-" + pad2(base.getMonth() + 1) + "-" + pad2(base.getDate());
    var next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
    var nextStr = next.getFullYear() + "-" + pad2(next.getMonth() + 1) + "-" + pad2(next.getDate());

    var url = "https://www.googleapis.com/calendar/v3/calendars/" +
        encodeURIComponent(KALENDARIK_CALENDAR_ID) + "/events" +
        "?key=" + KALENDARIK_API_KEY +
        "&timeMin=" + dateStr + "T00:00:00Z" +
        "&timeMax=" + nextStr + "T00:00:00Z" +
        "&singleEvents=true&timeZone=" + encodeURIComponent("Europe/Kiev") +
        "&fields=" + encodeURIComponent("items(summary)");

    var cmd = 'curl -s -e "' + KALENDARIK_REFERRER + '" "' + url + '"';
    var output;
    try {
        output = system.callSystem(cmd);
    } catch (e) {
        return "ERROR: system.callSystem не сработал (curl.exe не найден в PATH?): " + e.toString();
    }
    if (!output) return "ERROR: пустой ответ от curl";

    var data;
    try {
        data = JSON.parse(output);
    } catch (e2) {
        return "ERROR: не удалось распарсить ответ curl: " + output.substring(0, 300);
    }
    if (data.error) return "ERROR: Google Calendar API: " + (data.error.message || JSON.stringify(data.error));

    var names = [];
    var items = data.items || [];
    for (var i = 0; i < items.length; i++) {
        if (items[i].summary) names.push(items[i].summary);
    }
    return JSON.stringify(names);
}

// rawJson: JSON-строка — СЫРОЙ текст из поля панели, как он есть (не
// массив имён!). Имена — через запятую. Правило строк (2026-08-25,
// прямое указание пользователя): 1-4 имени -> 1 строка; 5-8 имён -> 2
// строки, ceil(count/2) сверху / остаток снизу. Если пользователь САМ
// вставил перенос строки (Enter) в поле — это явное указание, где
// начинается 2-я строка (тот же принцип, что и у новостей/гороскопа в
// prepareNewsText) — побеждает авто-правило 1-4/5-8 полностью.
//
// Обновлено 2026-08-28: раньше был единственный box-текстовый слой
// "именины" (перенос строки внутри одного paragraph text через \r), а
// перед этим стояла "консолидация" — брала ПЕРВЫЙ по индексу TextLayer
// в comp'е как основу и удаляла ВСЕ остальные (это чистило хвосты от
// старой v2-сетки 2x2). Пользователь добавил 2 постоянных эталонных
// слоя — "именины верх"/"именины низ" (по образцу "новость 1_верхняя"/
// "_нижняя") — и они оказались в comp'е ВЫШЕ по индексу, чем реальная
// "именины". Старая консолидация ловила "именины верх" как candidates[0],
// переименовывала её в "именины" и УДАЛЯЛА настоящую "именины" и
// "именины низ" — отсюда баг "текст сместился вверх, нижняя строка
// пропала". Консолидация убрана целиком; слои теперь ищутся строго по
// имени (findLayerByNameLoose/CI), эталоны никогда не трогаются/не
// удаляются. Архитектура — та же line1/line2, что у новостей/гороскопа
// (applyLinesLayoutCore): "именины" = line1 И одновременно 1-строчный
// эталон (этот comp не ротирует 10/12 пунктов, как новости/гороскоп —
// это единственный вечнозелёный слот, так что читать его Position живьём
// безопасно, риска самопорчи тут нет, хардкод не нужен).
function applyBirthdayNames(rawJson) {
    var raw = JSON.parse(rawJson) || "";
    var comp = findCompByName("др текст");
    if (!comp) return "ERROR: comp not found: др текст";

    app.beginUndoGroup("Включайся!: именины (эталон верх/низ)");
    var warn = "";
    var fullTextReport = "";
    try {
        var ref1 = findLayerByNameLoose(comp, "именины") || findLayerByNameCI(comp, "именины");
        if (!ref1) { app.endUndoGroup(); return "ERROR: эталонный слой 'именины' не найден"; }

        // fontSize (2026-08-28) - берём общий с новостями через
        // getTemplateTextMetrics(): это просто число, anchor/шрифт тут ни
        // при чём, конфликта нет (см. правило "высота текста одинаковая").
        var metrics = getTemplateTextMetrics();
        if (!metrics) { app.endUndoGroup(); return "ERROR: эталонный слой 'новость 1' (новости текст) не найден"; }

        // Позиция/anchor - НЕ у новостей (2026-08-28, посчитано, не
        // гадание): у др другой шрифт (LucidaConsole) и другой anchor -
        // сырые X/Y от новостей физически не дают тот же экранный
        // результат, что у новостей (формула screen = Position +
        // (sourceRect - Anchor) даёт разные числа для разных anchor).
        // Проверено на скриншоте: с сырыми X/Y новостей др "уезжает вниз
        // и влево". Поэтому др — как и новости — получает СВОЙ
        // собственный постоянный слой-эталон "именины_эталон" (см.
        // ensureBirthdayOneLineTemplate), а 2-строчная раскладка — свои
        // "именины верх"/"именины низ" (никогда не трогаются кодом).
        var drRefUpper = findLayerByNameLoose(comp, "именины верх") || findLayerByNameCI(comp, "именины верх");
        var drRefLower = findLayerByNameLoose(comp, "именины низ") || findLayerByNameCI(comp, "именины низ");
        var drOneLine = ensureBirthdayOneLineTemplate(comp, drRefUpper);
        var drOwnAnchor = drRefUpper ? drRefUpper.property("Anchor Point").value
            : (drRefLower ? drRefLower.property("Anchor Point").value : ref1.property("Anchor Point").value);
        if (!drRefUpper || !drRefLower) {
            warn = " | ВНИМАНИЕ: эталон верх/низ не найден ('именины верх'/'именины низ') - 2-строчные именины позиционируются формулой (fallback)";
        }
        var drOneLineSource = drOneLine || ref1;
        var drMetrics = {
            oneLineX: drOneLineSource.property("Position").value[0],
            oneLineY: drOneLineSource.property("Position").value[1],
            twoLineX: drRefUpper ? drRefUpper.property("Position").value[0] : drOneLineSource.property("Position").value[0],
            upperY: drRefUpper ? drRefUpper.property("Position").value[1] : null,
            lowerY: drRefLower ? drRefLower.property("Position").value[1] : null,
            oneLineFontSize: metrics.oneLineFontSize, twoLineFontSize: metrics.twoLineFontSize,
            oneLineAnchor: drOwnAnchor,
            upperAnchor: drRefUpper ? drRefUpper.property("Anchor Point").value : drOwnAnchor,
            lowerAnchor: drRefLower ? drRefLower.property("Anchor Point").value : drOwnAnchor
        };

        var line2 = ensureLine2Layer(comp, ref1, "именины _2");

        // ExtendScript (ES3) не поддерживает Array.prototype.map/filter —
        // отсюда была "ReferenceError: Function raw.split().map is
        // undefined". Только обычные циклы + split/join (ES3-безопасны).
        function trimStr(s) {
            return (s || "").replace(/^\s+|\s+$/g, "");
        }
        function splitTrimFilter(s, sep) {
            var parts = (s || "").split(sep);
            var out = [];
            for (var p = 0; p < parts.length; p++) {
                var t = trimStr(parts[p]);
                if (t.length > 0) out.push(t);
            }
            return out;
        }
        function cleanCommaList(s) {
            return splitTrimFilter(s, ",").join(", ");
        }

        var line1Text, line2Text, allNames;
        var hasManualBreak = /[\r\n]/.test(raw);
        if (hasManualBreak) {
            var parts = raw.split(/\r\n|\r|\n/);
            line1Text = cleanCommaList(parts[0]);
            line2Text = cleanCommaList(parts.slice(1).join(","));
            allNames = splitTrimFilter(raw.replace(/[\r\n]/g, ","), ",");
        } else {
            allNames = splitTrimFilter(raw, ",");
            var count = Math.min(allNames.length, 8);
            if (count <= 4) {
                line1Text = allNames.slice(0, count).join(", ");
                line2Text = "";
            } else {
                var half = Math.ceil(count / 2);
                line1Text = allNames.slice(0, half).join(", ");
                line2Text = allNames.slice(half, count).join(", ");
            }
        }
        var lines = line2Text ? [line1Text, line2Text] : [line1Text];
        fullTextReport = lines.join(" / ");

        // Шрифт НЕ задаём явно - applyLinesLayoutCore и так не трогает
        // font, только fontSize/leading/text (сохраняется тот, что уже
        // стоит на "именины"). anchor - drMetrics (см. выше), не metrics.
        applyLinesLayoutCore(ref1, line2, lines, drMetrics);
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "OK: именины -> \"" + fullTextReport + "\"" + warn;
}

// itemsJson: JSON-массив из 12 {text, mode} — блок "гороскоп" (см.
// restructureToNewSequence). Зеркало applyNewsItems/applyBirthdayItems:
// комп "гороскоп текст" уже содержит 12 слоёв "Гороскоп 1".."Гороскоп 12"
// (построены дублированием стиля "Др 1"), тут только текст + подгонка
// размера, ничего не создаём.
function applyHoroscopeItems(itemsJson) {
    var items = JSON.parse(itemsJson);
    var comp = findCompByName("гороскоп текст");
    if (!comp) return "ERROR: comp not found: гороскоп текст";

    app.beginUndoGroup("Включайся!: гороскоп (12 слоёв, 2 строки)");
    var results = [];
    try {
        // Левое выравнивание (2026-08-25) — см. комментарий в applyNewsItems:
        // базовая X/Y-точка читается у "гороскоп 1" ОДИН РАЗ, до цикла.
        // Метрики (2026-08-28) — единый эталон "новость 1"/"_верхняя"/
        // "_нижняя" из comp'а "новости текст" (см. getTemplateTextMetrics)
        // — гороскоп больше не считает позицию/размер по своим собственным
        // "гороскоп 1"/"_верохний"/"_нижний" (эти слои остаются в проекте,
        // просто больше не читаются). Причина: X у "гороскоп 1" и
        // "_верохний"/"_нижний" разошёлся после того, как пользователь
        // подвинул композиции — единый источник этого больше не допускает.
        var metrics = getTemplateTextMetrics();
        if (!metrics) { app.endUndoGroup(); return "ERROR: эталонный слой 'новость 1' (новости текст) не найден — не могу взять эталон размера/расположения"; }
        if (!metrics.hasTwoLineRef) {
            results.push("ВНИМАНИЕ: эталон верх/низ не найден ('новость 1_верхняя'/'новость 1_нижняя') — 2-строчные пункты позиционируются формулой baseY±leading/2 (fallback)");
        }

        for (var i = 1; i <= HOROSCOPE_ITEM_COUNT; i++) {
            // Слои построены пользователем вручную как "гороскоп N"
            // (строчными) — не "Гороскоп N", как было в неиспользованном
            // restructureToNewSequence. Ищем case-insensitive на случай,
            // если регистр где-то не совпадёт 1-в-1.
            var layerName = "гороскоп " + i;
            var line1 = findLayerByNameLoose(comp, layerName) || findLayerByNameCI(comp, layerName);
            if (!line1) { results.push(layerName + ": слой не найден"); continue; }
            var line2 = ensureLine2Layer(comp, line1, layerName + " _2");

            var itemVal = items[i - 1];
            var isObj = itemVal && typeof itemVal === "object";
            var raw = (isObj ? itemVal.text : itemVal) || ("Знак " + i);
            var mode = (isObj && itemVal.mode) || "auto";

            var prepared = prepareNewsText(raw, mode);
            var lines = prepared.text.split("\r");
            applyLinesLayoutCore(line1, line2, lines, metrics);
            results.push(layerName + ": OK (" + (line2.enabled ? "2 стр." : "1 стр.") + ")");
        }
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "OK: " + results.join(" | ");
}

// ============================================================
// РАЗОВОЕ выравнивание УЖЕ существующих слоёв "новость 2..10"/
// "гороскоп 2..12" по образцу "новость 1"/"гороскоп 1" (2026-08-25,
// v2 — первая версия копировала только 3 свойства (Anchor/Position/
// justification) и этого оказалось недостаточно — пользователь внёс
// в эталон и другие правки (box-отступ, высота текста и т.п.),
// которые точечное копирование неизбежно упускало). Теперь — по
// принципу buildSequentialLayersByDuplication (host.jsx:548):
// ДУБЛИРУЕМ эталонный слой (100% его настроек, что бы там ни было),
// возвращаем на дубль только СВОЙ текст и СВОЙ тайминг (это у каждого
// пункта уникально), старый слой удаляем. Так гарантированно "как
// первый" — ничего не забудется, потому что ничего не копируется
// вручную по одному свойству.
// ============================================================
function realignExistingTextItems() {
    function cloneOnto(refLayer, oldLayer, newName) {
        var oldDoc = oldLayer.property("Source Text").value;
        var oldIn = oldLayer.inPoint, oldOut = oldLayer.outPoint, oldEnabled = oldLayer.enabled;

        var dup = refLayer.duplicate(); // 100% свойств эталона — шрифт/цвет/box/anchor/position/всё
        dup.name = newName;
        dup.enabled = oldEnabled;

        // Возвращаем СВОЙ текст (эталон принёс только оформление)
        var doc = dup.property("Source Text").value;
        doc.text = oldDoc.text;
        dup.property("Source Text").setValue(doc);

        // Возвращаем СВОЙ тайминг (у каждого пункта свой слот) — та же
        // безопасная схема, что и в buildSequentialLayersByDuplication
        // (host.jsx:590-598), чтобы не словить "invalid in/out point".
        var safelyFar = Math.max(dup.inPoint, dup.outPoint, oldIn, oldOut) + 100;
        dup.outPoint = safelyFar;
        dup.inPoint = oldIn;
        dup.outPoint = oldOut;

        oldLayer.remove();
        return dup;
    }

    function realignComp(compName, itemPrefix, itemCount) {
        var comp = findCompByName(compName);
        if (!comp) return "ERROR: comp not found: " + compName;
        var ref1 = findLayerByNameLoose(comp, itemPrefix + "1") || findLayerByNameCI(comp, itemPrefix + "1");
        if (!ref1) return "ERROR: эталон не найден: " + itemPrefix + "1";
        var ref2 = findLayerByName(comp, itemPrefix + "1 _2"); // эталон 2-й строки, если есть

        var results = [];
        for (var i = 2; i <= itemCount; i++) { // с 1-го начинать не нужно — это и есть эталон
            var name = itemPrefix + i;
            var oldLine1 = findLayerByNameLoose(comp, name) || findLayerByNameCI(comp, name);
            if (!oldLine1) { results.push(name + ": не найден"); continue; }
            var oldLine2 = findLayerByName(comp, name + " _2");

            cloneOnto(ref1, oldLine1, name);
            if (oldLine2 && ref2) {
                cloneOnto(ref2, oldLine2, name + " _2");
            } else if (oldLine2) {
                oldLine2.remove(); // нет эталона 2-й строки — прежний вариант всё равно неверный, убираем
            }
            results.push(name + ": OK");
        }
        return "OK: " + results.join(" | ");
    }

    app.beginUndoGroup("Включайся!: выравнивание по левому краю (разово)");
    var r1, r2;
    try {
        r1 = realignComp("новости текст", "новость ", NEWS_ITEM_COUNT);
        r2 = realignComp("гороскоп текст", "гороскоп ", HOROSCOPE_ITEM_COUNT);
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "НОВОСТИ: " + r1 + " || ГОРОСКОП: " + r2;
}

// ============================================================
// ПЕРЕСБОРКА ТЕКСТА ПО ЭТАЛОНУ (2026-08-31) — разово меняет размер/позицию
// ВСЕХ пунктов новостей/гороскопа/др под текущее состояние эталонных слоёв,
// БЕЗ повторной загрузки docx. Читает текущий текст каждого пункта (1 или
// 2 строки — по line2.enabled) и гоняет тот же applyLinesLayoutCore со
// свежими метриками, что и applyNewsItems/applyHoroscopeItems.
// Сначала проставляет TEXT_FONT_SIZE на эталонные слои — размер руками
// менять не нужно, при желании только подвинуть Y эталона.
// ВНИМАНИЕ: снимает Position-keyframes у пунктов — после запуска надо
// заново «Применить переходы».
// ============================================================
function setLayerFontSize(layer, fs) {
    if (!layer) return false;
    try {
        var tp = layer.property("Source Text");
        var d = tp.value;
        d.fontSize = fs;
        d.autoLeading = false;
        d.leading = fs * 1.15;
        tp.setValue(d);
        return true;
    } catch (e) { return false; }
}

// Текущий текст пункта -> {l1, lines[1|2]}. name — полное имя слоя строки 1.
function currentItemLines(comp, name) {
    var l1 = findLayerByNameLoose(comp, name) || findLayerByNameCI(comp, name);
    if (!l1) return null;
    var l2 = findLayerByName(comp, name + " _2");
    var t1 = "";
    try { t1 = l1.property("Source Text").value.text || ""; } catch (e) {}
    if (l2 && l2.enabled) {
        var t2 = "";
        try { t2 = l2.property("Source Text").value.text || ""; } catch (e2) {}
        return { l1: l1, lines: [t1, t2] };
    }
    if (t1.indexOf("\r") !== -1 || t1.indexOf("\n") !== -1) {
        var parts = t1.split(/\r\n|\r|\n/);
        return { l1: l1, lines: [parts[0] || "", parts.slice(1).join(" ")] };
    }
    return { l1: l1, lines: [t1] };
}

function restyleAllTextItems() {
    var newsComp = findCompByName("новости текст");
    if (!newsComp) return "ERROR: comp not found: новости текст";
    var horoComp = findCompByName("гороскоп текст");
    var drComp = findCompByName("др текст");

    app.beginUndoGroup("Включайся!: пересборка текста по эталону (" + TEXT_FONT_SIZE + "pt)");
    var out = [];
    try {
        // 1) размер на эталонные слои
        var newsRefs = ["новость 1_верхняя", "новость 1_нижняя", "новость 1_эталон"];
        for (var r = 0; r < newsRefs.length; r++) setLayerFontSize(findLayerByName(newsComp, newsRefs[r]), TEXT_FONT_SIZE);
        if (drComp) {
            var drRefs = ["именины верх", "именины низ", "именины_эталон", "именины"];
            for (var d = 0; d < drRefs.length; d++) setLayerFontSize(findLayerByNameLoose(drComp, drRefs[d]) || findLayerByNameCI(drComp, drRefs[d]), TEXT_FONT_SIZE);
        }

        // 2) метрики (уже с новым размером + актуальными позициями)
        var metrics = getTemplateTextMetrics();
        if (!metrics) { app.endUndoGroup(); return "ERROR: эталон 'новость 1' не найден"; }

        function doComp(comp, prefix, count) {
            var rr = [];
            for (var i = 1; i <= count; i++) {
                var name = prefix + i;
                var cur = currentItemLines(comp, name);
                if (!cur) { rr.push(name + ":нет"); continue; }
                var line2 = ensureLine2Layer(comp, cur.l1, name + " _2");
                applyLinesLayoutCore(cur.l1, line2, cur.lines, metrics);
                rr.push(name + ":" + (cur.lines.length > 1 ? "2" : "1"));
            }
            return rr.join(" ");
        }

        out.push("НОВОСТИ [" + doComp(newsComp, "новость ", NEWS_ITEM_COUNT) + "]");
        if (horoComp) out.push("ГОРОСКОП [" + doComp(horoComp, "гороскоп ", HOROSCOPE_ITEM_COUNT) + "]");

        // 3) др — размер общий, ПОЗИЦИЯ из своих эталонов (у др другой шрифт/anchor)
        if (drComp) {
            var drRef1 = findLayerByNameLoose(drComp, "именины") || findLayerByNameCI(drComp, "именины");
            if (drRef1) {
                var drRefUpper = findLayerByNameLoose(drComp, "именины верх") || findLayerByNameCI(drComp, "именины верх");
                var drRefLower = findLayerByNameLoose(drComp, "именины низ") || findLayerByNameCI(drComp, "именины низ");
                var drOneLineSource = ensureBirthdayOneLineTemplate(drComp, drRefUpper) || drRef1;
                var drAnc = drRefUpper ? drRefUpper.property("Anchor Point").value
                    : (drRefLower ? drRefLower.property("Anchor Point").value : drRef1.property("Anchor Point").value);
                var drMetrics = {
                    oneLineX: drOneLineSource.property("Position").value[0],
                    oneLineY: drOneLineSource.property("Position").value[1],
                    twoLineX: drRefUpper ? drRefUpper.property("Position").value[0] : drOneLineSource.property("Position").value[0],
                    upperY: drRefUpper ? drRefUpper.property("Position").value[1] : null,
                    lowerY: drRefLower ? drRefLower.property("Position").value[1] : null,
                    oneLineFontSize: metrics.oneLineFontSize, twoLineFontSize: metrics.twoLineFontSize,
                    oneLineAnchor: drAnc,
                    upperAnchor: drRefUpper ? drRefUpper.property("Anchor Point").value : drAnc,
                    lowerAnchor: drRefLower ? drRefLower.property("Anchor Point").value : drAnc
                };
                var drCur = currentItemLines(drComp, "именины");
                var dLine2 = ensureLine2Layer(drComp, drRef1, "именины _2");
                applyLinesLayoutCore(drRef1, dLine2, drCur.lines, drMetrics);
                out.push("ДР [именины:" + (drCur.lines.length > 1 ? "2" : "1") + "]");
            }
        }
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "OK (" + TEXT_FONT_SIZE + "pt): " + out.join(" || ") + " || дальше — «Применить переходы»";
}

// ============================================================
// КУРС ВАЛЮТ — точечная подстановка текста, БЕЗ раскладки. Слои уже
// готовы и стоят на нужном месте (пользователь сделал их руками) — мы
// только меняем цифру курса, ничего не двигаем и не пересчитываем.
// Слои найдены по стабильному имени (rate_RUB/rate_CNY/rate_USD —
// пользователь переименовал их сам в AE один раз); код валюты
// (RUB 100/CNY 10/USD) не меняется и не трогается вообще.
// ============================================================
// ratesJson: [{code:"USD", rate:"2.98"}, {code:"CNY", rate:"4.44"}, {code:"RUB", rate:"3.58"}]
// Ищет слой по имени как обычно, но если точного совпадения нет — пробует
// ещё раз, срезав пробелы по краям с обеих сторон. Нужно из-за слоя
// " rate_RUB" в композиции "валюта" — у него случайно есть пробел в начале
// имени, и findLayerByName его точным сравнением не находил.
function findLayerByNameLoose(comp, name) {
    var exact = findLayerByName(comp, name);
    if (exact) return exact;
    var target = name.replace(/^\s+|\s+$/g, "");
    for (var i = 1; i <= comp.numLayers; i++) {
        var l = comp.layer(i);
        if (l.name.replace(/^\s+|\s+$/g, "") === target) return l;
    }
    return null;
}

// Как findLayerByNameLoose, но ещё и без учёта регистра — нужно там, где
// слой построен пользователем вручную и точный регистр не гарантирован
// (напр. "гороскоп 1" против ожидаемого "Гороскоп 1").
function findLayerByNameCI(comp, name) {
    var target = name.replace(/^\s+|\s+$/g, "").toLowerCase();
    for (var i = 1; i <= comp.numLayers; i++) {
        var l = comp.layer(i);
        if (l.name.replace(/^\s+|\s+$/g, "").toLowerCase() === target) return l;
    }
    return null;
}

function applyCurrencyRates(ratesJson) {
    var rates = JSON.parse(ratesJson);
    app.beginUndoGroup("Включайся!: курс валют");
    var results = [];
    try {
        var comp = findCompByName("валюта");
        if (!comp) { app.endUndoGroup(); return "ERROR: comp not found: валюта"; }

        for (var i = 0; i < rates.length; i++) {
            var r = rates[i];
            var layer = findLayerByNameLoose(comp, "rate_" + r.code);
            if (!layer) { results.push(r.code + ": слой 'rate_" + r.code + "' не найден"); continue; }
            var doc = layer.property("Source Text").value;
            doc.text = r.rate; // и всё — ни position, ни anchor, ни font не трогаем
            layer.property("Source Text").setValue(doc);
            results.push(r.code + " -> " + r.rate);
        }
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "OK: " + results.join(" | ");
}

// ============================================================
// ДАТА / ДЕНЬ НЕДЕЛИ — существующие композиции "неделя" и
// "день месяц" (уже стояли в проекте, ни разу не были подключены
// к автоматике). По одному текстовому слою в каждой, без ключей —
// правится сразу и целиком при каждом нажатии кнопки.
// ============================================================
// dateJson: {weekday:"Пт", day:21, month:"авг"}
// Меняет ТОЛЬКО текст, anchor/position/scale не трогает вообще. У "неделя"/
// "день месяц" текст стоит на месте не через геометрическую центровку —
// там гигантский fontSize (~354pt) при scale=100%, и виден только фрагмент
// буквы за счёт особой руками подобранной anchor/position. Пересчёт anchor
// "по центру bbox нового текста" (как в setLayerTextCentered) эту хрупкую
// настройку полностью разваливает — текст расползается за пределы плашки.
function setLayerTextOnly(layer, text) {
    if (!layer) return false;
    try {
        var textProp = layer.property("Source Text");
        var doc = textProp.value;
        doc.text = text;
        textProp.setValue(doc);
        return true;
    } catch (e) {
        return false;
    }
}

function applyDateInfo(dateJson) {
    var d = JSON.parse(dateJson);
    app.beginUndoGroup("Включайся!: дата/неделя");
    var results = [];
    try {
        var weekComp = findCompByName("неделя");
        var dateComp = findCompByName("день месяц");

        if (weekComp) {
            var wLayer = findFirstTextLayerIn(weekComp);
            results.push(wLayer && setLayerTextOnly(wLayer, d.weekday) ? "неделя -> OK" : "неделя: текстовый слой не найден");
        } else {
            results.push("неделя: композиция не найдена");
        }

        if (dateComp) {
            var dLayer = findFirstTextLayerIn(dateComp);
            var text = d.day + "\r" + d.month;
            results.push(dLayer && setLayerTextOnly(dLayer, text) ? "день месяц -> OK" : "день месяц: текстовый слой не найден");
        } else {
            results.push("день месяц: композиция не найдена");
        }
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return results.join(" | ");
}

// Простая проверка связи — панель дёргает её при запуске,
// чтобы понять, что host.jsx вообще загрузился.
function ping() {
    return "Включайся! host.jsx загружен, проект: " +
        (app.project.file ? app.project.file.name : "(не сохранён)");
}

// ============================================================
// ЦИКЛ ПОГОДЫ ПО 6 ГОРОДАМ — УПРОЩЁННАЯ версия (см. план от 2026-08-21:
// "забудем про вытеснение/шторку, просто друг за другом"). Один слой
// на комп "город"/"погода", жёсткая смена по Hold-keyframe Source Text.
// Иконка в "анимашке" — Hold Opacity 0/100, без движения.
// ============================================================

// Фикс 4 сек на город — города просто крутятся по кругу (Минск..Могилёв..
// Минск..) на всю длину композиции. Не обязано делиться на 6 — важно
// только чтобы длина композиции делилась на WEATHER_SLOT_DURATION без
// остатка (иначе последний слот обрежется не на границе, и петля будет
// не бесшовной).
var WEATHER_SLOT_DURATION = 3.5; // 175 кадров @ 50fps — сек показа одного города

// Функция, не var — см. getPreviewOutDir() выше про кэширование
// host.jsx движком AE. (Сейчас ICON_FOLDER используется только в
// ensureIconLayers ниже, которая сама нигде не вызывается — см. её
// комментарий — но путь всё равно портативный, на всякий случай.)
function getIconFolder() { return getProjectRootFolder() + "/icons/"; }
var ICON_KEYS = ["icon_clear", "icon_cloudy", "icon_overcast", "icon_rain",
    "icon_storm", "icon_snow", "icon_fog", "icon_wind"];
var ICON_TARGET_LOCAL_WIDTH = 500; // px внутри 1920x1080-пространства "анимашка"

// ============================================================
// ИКОНКИ ПОГОДЫ v2 (2026-08-25) — раньше статичные PNG (ICON_KEYS/
// ICON_FOLDER выше, только для старой ensureIconLayers, сейчас нигде не
// вызывается), теперь — зацикленные АНИМАЦИИ из папки проекта
// Animation/Weather Icons CC2014.aep/03 Weather Icons - PLAIN (18 comps).
// Соответствие семантический ключ (отдаёт main.js по тексту явления) ->
// имя compа, согласовано с пользователем 2026-08-25 — там, где отдельной
// иконки под конкретное явление нет, несколько ключей делят один comp
// (напр. "cloudy" покрывает и туман, и гололедицу, и "без осадков").
// ============================================================
var WEATHER_ICON_COMP_NAMES = {
    "sunny": "01 Sunny - PLAIN",
    "partly_cloudy": "02 Partly Cloudy - PLAIN",
    "partly_sunny": "03 Partly Sunny - PLAIN",
    "cloudy": "04 Cloudy - PLAIN",
    "drizzle": "05 Drizzle - PLAIN",
    "rain": "06 Rain - PLAIN",
    "snowy": "07 Snowy - PLAIN",
    "rain_sunny": "09 Rain Sunny - PLAIN",
    "storm": "17 Storm - PLAIN",
    "windy": "18 Windy - Plain" // именно так, с маленькой "p" — реальное имя compа в проекте
};

function getWeatherIconComp(key) {
    var compName = WEATHER_ICON_COMP_NAMES[key];
    if (!compName) return null;
    return findCompByName(compName);
}

// Анимации короткие (обычно ~1.8с), а слот города держится ~7.5с —
// вместо дублирования слоёв (плодит количество и ломает push-переходы)
// включаем Time Remapping + loopOut("cycle") прямо на слое: содержимое
// зацикливается нативно средствами AE, слой один, просто длиннее.
// timeRemapEnabled=true сама ставит 2 keyframe'а (0->0, длительность->
// длительность, т.е. обычное 1x-проигрывание) — ровно этот отрезок
// loopOut повторяет по кругу.
function enableLoopingTimeRemap(layer) {
    if (!layer.timeRemapEnabled) layer.timeRemapEnabled = true;
    var trProp = layer.property("Time Remap");
    trProp.expression = 'loopOut("cycle")';
}

function setLayerTextAtTime(layer, text, t) {
    var prop = layer.property("Source Text");
    var doc = prop.value;
    doc.text = text;
    prop.setValueAtTime(t, doc);
}

function setOpacityHold(layer, value, t) {
    var op = layer.property("Opacity");
    op.setValueAtTime(t, value);
    for (var k = 1; k <= op.numKeys; k++) {
        op.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
    }
}

// Полностью снимает все keyframe'ы со свойства — нужно, чтобы чисто
// пересобирать после предыдущей (более сложной) версии с движением,
// иначе старые Position/Opacity keyframes останутся висеть.
function clearKeyframes(prop) {
    while (prop.numKeys > 0) prop.removeKey(1);
}

// Удаляет дубль-слой " B", оставшийся от прошлой версии с вытеснением —
// в упрощённой схеме он не нужен, один слой на комп.
function removeDuplicateIfAny(comp) {
    for (var i = comp.numLayers; i >= 1; i--) {
        var l = comp.layer(i);
        if (l instanceof TextLayer && l.name.indexOf(" B") === l.name.length - 2) {
            l.remove();
        }
    }
}

function findSoleTextLayer(comp) {
    for (var i = 1; i <= comp.numLayers; i++) {
        var l = comp.layer(i);
        if (l instanceof TextLayer) return l;
    }
    return null;
}

// Импортирует 8 png-иконок (idempotent — не задваивает при повторном
// запуске) и раскладывает их слоями в "анимашка", все center на (w/2,h/2),
// все opacity=0 кроме первой. Возвращает объект { iconKey: layer }.
function ensureIconLayers(comp) {
    var result = {};
    var cx = comp.width / 2, cy = comp.height / 2;

    // выключаем старый слой-глиф (текстовый код шрифта), если он есть
    for (var li = 1; li <= comp.numLayers; li++) {
        var l = comp.layer(li);
        if (l instanceof TextLayer) l.enabled = false;
    }

    for (var i = 0; i < ICON_KEYS.length; i++) {
        var key = ICON_KEYS[i];
        var existing = findLayerByName(comp, key);
        if (existing) { result[key] = existing; continue; }

        // ищем уже импортированную footage по имени файла, иначе импортируем
        var fileName = key + ".png";
        var footageItem = null;
        for (var pi = 1; pi <= app.project.numItems; pi++) {
            var item = app.project.item(pi);
            if (item instanceof FootageItem && item.name === fileName) { footageItem = item; break; }
        }
        if (!footageItem) {
            var f = new File(getIconFolder() + fileName);
            if (!f.exists) { continue; } // тихо пропускаем отсутствующий файл
            footageItem = app.project.importFile(new ImportOptions(f));
        }

        var layer = comp.layers.add(footageItem);
        layer.name = key;
        var natW = footageItem.width || 500;
        var natH = footageItem.height || 500;
        var s = (ICON_TARGET_LOCAL_WIDTH / natW) * 100;
        layer.property("Transform").property("Scale").setValue([s, s, 100]);
        layer.property("Transform").property("Anchor Point").setValue([natW / 2, natH / 2]);
        layer.property("Transform").property("Position").setValue([cx, cy]);
        layer.property("Opacity").setValue(0);
        result[key] = layer;
    }
    return result;
}

// weatherJson — строка вида (см. fetchAllWeather() в main.js):
// [{"city":"Минск","temp":"+20°","icon":"icon_clear"}, ...] — ровно 6, по порядку.
// ============================================================
// ПОГОДА v3 — реальные слои по городам (пользователь сам собрал их в
// "город": 6 именованных слоёв "Минск".."Могилёв" с реальным
// inPoint/outPoint подряд без зазоров), а не один слой с Hold-
// перебором текста. "погода" пока 6 ОДИНАКОВЫХ слоёв без разбивки —
// эта функция раздаёт им текст и тайминг по образцу "город", и
// зацикливает оба на всю длину композиции (город/погода повторяются
// несколько раз за totalDuration).
// ============================================================

// Порядок ДОЛЖЕН совпадать с CITIES в main.js (fetchAllWeather отдаёт
// data в этом же порядке) — сверено живьём с inPoint слоёв "город".
var WEATHER_CITY_NAMES = ["Минск", "Брест", "Витебск", "Гомель", "Гродно", "Могилёв"];
// ============================================================
// ТАЙМИНГ ПОГОДЫ ПОД ПЕТЛЮ КЛИПА (переписано 2026-08-31)
// ------------------------------------------------------------
// Клип в MASTER зациклен: рабочая область [LOOP_START .. LOOP_END], на
// конце склейка (хвост "новость 1" -> её же начало), и OUT возвращается
// на LOOP_START. Раньше погода тайлилась от t=0 по фиксированному
// citySlot = 197/49 — на стыке петли (LOOP_END -> LOOP_START) фаза
// цикла городов НЕ совпадала, город дёргался.
//
// Теперь: 6 городов * K оборотов ТОЧНО закрывают петлю
// L = LOOP_END - LOOP_START. Первый город стартует ровно на LOOP_START,
// последний заканчивается ровно на LOOP_END => на стыке фаза совпадает.
// citySlot = L / (6*K) — точная дробь, НЕ округляем (иначе на дальних
// оборотах набегает дрейф). K — максимальное при условии, что ЧИСТОЕ
// время города (citySlot минус переход) >= 5с:
//   citySlot - WEATHER_PUSH_DURATION >= 5.
//
// LOOP_START берём живьём из inPoint слоя "новости текст" в ОСНОВА
// (пользователь обрезал его руками под нужную точку склейки),
// LOOP_END = ОСНОВА.duration. Fallback-константы — если проект закрыт.
// ============================================================
var WEATHER_LOOP_START_FALLBACK = 31.12; // 31:06 @ 50fps
var WEATHER_LOOP_END_FALLBACK = 197;

// Хвост Минска (город 1) для склейки петли — зеркало новостей (там
// "новость 1" = хвост в начале + голова "новости текст первая новость"
// в конце). Минск в НАЧАЛЕ петли висит (citySlot - WEATHER_HEAD_DUR),
// отдельной "головой" в самом конце — WEATHER_HEAD_DUR, и на стыке
// LOOP_END -> LOOP_START Минск просто продолжается (без перехода).
// Должно быть > WEATHER_PUSH_DURATION (в голову влезает въезд + выдержка).
var WEATHER_HEAD_DUR = 1.5;

// osnova — явная ОСНОВА (для сборки погоды под обе версии: обычную и «без др»).
// Без аргумента — активная (getOsnova), как раньше.
function getWeatherLoopBounds(osnova) {
    var start = WEATHER_LOOP_START_FALLBACK;
    var end = WEATHER_LOOP_END_FALLBACK;
    osnova = osnova || getOsnova();
    if (osnova) {
        end = osnova.duration;
        var newsLayer = findLayerByName(osnova, "новости текст");
        if (newsLayer) start = newsLayer.inPoint;
    }
    var n = WEATHER_CITY_NAMES.length;
    var L = end - start;
    var minSlot = 5 + WEATHER_PUSH_DURATION; // >=5с чистых + переход
    var k = Math.floor(L / (n * minSlot));
    if (k < 1) k = 1;
    var citySlot = L / (n * k);
    return {
        start: start, end: end, L: L,
        cycles: k, citySlot: citySlot, cycleLength: citySlot * n
    };
}

// Границы ОДНОГО оборота (6 городов) в АБСОЛЮТНОМ времени ОСНОВА, СМЕЩЁННЫЕ
// на -WEATHER_HEAD_DUR: arr[i] = START - Δ + i*citySlot.
// arr[0] = "естественный" старт Минска (START - Δ) — левее реального начала
// петли; в buildWeatherCycleTimeline видимый хвост Минска клампится к START,
// а "отрезанные" Δ секунд Минска показываются отдельной головой в конце
// ([END - Δ, END]). Так на стыке петли END->START Минск непрерывен.
function weatherCityBounds(b) {
    b = b || getWeatherLoopBounds();
    var arr = [];
    for (var i = 0; i <= WEATHER_CITY_NAMES.length; i++) {
        arr.push(b.start - WEATHER_HEAD_DUR + i * b.citySlot);
    }
    return arr;
}

// ============================================================
// ТАРГЕТЫ ПОГОДЫ (2026-08-31) — «Обновить погоду»/«Применить переходы»
// собирают погоду под КАЖДУЮ версию ОСНОВА: обычную (комп-ы «город»/
// «погода»/«анимашка», петля 197) и «ОСНОВА без др» (свои копии
// «... без др», петля 187.62). Одна раскладка не бывает бесшовной для
// обеих петель — поэтому раздельные комп-ы.
// ============================================================
function ensureBezDrWeatherComp(bezOsnova, wrapName, sharedComp) {
    if (!sharedComp) return null;
    var layer = findLayerByName(bezOsnova, wrapName);
    if (!layer) return null;
    var want = findCompByName(wrapName + " без др");
    if (!want) { want = sharedComp.duplicate(); want.name = wrapName + " без др"; }
    if (layer.source !== want) {
        layer.replaceSource(want, false);
        layer.name = wrapName; // replaceSource переименовывает слой — вернём, чтобы scaleOf находил обёртку
    }
    return want;
}

function weatherTargets() {
    var sharedCity = findCompByName("город");
    var sharedTemp = findCompByName("погода");
    var sharedIcon = findCompByName("анимашка");
    var targets = [{
        osnova: findCompByName("ОСНОВА"),
        cityComp: sharedCity, tempComp: sharedTemp, iconComp: sharedIcon
    }];
    var bez = findCompByName("ОСНОВА без др");
    if (bez && sharedCity && sharedTemp && sharedIcon) {
        targets.push({
            osnova: bez,
            cityComp: ensureBezDrWeatherComp(bez, "город", sharedCity),
            tempComp: ensureBezDrWeatherComp(bez, "погода", sharedTemp),
            iconComp: ensureBezDrWeatherComp(bez, "анимашка", sharedIcon)
        });
    }
    return targets;
}

// Масштаб/позиция ВНЕШНИХ слоёв-обёрток "погода" и "анимашка" в ОСНОВА —
// пользователь подобрал их вручную (2026-08-25), НИ ОДНА функция в этом
// файле их не трогает (обращение идёт только к внутренним дочерним слоям
// через findCompByName("погода"/"анимашка")) — фиксируем цифры здесь
// просто для памяти, менять в коде нечего:
//   "погода":   position=[886, 963.5], anchor=[960,540], scale=[16, 16, 100]
//   "анимашка": position=[1006.51, 961], anchor=[960,540], scale=[9.5, 9.5, 100]

// Безопасный порядок присвоения inPoint/outPoint — если новый inPoint
// окажется правее текущего outPoint (типично при переносе слоя далеко
// вперёд под повтор цикла), AE не даст поставить invalid range.
// Подстраховываемся временным большим outPoint.
function setLayerTiming(layer, inPt, outPt) {
    if (inPt > layer.outPoint) layer.outPoint = inPt + 1;
    layer.inPoint = inPt;
    layer.outPoint = outPt;
}

// Вариант setLayerTiming, безопасный в ОБЕ стороны — новый inPt может
// оказаться и правее, и ЛЕВЕЕ текущего outPoint (при реструктуризации
// границы блоков двигаются в обе стороны, не только вперёд). Сначала
// раздвигаем outPoint заведомо далеко (дальше и текущего, и нового
// диапазона), затем ставим inPt, затем финальный outPt — так AE никогда
// не увидит невалидный (inPoint > outPoint) диапазон на промежуточном шаге.
function setLayerTimingSafe(layer, inPt, outPt) {
    var safelyFar = Math.max(layer.inPoint, layer.outPoint, inPt, outPt) + 100;
    layer.outPoint = safelyFar;
    layer.inPoint = inPt;
    layer.outPoint = outPt;
}

// Находит слой по имени или сразу бросает понятную ошибку — короче, чем
// каждый раз писать if(!layer) return "ERROR: ...".
function findOrThrow(comp, name) {
    var l = findLayerByName(comp, name);
    if (!l) throw new Error("слой не найден: '" + name + "' (в '" + comp.name + "')");
    return l;
}

// Удаляет все слои comp, чьё имя целиком совпадает с regex — используется
// для чистки старых "_rK"-повторов погоды перед пересчётом под новый
// хронометраж (см. restructureToNewSequence).
function removeLayersMatchingRegex(comp, regex) {
    for (var i = comp.numLayers; i >= 1; i--) {
        var l = comp.layer(i);
        if (regex.test(l.name)) l.remove();
    }
}

// Стабилизирует N (=WEATHER_CITY_NAMES.length) слотов-слоёв в comp под
// схему prefix+" "+(i+1) — та же идиома, что раньше была только инлайном
// внутри buildWeatherCycleTimeline для "погода", вынесена сюда, чтобы
// использовать и для "анимашка". Если подходящих текстовых слоёв меньше
// N — ДОДУБЛИРУЕТ последний найденный автоматически (по просьбе
// пользователя — раньше не хватало слоёв и функция просто падала с
// ошибкой, дублировать приходилось вручную в AE).
function ensureSixSlotLayers(comp, prefix) {
    var n = WEATHER_CITY_NAMES.length;
    var all = [];
    for (var j = 1; j <= comp.numLayers; j++) {
        var lyr = comp.layer(j);
        if (lyr instanceof TextLayer) all.push(lyr);
    }
    var usedFlags = [];
    for (var uf = 0; uf < all.length; uf++) usedFlags.push(false);

    var slots = [];
    for (var i = 0; i < n; i++) {
        var stableName = prefix + " " + (i + 1);
        var found = findLayerByName(comp, stableName);
        if (found) {
            for (var m = 0; m < all.length; m++) {
                if (all[m] === found) { usedFlags[m] = true; break; }
            }
        } else {
            for (var k = 0; k < all.length; k++) {
                if (!usedFlags[k]) { found = all[k]; usedFlags[k] = true; break; }
            }
        }
        if (!found) {
            var template = slots.length ? slots[slots.length - 1] : null;
            if (!template) return null;
            found = template.duplicate();
        }
        found.name = stableName;
        slots.push(found);
    }
    return slots;
}

// Как ensureSixSlotLayers, но НЕ ограничивается TextLayer — нужно для
// "анимашка": болванки там теперь сами могут быть comp-слоями (напр.
// пользователь вручную поставил 6 одинаковых дублей "01 Sunny - PLAIN"
// как визуальный ориентир по позиции), а не текстовыми плейсхолдерами.
// Исключает только явно служебные фоновые слои по имени ("Red Solid N").
// Раздельная функция, а не флаг в ensureSixSlotLayers — чтобы не менять
// поведение для "погода", где текстовые болванки всё ещё используются
// как есть и трогать это незачем.
function ensureIconSlotLayers(comp, prefix) {
    var n = WEATHER_CITY_NAMES.length;
    var all = [];
    for (var j = 1; j <= comp.numLayers; j++) {
        var lyr = comp.layer(j);
        if (lyr.name.indexOf("Red Solid") === 0) continue;
        all.push(lyr);
    }
    var usedFlags = [];
    for (var uf = 0; uf < all.length; uf++) usedFlags.push(false);

    var slots = [];
    for (var i = 0; i < n; i++) {
        var stableName = prefix + " " + (i + 1);
        var found = null;
        for (var m = 0; m < all.length; m++) {
            if (!usedFlags[m] && all[m].name === stableName) { found = all[m]; usedFlags[m] = true; break; }
        }
        if (!found) {
            for (var k = 0; k < all.length; k++) {
                if (!usedFlags[k]) { found = all[k]; usedFlags[k] = true; break; }
            }
        }
        if (!found) {
            var template = slots.length ? slots[slots.length - 1] : null;
            if (!template) return null;
            found = template.duplicate();
        }
        found.name = stableName;
        slots.push(found);
    }
    return slots;
}

// Прямоугольник экрана (в координатах ОСНОВА), который реально занимает
// precomp-слой elName (город/погода/анимашка) — по его Position/Anchor/
// Scale, а не на глаз. Общая функция — нужна и при построении плашек
// (buildWeatherCycleTimeline), и при их анимации (applyWeatherTransitions).
function computeSlotRect(osnova, elName) {
    var ref = findLayerByName(osnova, elName);
    if (!ref) return null;
    var refPos = ref.property("Position").value;
    var refAnchor = ref.property("Anchor Point").value;
    var refScale = ref.property("Scale").value;
    var sx = refScale[0] / 100, sy = refScale[1] / 100;
    var compW = ref.source ? ref.source.width : 1920;
    var compH = ref.source ? ref.source.height : 1080;
    return {
        w: compW * sx, h: compH * sy,
        left: refPos[0] - refAnchor[0] * sx,
        top: refPos[1] - refAnchor[1] * sy
    };
}

// Публичная: собирает погоду под КАЖДУЮ версию ОСНОВА (обычную + «без др»),
// каждая в свой набор комп-ов, под свою петлю. Один undoGroup на всё.
function buildWeatherCycleTimeline(weatherJson) {
    var data = JSON.parse(weatherJson);
    if (!data || data.length < WEATHER_CITY_NAMES.length) {
        return "ERROR: нужно " + WEATHER_CITY_NAMES.length + " городов в данных, получено " + (data ? data.length : 0);
    }
    var targets = weatherTargets();
    app.beginUndoGroup("Включайся!: погода (данные, зациклено)");
    var out = [];
    try {
        for (var ti = 0; ti < targets.length; ti++) {
            var t = targets[ti];
            if (!t.osnova || !t.cityComp || !t.tempComp || !t.iconComp) { out.push("таргет " + ti + ": комп не найден"); continue; }
            out.push(t.osnova.name + " -> " + buildWeatherForTarget(t, data));
        }
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "OK || " + out.join(" || ");
}

// t = { osnova, cityComp, tempComp, iconComp }. НЕ управляет undoGroup.
function buildWeatherForTarget(t, data) {
    var cityComp = t.cityComp, tempComp = t.tempComp, iconComp = t.iconComp;

    var steps = 0;
    function tick(n) {
        steps += n;
        if (steps > WEATHER_STEP_LIMIT) {
            throw new Error("Превышен лимит операций (" + WEATHER_STEP_LIMIT + ") — прервано намеренно, для защиты от зависания.");
        }
    }

    {
        // Тайминг под петлю клипа (см. getWeatherLoopBounds): цикл 6 городов
        // повторяется b.cycles раз и точно закрывает [b.start .. b.end].
        var b = getWeatherLoopBounds(t.osnova);
        var bounds = weatherCityBounds(b);       // [start, start+cs, ... start+6cs]
        var totalDuration = b.end;
        var cycleLength = b.cycleLength;
        var repeats = b.cycles;

        // --- 1) Резолвим 6 реальных слоёв города (повтор 0). Раньше только
        // читали (были расставлены пользователем руками) — теперь ЯВНО
        // ретаймим на WEATHER_CITY_BOUNDS при каждом запуске: иначе при
        // смене общего хронометража (напр. после сокращения блока "др",
        // 2026-08-25) город остаётся на старых границах, а погода/анимашка
        // переходят на новые — рассинхрон между именем города и данными.
        // setLayerTimingSafe (не хрупкий setLayerTiming) — новые границы
        // могут быть и левее, и правее текущих.
        // МИГРАЦИЯ (2026-08-25): раньше слой искался ПО СОДЕРЖИМОМУ имени
        // (WEATHER_CITY_NAMES[i], т.е. буквально "Минск"/"Брест"/...) и
        // текст НИКОГДА не перезаписывался — правка города в панели
        // физически ни на что не влияла. Переводим на позиционное имя
        // "город "+(i+1) (тот же принцип, что уже у "погода "/"анимашка "),
        // и теперь ПИШЕМ data[i].city в Source Text — правка в панели
        // реально применяется. Ищем СНАЧАЛА по новому позиционному имени,
        // если не нашли — по старому (первый прогон после этой правки),
        // и сразу переименовываем слой на новое (идемпотентно). ---
        var cityLayers0 = [];
        for (var i = 0; i < WEATHER_CITY_NAMES.length; i++) {
            var stableCityName = "город " + (i + 1);
            var cl = findLayerByName(cityComp, stableCityName) || findLayerByNameLoose(cityComp, WEATHER_CITY_NAMES[i]);
            if (!cl) return "ERROR: layer not found in город: " + WEATHER_CITY_NAMES[i] + " / " + stableCityName;
            cl.name = stableCityName;
            // Минск (i=0) клампится к старту петли — его "отрезанный" хвост
            // Δ секунд уходит в голову цикла (см. ниже). Остальные — по bounds.
            setLayerTimingSafe(cl, (i === 0 ? b.start : bounds[i]), bounds[i + 1]);
            var cityTextProp = cl.property("Source Text");
            var cityDoc = cityTextProp.value;
            cityDoc.text = data[i].city;
            cityTextProp.setValue(cityDoc);
            cityLayers0.push(cl);
        }

        // --- 2) Погода: 6 слотов -> стабильные имена "погода 1".."погода 6",
        // раздаём текст/тайминг по образцу города. ensureSixSlotLayers сама
        // додублирует недостающие слоты, если их меньше 6. Размер шрифта —
        // ВСЕГДА как у эталона "погода 1" (2026-08-25: слоты разъехались по
        // fontSize независимо друг от друга — синхронизируем при каждом
        // прогоне, тот же принцип, что уже у Scale/Anchor/Position иконок). ---
        var tempLayers0 = ensureSixSlotLayers(tempComp, "погода");
        if (!tempLayers0) return "ERROR: не хватает текстовых слоёв в погода (нужно " + WEATHER_CITY_NAMES.length + ")";
        var tempRefFontSize = tempLayers0[0].property("Source Text").value.fontSize;

        for (var i3 = 0; i3 < WEATHER_CITY_NAMES.length; i3++) {
            tick(2);
            setLayerTiming(tempLayers0[i3], (i3 === 0 ? b.start : bounds[i3]), bounds[i3 + 1]);
            var textProp = tempLayers0[i3].property("Source Text");
            var doc = textProp.value;
            doc.text = data[i3].temp;
            doc.fontSize = tempRefFontSize;
            textProp.setValue(doc);
        }

        // --- 2b) Анимашка: те же 6 слотов, что и "погода", но слот —
        // изначально ТЕКСТОВЫЙ дубль-болванка (не футадж), а нужна
        // зацикленная анимация-иконка (см. WEATHER_ICON_COMP_NAMES выше).
        // Стабилизируем 6 болванок как обычно (используются только как
        // источник для дублирования и позже выключаются), а реальный
        // контент — отдельный comp-слой на каждый слот, стабильно назван
        // "анимашка " + (i+1) — по этому имени дальше строятся repeats и
        // applyWeatherTransitions, ровно как для "погода". ---
        var iconSlotDummies = ensureIconSlotLayers(iconComp, "анимашка_болванка");
        if (!iconSlotDummies) return "ERROR: не хватает слоёв в анимашка для болванок (нужно " + WEATHER_CITY_NAMES.length + ")";

        // Эталонные позиция/якорь/масштаб — берём с болванки-примера
        // пользователя (он сам вручную подобрал нужный визуальный размер,
        // напр. Scale 205%), а НЕ пересчитываем из ICON_TARGET_LOCAL_WIDTH —
        // так все иконки садятся ровно там и того же размера, что уже
        // подобрано руками, а не перезаписываются формулой поверх.
        var refTransform = iconSlotDummies[0].property("Transform");
        var refScale = refTransform.property("Scale").value;
        var refAnchor = refTransform.property("Anchor Point").value;
        var refPosition = refTransform.property("Position").value;

        var iconLayers0 = [];
        for (var i2b = 0; i2b < WEATHER_CITY_NAMES.length; i2b++) {
            tick(3);
            var stableIconName = "анимашка " + (i2b + 1);
            var iconLayer = findLayerByName(iconComp, stableIconName);
            var iconCompItem = getWeatherIconComp(data[i2b].icon);
            if (!iconCompItem) return "ERROR: нет анимации для состояния '" + data[i2b].icon + "' (см. WEATHER_ICON_COMP_NAMES)";
            if (!iconLayer) {
                iconLayer = iconComp.layers.add(iconCompItem);
                iconLayer.name = stableIconName;
                // Position/Scale/Anchor ставим ТОЛЬКО для нового слоя —
                // если "Анимация погоды" уже была применена раньше, на
                // существующем слое на Position уже могут висеть
                // keyframes, и setValue() на keyframed-свойстве кидает
                // ошибку AE ("Can not call setValue() on a property with
                // keyframes"). Раз слой уже существует — его поз/масштаб
                // уже настроены (этим же кодом при первом создании или
                // руками), трогать не нужно.
                iconLayer.property("Transform").property("Position").setValue(refPosition);
                iconLayer.property("Transform").property("Scale").setValue(refScale);
                iconLayer.property("Transform").property("Anchor Point").setValue(refAnchor);
            } else if (iconLayer.source !== iconCompItem) {
                iconLayer.replaceSource(iconCompItem, false);
            }
            enableLoopingTimeRemap(iconLayer);
            setLayerTiming(iconLayer, (i2b === 0 ? b.start : bounds[i2b]), bounds[i2b + 1]);
            iconSlotDummies[i2b].enabled = false;
            iconLayers0.push(iconLayer);
        }

        // --- 3) Зацикливаем: город, погода и анимашка дублируются на все
        // repeats-1 дополнительных повторов, идемпотентно по имени "_rK".
        // (Плашки "подложка" НЕ трогаем вообще — по прямому указанию
        // пользователя после серии неудачных попыток их анимировать/
        // дублировать/маскировать: это давало либо раздувание количества
        // слоёв, либо визуальный "распух", либо рассинхрон. Плашка
        // остаётся статичным фоном как была изначально.) ---
        for (var k2 = 1; k2 < repeats; k2++) {
            var offset = k2 * cycleLength;
            for (var i4 = 0; i4 < WEATHER_CITY_NAMES.length; i4++) {
                tick(4);
                var inPt = bounds[i4] + offset;
                // Последний Могилёв последнего оборота обрывается на b.end - Δ:
                // оставшиеся Δ секунд занимает голова цикла (Минск).
                var outPt = Math.min(bounds[i4 + 1] + offset, b.end - WEATHER_HEAD_DUR);

                // Ищем СНАЧАЛА по новому позиционному имени, потом по
                // старому (миграция, см. комментарий выше в шаге 1).
                var cityName_r = "город " + (i4 + 1) + "_r" + k2;
                var cityOldName_r = WEATHER_CITY_NAMES[i4] + "_r" + k2;
                var cityLayerR = findLayerByName(cityComp, cityName_r) || findLayerByName(cityComp, cityOldName_r);
                if (!cityLayerR) { cityLayerR = cityLayers0[i4].duplicate(); }
                cityLayerR.name = cityName_r;
                if (outPt > inPt) {
                    cityLayerR.enabled = true;
                    setLayerTiming(cityLayerR, inPt, outPt);
                    // Повторы раньше никогда не обновляли текст после
                    // создания (только тайминг) — при смене погоды на
                    // следующий день показывали вчерашний город/дубль
                    // навсегда. Обновляем при каждом прогоне.
                    var cityRTextProp = cityLayerR.property("Source Text");
                    var cityRDoc = cityRTextProp.value;
                    cityRDoc.text = data[i4].city;
                    cityRTextProp.setValue(cityRDoc);
                } else { cityLayerR.enabled = false; }

                var tempName_r = "погода " + (i4 + 1) + "_r" + k2;
                var tempLayerR = findLayerByName(tempComp, tempName_r);
                if (!tempLayerR) { tempLayerR = tempLayers0[i4].duplicate(); tempLayerR.name = tempName_r; }
                if (outPt > inPt) {
                    tempLayerR.enabled = true;
                    setLayerTiming(tempLayerR, inPt, outPt);
                    // Та же причина — раньше текст/fontSize повторов не
                    // обновлялись после создания.
                    var tempRTextProp = tempLayerR.property("Source Text");
                    var tempRDoc = tempRTextProp.value;
                    tempRDoc.text = data[i4].temp;
                    tempRDoc.fontSize = tempRefFontSize;
                    tempRTextProp.setValue(tempRDoc);
                } else { tempLayerR.enabled = false; }

                var iconName_r = "анимашка " + (i4 + 1) + "_r" + k2;
                var iconLayerR = findLayerByName(iconComp, iconName_r);
                if (!iconLayerR) { iconLayerR = iconLayers0[i4].duplicate(); iconLayerR.name = iconName_r; }
                if (outPt > inPt) {
                    iconLayerR.enabled = true;
                    setLayerTiming(iconLayerR, inPt, outPt);
                    // Та же причина — раньше иконка повтора не обновлялась
                    // после создания, если состояние погоды менялось.
                    var iconCompItemR = getWeatherIconComp(data[i4].icon);
                    if (iconCompItemR && iconLayerR.source !== iconCompItemR) {
                        iconLayerR.replaceSource(iconCompItemR, false);
                        enableLoopingTimeRemap(iconLayerR);
                    }
                } else { iconLayerR.enabled = false; }
            }
        }

        // --- 3b) ГОЛОВА цикла: Минск на [b.end - Δ, b.end] — зеркало
        // "новости текст первая новость" у новостей. На стыке петли
        // (b.end -> b.start) продолжается ХВОСТОМ Минска (слот "город 1",
        // который клампится к b.start и стоит в той же позиции) — без
        // перехода, бесшовно. Δ = WEATHER_HEAD_DUR. ---
        var headIn = b.end - WEATHER_HEAD_DUR;

        var cityHead = findLayerByName(cityComp, "город 1_head");
        if (!cityHead) { cityHead = cityLayers0[0].duplicate(); }
        cityHead.name = "город 1_head";
        cityHead.enabled = true;
        clearKeyframes(cityHead.property("Position")); // push-ключи ставит applyWeatherTransitions
        setLayerTimingSafe(cityHead, headIn, b.end);
        var chProp = cityHead.property("Source Text");
        var chDoc = chProp.value;
        chDoc.text = data[0].city;
        chProp.setValue(chDoc);

        var tempHead = findLayerByName(tempComp, "погода 1_head");
        if (!tempHead) { tempHead = tempLayers0[0].duplicate(); }
        tempHead.name = "погода 1_head";
        tempHead.enabled = true;
        clearKeyframes(tempHead.property("Position"));
        setLayerTimingSafe(tempHead, headIn, b.end);
        var thProp = tempHead.property("Source Text");
        var thDoc = thProp.value;
        thDoc.text = data[0].temp;
        thDoc.fontSize = tempRefFontSize;
        thProp.setValue(thDoc);

        var iconHead = findLayerByName(iconComp, "анимашка 1_head");
        if (!iconHead) { iconHead = iconLayers0[0].duplicate(); }
        iconHead.name = "анимашка 1_head";
        iconHead.enabled = true;
        clearKeyframes(iconHead.property("Position"));
        setLayerTimingSafe(iconHead, headIn, b.end);
        var iconHeadItem = getWeatherIconComp(data[0].icon);
        if (iconHeadItem && iconHead.source !== iconHeadItem) {
            iconHead.replaceSource(iconHeadItem, false);
        }
        enableLoopingTimeRemap(iconHead);

        // --- 4) Чистим хвост старых "_rK" от ПРЕДЫДУЩЕГО запуска с другим
        // числом повторов (напр. переход 25 слотов/7.88с (5 повторов) -> 49
        // слотов/4.02с (1 повтор), 2026-08-25) — иначе они остаются enabled
        // на старых временных отрезках и накладываются на новую раскладку. ---
        var MAX_REPEATS_EVER = 20; // тот же потолок, что и в Math.min(...,20) выше
        for (var kc = repeats; kc <= MAX_REPEATS_EVER; kc++) {
            for (var ic = 0; ic < WEATHER_CITY_NAMES.length; ic++) {
                var staleCity = findLayerByName(cityComp, "город " + (ic + 1) + "_r" + kc) || findLayerByName(cityComp, WEATHER_CITY_NAMES[ic] + "_r" + kc);
                if (staleCity) staleCity.enabled = false;
                var staleTemp = findLayerByName(tempComp, "погода " + (ic + 1) + "_r" + kc);
                if (staleTemp) staleTemp.enabled = false;
                var staleIcon = findLayerByName(iconComp, "анимашка " + (ic + 1) + "_r" + kc);
                if (staleIcon) staleIcon.enabled = false;
            }
        }
    }
    return "зациклено (" + repeats + "×" + cycleLength.toFixed(2) + "с, всего " + totalDuration.toFixed(1) + "с)";
}

// ============================================================
// АНИМАЦИЯ ПОГОДЫ (вытеснение/шторка) — ОТДЕЛЬНАЯ функция, отдельная
// кнопка. Работает ПОВЕРХ уже загруженных buildWeatherCycleTimeline
// данных: сама заново вызывает fetchAllWeather-результат (weatherJson),
// перестраивает те же 36 слотов, но с движением вместо мгновенной смены.
//
// ВАЖНО (см. инцидент с зависанием/53GB памяти при первой попытке):
// подозреваемая причина — Position это спатиальное свойство, и на каждый
// новый keyframe AE по умолчанию пересчитывает Auto Bezier сглаживание
// ПУТИ через ВСЕ уже существующие ключи разом; при ~35 повторных стыках
// подряд на одном и том же свойстве это могло уходить в резкий
// квадратичный рост стоимости. Здесь везде принудительно ставим линейную
// (не auto-bezier) спатиальную интерполяцию сразу после каждой пары
// ключей — так путь остаётся простым отрезком, без пересчёта сглаживания
// по всей истории. Плюс жёсткий потолок числа операций (STEP_LIMIT) —
// если он всё же будет превышен, функция сама прервётся с понятной
// ошибкой, а не подвиснет.
// ============================================================
var WEATHER_STEP_LIMIT = 4000;

function setLinearSpatial(prop, keyIndex) {
    try {
        prop.setSpatialAutoBezierAtKey(keyIndex, false);
        prop.setSpatialTangentsAtKey(keyIndex, [0, 0, 0], [0, 0, 0]);
    } catch (e) {}
}

// Работает ПОВЕРХ уже расставленных buildWeatherCycleTimeline слоёв
// (город/погода/анимашка) — сама ничего не создаёт, только читает
// существующие по именам/схеме зацикливания и добавляет keyframes.
// Механика — ТА ЖЕ, что уже проверена на новостях/др/валюте:
// addPushOutKeyframes/addPushInKeyframes (см. applyAllBlockTransitions).
// Плашку (подложка) НЕ трогаем вообще — несколько прошлых попыток её
// анимировать/дублировать/маскировать раздували либо число слоёв, либо
// визуальный размер, либо рассинхронили блок; по прямому указанию
// пользователя плашка остаётся статичным фоном, анимируются только
// сами 3 элемента.
// 0.7 (2026-08-31): было 0.4 — переход погоды ощущался заметно быстрее
// остальных. Теперь = PUSH_DURATION (новости/др/валюта/гороскоп).
var WEATHER_PUSH_DURATION = 0.7;

// Собирает цепочку слоёв одного элемента (город/погода/анимашка) по
// всем повторам, в хронологическом порядке.
function collectWeatherChain(comp, namePrefix, repeats, useLoose) {
    var chain = [];
    for (var k = 0; k < repeats; k++) {
        for (var i = 0; i < WEATHER_CITY_NAMES.length; i++) {
            var name = namePrefix(i, k);
            var l = useLoose ? findLayerByNameLoose(comp, name) : findLayerByName(comp, name);
            if (l && l.enabled) chain.push(l);
        }
    }
    return chain;
}

// Публичная: наплыв погоды под КАЖДУЮ версию ОСНОВА. Один undoGroup.
function applyWeatherTransitions(weatherJson) {
    var targets = weatherTargets();
    app.beginUndoGroup("Включайся!: анимация погоды (наплыв город+погода+анимашка)");
    var out = [];
    try {
        for (var ti = 0; ti < targets.length; ti++) {
            var t = targets[ti];
            if (!t.osnova || !t.cityComp || !t.tempComp || !t.iconComp) { out.push("таргет " + ti + ": комп не найден"); continue; }
            out.push(t.osnova.name + " -> " + applyWeatherTransForTarget(t));
        }
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "OK || " + out.join(" || ");
}

function applyWeatherTransForTarget(t) {
    var cityComp = t.cityComp, tempComp = t.tempComp, iconComp = t.iconComp, osnova = t.osnova;

    var steps = 0;
    function tick(n) {
        steps += n;
        if (steps > WEATHER_STEP_LIMIT) {
            throw new Error("Превышен лимит операций (" + WEATHER_STEP_LIMIT + ") — прервано намеренно, для защиты от зависания.");
        }
    }

    {
        // Те же границы петли, что и в buildWeatherForTarget.
        var b = getWeatherLoopBounds(t.osnova);
        var totalDuration = b.end;
        var cycleLength = b.cycleLength;
        var repeats = b.cycles;

        var cityLayers = collectWeatherChain(cityComp, function (i, k) {
            // Позиционное имя (см. миграцию в buildWeatherCycleTimeline,
            // 2026-08-25) — тот же паттерн, что уже у "погода "/"анимашка ".
            return k === 0 ? ("город " + (i + 1)) : ("город " + (i + 1) + "_r" + k);
        }, repeats, false);
        var tempLayers = collectWeatherChain(tempComp, function (i, k) {
            return k === 0 ? ("погода " + (i + 1)) : ("погода " + (i + 1) + "_r" + k);
        }, repeats, false);
        var iconLayers = collectWeatherChain(iconComp, function (i, k) {
            return k === 0 ? ("анимашка " + (i + 1)) : ("анимашка " + (i + 1) + "_r" + k);
        }, repeats, false);

        // Голова цикла (Минск на [b.end - Δ, b.end]) — ПОСЛЕДНЯЯ в цепочке.
        // Тогда цикл переходов ниже сам даёт: Минск-хвост (chain[0]) без
        // въезда; переход Могилёв -> Минск-голова; Минск-голова без выезда
        // -> на стыке петли оба Минска в home, бесшовно.
        var cityHeadL = findLayerByName(cityComp, "город 1_head");
        if (cityHeadL && cityHeadL.enabled) cityLayers.push(cityHeadL);
        var tempHeadL = findLayerByName(tempComp, "погода 1_head");
        if (tempHeadL && tempHeadL.enabled) tempLayers.push(tempHeadL);
        var iconHeadL = findLayerByName(iconComp, "анимашка 1_head");
        if (iconHeadL && iconHeadL.enabled) iconLayers.push(iconHeadL);

        if (cityLayers.length < 2 || tempLayers.length < 2 || iconLayers.length < 2) {
            return "ERROR: слоёв меньше 2 — сначала «Обновить погоду».";
        }

        // Единая дистанция хода НА ЭКРАНЕ (в пикселях ОСНОВА) для всех
        // трёх элементов — переводим в собственные координаты каждого
        // компа через его реальный live scale внутри ОСНОВА. Раньше
        // дистанция считалась по-разному для каждого (коэффициенты "на
        // глаз" от высоты своего компа) — после масштабирования это
        // давало РАЗНОЕ расстояние на экране и ощущалось как рассинхрон/
        // разная скорость. Теперь все три физически проезжают ОДИНАКОВЫЕ
        // ON_SCREEN_PUSH_DIST пикселей экрана за одно и то же время —
        // единая скорость, без отставания.
        // 89 (2026-08-31): = slotHeight блоков (новости/др/валюта) — раньше
        // 150, из-за большего пути за то же время погода ехала быстрее.
        // Теперь пиксель-в-пиксель та же скорость, что у всех переходов.
        var ON_SCREEN_PUSH_DIST = 89;
        function scaleOf(elName) {
            var ref = findLayerByName(osnova, elName);
            var s = ref ? ref.property("Scale").value[1] : 100;
            return s / 100;
        }

        var GROUPS = [
            { layers: cityLayers, dist: ON_SCREEN_PUSH_DIST / scaleOf("город") },
            { layers: tempLayers, dist: ON_SCREEN_PUSH_DIST / scaleOf("погода") },
            { layers: iconLayers, dist: ON_SCREEN_PUSH_DIST / scaleOf("анимашка") }
        ];

        for (var g = 0; g < GROUPS.length; g++) {
            var grp = GROUPS[g];
            var home = grp.layers[0].property("Position").value;

            for (var li = 0; li < grp.layers.length; li++) clearKeyframes(grp.layers[li].property("Position"));

            // Цепочка: [Минск-хвост, Брест, ... Могилёв_r(K-1), Минск-голова].
            // Переход между каждой парой на inPoint второго слоя. Минск-хвост
            // (idx 0) въезда НЕ получает — стоит с b.start (клип пришёл на
            // него по петле). Минск-голова (последняя) выезда НЕ получает —
            // на b.end переходит по петле в Минск-хвост (та же позиция).
            for (var idx = 1; idx < grp.layers.length; idx++) {
                tick(4);
                var startTime = grp.layers[idx].inPoint; // натуральная граница городов
                var newOut = startTime + WEATHER_PUSH_DURATION;

                var outLayer = grp.layers[idx - 1], inLayer = grp.layers[idx];
                if (outLayer.outPoint < newOut) outLayer.outPoint = newOut;

                addPushOutKeyframes(outLayer, home, grp.dist, startTime, WEATHER_PUSH_DURATION);
                addPushInKeyframes(inLayer, home, grp.dist, startTime, WEATHER_PUSH_DURATION);
            }
        }
    }
    return "наплыв ок (операций=" + steps + ")";
}

// ============================================================
// АНИМАЦИЯ ПЕРЕХОДОВ — "вытеснение": старый элемент уезжает вверх и
// пропадает, новый одновременно въезжает снизу на его место. Портировано
// из E:\включайся\Graph\подлоджка\build_template_v2.jsx (там же было
// найдено и проверено на глаз ещё в самой первой версии проекта).
// ============================================================

var PUSH_DURATION = 0.7; // сек — под 50fps это 35 кадров

// Лёгкий ease-in / заметное замедление к концу — та же кривая, что и в
// build_template_v2.jsx, ничего нового не подбираем.
function easeLastTwoKeys(prop) {
    var n = prop.numKeys;
    if (n < 2) return;
    var softIn = new KeyframeEase(0, 33);
    var strongOut = new KeyframeEase(0, 78);
    // Position — спатиальное свойство, AE хочет массив из ОДНОГО
    // KeyframeEase (на весь путь), а не по одному на измерение x/y.
    prop.setTemporalEaseAtKey(n - 1, [softIn], [softIn]);
    prop.setTemporalEaseAtKey(n, [strongOut], [strongOut]);
}

// outLayers/inLayers — МАССИВЫ слоёв (не один слой), чтобы текстовый слой
// и его цветная подложка-плашка ехали одной группой, синхронно, одним
// вызовом. Каждый элемент двигается от своей ТЕКУЩЕЙ (домашней) позиции:
// уходящие — на -slotHeight по Y и пропадают, приходящие — от
// +slotHeight по Y до своей домашней позиции. Выставляет Hold-подобные
// ключи по краям (сама позиция не "прыгает" за пределами окна анимации)
// + eased-кривую внутри. Сносит свои же старые Position-ключи перед
// постановкой новых — можно жать повторно при подгонке.
function pushTransitionGroup(outLayers, inLayers, slotHeight, startTime, duration) {
    for (var i = 0; i < outLayers.length; i++) {
        var outLayer = outLayers[i];
        var outPos = outLayer.property("Position");
        var home = outPos.value;
        clearKeyframes(outPos);
        outPos.setValueAtTime(startTime, [home[0], home[1]]);
        outPos.setValueAtTime(startTime + duration, [home[0], home[1] - slotHeight]);
        easeLastTwoKeys(outPos);
    }
    for (var j = 0; j < inLayers.length; j++) {
        var inLayer = inLayers[j];
        var inPos = inLayer.property("Position");
        var homeIn = inPos.value;
        clearKeyframes(inPos);
        inPos.setValueAtTime(startTime, [homeIn[0], homeIn[1] + slotHeight]);
        inPos.setValueAtTime(startTime + duration, [homeIn[0], homeIn[1]]);
        easeLastTwoKeys(inPos);
    }
}

// Вариант без clearKeyframes/без чтения .value как "домашней" позиции —
// нужен, когда один и тот же слой участвует в ДВУХ соседних переходах
// подряд (например "новости основа 5" — сначала въезжает в переходе
// шапка_новости->новости, потом уезжает в переходе новости->шапка_др).
// home передаётся явно (снят один раз ДО начала любых кейфреймов),
// clearKeyframes делается один раз заранее для всех участвующих слоёв —
// см. applyAllBlockTransitions.
function addPushOutKeyframes(layer, home, slotHeight, startTime, duration) {
    var pos = layer.property("Position");
    pos.setValueAtTime(startTime, [home[0], home[1]]);
    pos.setValueAtTime(startTime + duration, [home[0], home[1] - slotHeight]);
    easeLastTwoKeys(pos);
}
function addPushInKeyframes(layer, home, slotHeight, startTime, duration) {
    var pos = layer.property("Position");
    pos.setValueAtTime(startTime, [home[0], home[1] + slotHeight]);
    pos.setValueAtTime(startTime + duration, [home[0], home[1]]);
    easeLastTwoKeys(pos);
}

// Таблица всех стыков блоков правого слота (кроме погоды — её не трогаем
// по просьбе пользователя). Порядок = хронологический порядок в комп.
// outPlate/inPlate — имена слоёв-плашек в "подложка", outText/inText —
// имена precomp-слоёв в "ОСНОВА". startTime = граница блоков (совпадает
// с существующими inPoint/outPoint — см. живые данные, не выдумано).
// Обновлено 2026-08-25 под финальную структуру (206с→197с после ручных
// правок пользователя): новости начинаются сразу с контента (без
// отдельной шапки — стыка "шапка новости"->"новости текст" больше нет),
// именины — одна плашка (не поитемная), добавлен блок гороскопа.
// Последняя строка (195) — склейка лупа гороскоп->голова новости 1: тот
// же групповой механизм (текст+плашка), просто ещё один стык таблицы —
// по прямой просьбе пользователя не забыть этот переход.
// ВНИМАНИЕ (2026-08-25, после того как пользователь сам переструктурировал
// композиции): "шапка валюта текст" переименована в "курсы валют текст";
// "Шапка гороскоп" пользователь продублировал из той же композиции и не
// переименовал — живьём она называется "курсы валют текст 2", хотя
// содержит текст "ГОРОСКОП" (это шапка ГОРОСКОПА, не валюты). Если
// когда-нибудь переименуют для ясности — поправить строки 5/6 ниже.
// Границы (startTime) пересняты живьём 2026-08-25 после того, как
// пользователь вручную поменял длительности шапок и композиций
// новости/др/валюта/гороскоп — НЕ совпадают с предыдущей версией
// таблицы (было 78/80/87/89/97/99/195, сверено getLayerInfo, не выдумано).
// 2026-08-31: было `var BLOCK_TRANSITIONS = [...]` с зашитыми startTime.
// Теперь — ФУНКЦИЯ: (1) startTime у каждого стыка берётся живьём как
// inPoint входящего слоя (граница блока), а не из таблицы — та не раз
// устаревала после ручных правок длительностей; (2) список адаптируется
// к наличию блока «др»: если слоя «шапка др текст» в ОСНОВА нет (вариант
// «ОСНОВА без др»), первый стык идёт сразу новости→шапка валюты, а три
// «др»-строки выпадают. Так «Применить переходы» работает на обеих версиях.
function getBlockTransitions() {
    var osnova = getOsnova();
    var hasDr = !!(osnova && findLayerByName(osnova, "шапка др текст"));
    var rows = [];
    if (hasDr) {
        rows.push({ outText: "новости текст",      outPlate: "подложка под новости", inText: "шапка др текст",              inPlate: "шапка др" });
        rows.push({ outText: "шапка др текст",      outPlate: "шапка др",             inText: "др текст",                    inPlate: "подложка др" });
        rows.push({ outText: "др текст",            outPlate: "подложка др",          inText: "курсы валют текст",           inPlate: "шапка курс валют" });
    } else {
        rows.push({ outText: "новости текст",      outPlate: "подложка под новости", inText: "курсы валют текст",           inPlate: "шапка курс валют" });
    }
    rows.push({ outText: "курсы валют текст",   outPlate: "шапка курс валют",     inText: "валюта",                        inPlate: "подложка валюта" });
    rows.push({ outText: "валюта",              outPlate: "подложка валюта",      inText: "курсы валют текст 2",           inPlate: "шапка гороскоп" });
    rows.push({ outText: "курсы валют текст 2", outPlate: "шапка гороскоп",       inText: "гороскоп текст",                inPlate: "подложка гороскоп" });
    rows.push({ outText: "гороскоп текст",      outPlate: "подложка гороскоп",    inText: "новости текст первая новость",  inPlate: "подложка первая новость" });
    return rows;
}

// Применяет push-переход ко ВСЕМ 7 стыкам сразу, одним проходом
// (включая склейку лупа гороскоп->голова новости 1, см. таблицу выше).
function applyAllBlockTransitions() {
    var osnova = getOsnova();
    var podlozhka = getPodlozhka();
    if (!osnova) return "ERROR: comp not found: ОСНОВА";
    if (!podlozhka) return "ERROR: comp not found: подложка";

    var slotHeight = 89;
    var slotWidth = 761;
    var errors = [];

    var resolved = [];
    var TR = getBlockTransitions();
    for (var t = 0; t < TR.length; t++) {
        var tr = TR[t];
        var outTextLayer = findLayerByName(osnova, tr.outText);
        var outPlateLayer = findLayerByName(podlozhka, tr.outPlate);
        var inTextLayer = findLayerByName(osnova, tr.inText);
        var inPlateLayer = findLayerByName(podlozhka, tr.inPlate);
        if (!outTextLayer || !outPlateLayer || !inTextLayer || !inPlateLayer) {
            errors.push(tr.outText + "->" + tr.inText + ": слой не найден");
            continue;
        }
        // Граница стыка = inPoint входящего слоя (стабильно между прогонами —
        // переходы раздвигают только outPoint).
        resolved.push({ startTime: inTextLayer.inPoint, outText: outTextLayer, outPlate: outPlateLayer, inText: inTextLayer, inPlate: inPlateLayer });
    }
    if (resolved.length === 0) return "ERROR: ни один переход не собран: " + errors.join(" | ");

    var results = [];
    app.beginUndoGroup("Включайся!: переходы всех блоков");
    try {
        // Уникальный список слоёв (некоторые встречаются в 2 соседних
        // переходах — и как outgoing, и как incoming) — чистим и снимаем
        // "домашнюю" позицию КАЖДОМУ ровно один раз, до того как начнём
        // копить кейфреймы.
        var uniqueLayers = [];
        function collect(layer) {
            for (var i = 0; i < uniqueLayers.length; i++) {
                if (uniqueLayers[i] === layer) return;
            }
            uniqueLayers.push(layer);
        }
        for (var r = 0; r < resolved.length; r++) {
            collect(resolved[r].outText);
            collect(resolved[r].outPlate);
            collect(resolved[r].inText);
            collect(resolved[r].inPlate);
        }
        var homeByLayer = [];
        for (var u = 0; u < uniqueLayers.length; u++) {
            var lyr = uniqueLayers[u];
            var homeVal = lyr.property("Position").value;
            clearKeyframes(lyr.property("Position"));
            homeByLayer.push({ layer: lyr, pos: [homeVal[0], homeVal[1]] });
        }
        function getHome(layer) {
            for (var i = 0; i < homeByLayer.length; i++) {
                if (homeByLayer[i].layer === layer) return homeByLayer[i].pos;
            }
            return layer.property("Position").value;
        }

        // Маска-окно слота — на все уникальные плашки (текстовые слои и
        // так обрезаны своей 761x89-композицией, им маска не нужна).
        // Прямоугольник слота берём из РУЧНОЙ маски плашек ("Mask 1"), а не
        // из позиции "новости текст" (та даёт слот на 2px ниже). Плашки с
        // руч. маской не трогаем; "шапка гороскоп" (без маски) получит
        // AutoPogoda_slot ровно по этому же прямоугольнику. См. ensureSlotMask.
        var allPlates = [];
        for (var rp = 0; rp < resolved.length; rp++) { allPlates.push(resolved[rp].outPlate); allPlates.push(resolved[rp].inPlate); }
        var slotRect = resolveSlotRect(allPlates);
        for (var r2 = 0; r2 < resolved.length; r2++) {
            ensureSlotMask(resolved[r2].outPlate, slotRect);
            ensureSlotMask(resolved[r2].inPlate, slotRect);
        }

        // Раздвигаем outPoint исходящих (текст+плашка) под длительность
        // анимации — иначе анимация обрежется серединой (сейчас они
        // обрываются ровно на границе блока).
        for (var r3 = 0; r3 < resolved.length; r3++) {
            var newOut = resolved[r3].startTime + PUSH_DURATION;
            if (resolved[r3].outText.outPoint < newOut) resolved[r3].outText.outPoint = newOut;
            if (resolved[r3].outPlate.outPoint < newOut) resolved[r3].outPlate.outPoint = newOut;
        }

        // Сами кейфреймы — по закэшированным "домашним" позициям, не по
        // .value (которое к этому моменту для общих слоёв уже может
        // отражать анимацию соседнего перехода).
        for (var r4 = 0; r4 < resolved.length; r4++) {
            var tr4 = resolved[r4];
            addPushOutKeyframes(tr4.outText, getHome(tr4.outText), slotHeight, tr4.startTime, PUSH_DURATION);
            addPushOutKeyframes(tr4.outPlate, getHome(tr4.outPlate), slotHeight, tr4.startTime, PUSH_DURATION);
            addPushInKeyframes(tr4.inText, getHome(tr4.inText), slotHeight, tr4.startTime, PUSH_DURATION);
            addPushInKeyframes(tr4.inPlate, getHome(tr4.inPlate), slotHeight, tr4.startTime, PUSH_DURATION);
            results.push(tr4.startTime + "-" + (tr4.startTime + PUSH_DURATION).toFixed(1) + ": OK");
        }
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    var msg = "OK: " + results.join(" | ");
    if (errors.length) msg += " || ПРОПУЩЕНО: " + errors.join(" | ");
    return msg;
}

// ПРОТОТИП: один конкретный переход — "новости текст" (+ плашка "новости
// основа 5") уезжают, "шапка др текст" (+ плашка "шапка др") въезжают.
// slotHeight=89 — высота слота (см. комментарий в плане), startTime=59 —
// текущая граница блоков, duration=PUSH_DURATION.
// Раздвигаем outPoint уходящих слоёв, иначе анимация обрежется на
// середине (они сейчас обрываются ровно на границе, 59.02).
// Прямоугольник окна слота (в координатах "подложка"). Источник истины —
// РУЧНАЯ маска "Mask 1", которую пользователь нарисовал на плашках слота
// (x[1058..1819] y[915..1004], 761x89). Раньше он считался из позиции слоя
// "новости текст" в ОСНОВА и получался на 2px ниже — из-за этого после
// "Применить переходы" все плашки визуально опускались. Fallback —
// константа (на случай, если руч. маску кто-то удалил со всех плашек).
var SLOT_RECT_FALLBACK = { left: 1058, top: 915, width: 761, height: 89 };

// Первая НЕ-AutoPogoda_slot прямоугольная (4 вершины) маска слоя, или null.
function firstHandRectMask(layer) {
    var masks;
    try { masks = layer.property("ADBE Mask Parade"); } catch (e) { return null; }
    if (!masks) return null;
    for (var i = 1; i <= masks.numProperties; i++) {
        var m = masks.property(i);
        if (m.name === "AutoPogoda_slot") continue;
        var verts = null;
        try { verts = m.property("ADBE Mask Shape").value.vertices; } catch (e2) { continue; }
        if (verts && verts.length === 4) return m;
    }
    return null;
}

// bbox 4-вершинной маски -> {left, top, width, height}
function maskRectBBox(mask) {
    var v = mask.property("ADBE Mask Shape").value.vertices;
    var minX = v[0][0], maxX = v[0][0], minY = v[0][1], maxY = v[0][1];
    for (var i = 1; i < v.length; i++) {
        if (v[i][0] < minX) minX = v[i][0];
        if (v[i][0] > maxX) maxX = v[i][0];
        if (v[i][1] < minY) minY = v[i][1];
        if (v[i][1] > maxY) maxY = v[i][1];
    }
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

// Находит прямоугольник слота по руч. маске любой из плашек (или fallback).
function resolveSlotRect(plateLayers) {
    for (var i = 0; i < plateLayers.length; i++) {
        var hm = plateLayers[i] && firstHandRectMask(plateLayers[i]);
        if (hm) {
            var r = maskRectBBox(hm);
            return { left: Math.round(r.left), top: Math.round(r.top),
                     width: Math.round(r.width), height: Math.round(r.height) };
        }
    }
    return SLOT_RECT_FALLBACK;
}

// Плашки в "подложка" — ПОЛНОКАДРОВЫЕ 1920x1080 PSD. Чтобы во время push
// цветная полоса не вылезала за слот, её обрезают прямоугольной маской по
// границам слота. Пользователь нарисовал такую маску руками ("Mask 1") на
// всех плашках, КРОМЕ "шапка гороскоп". Правило:
//   - руч. маска (не AutoPogoda_slot, 4 вершины) уже есть — НЕ ТРОГАЕМ её,
//     только подчищаем устаревшую AutoPogoda_slot от прошлых прогонов;
//   - руч. маски нет ("шапка гороскоп") — создаём/обновляем AutoPogoda_slot
//     по прямоугольнику слота (rect в координатах компа; у плашек
//     Position = Anchor = [960,540], Scale 100 => это же координаты слоя).
function ensureSlotMask(layer, rect) {
    var masks;
    try { masks = layer.property("ADBE Mask Parade"); }
    catch (e1) { throw new Error("ensureSlotMask[" + layer.name + "]: ADBE Mask Parade -> " + e1.toString()); }
    if (!masks) throw new Error("ensureSlotMask[" + layer.name + "]: ADBE Mask Parade == null");

    function findByName(nm) {
        for (var i = 1; i <= masks.numProperties; i++) if (masks.property(i).name === nm) return masks.property(i);
        return null;
    }

    if (firstHandRectMask(layer)) {
        var stale = findByName("AutoPogoda_slot");
        if (stale) stale.remove();
        return null;
    }

    var mask = findByName("AutoPogoda_slot");
    if (!mask) {
        mask = masks.addProperty("ADBE Mask Atom");
        mask.name = "AutoPogoda_slot";
    }

    var L = rect.left, T = rect.top, W = rect.width, H = rect.height;
    var shape = new Shape();
    shape.vertices = [[L, T], [L + W, T], [L + W, T + H], [L, T + H]];
    shape.closed = true;
    shape.inTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
    shape.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
    mask.property("ADBE Mask Shape").setValue(shape);
    mask.maskMode = MaskMode.ADD;
    return mask;
}

// ДИАГНОСТИКА (временная) — выгружает геометрию + ВСЕ маски плашек слота
// и эталонного текстового слоя в preview/slot_diag.json. Читается снаружи,
// чтобы понять, из-за чего "шапка гороскоп" подрезается сверху в переходе.
// Вызвать из консоли панели: dumpSlotPlates()
function dumpSlotPlates() {
    function j(o) {
        if (o === null || o === undefined) return "null";
        var t = typeof o;
        if (t === "number") return (isFinite(o) ? String(o) : "null");
        if (t === "boolean") return String(o);
        if (t === "string") return '"' + o.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
        if (o instanceof Array) {
            var a = [];
            for (var i = 0; i < o.length; i++) a.push(j(o[i]));
            return "[" + a.join(",") + "]";
        }
        var p = [];
        for (var k in o) { if (o.hasOwnProperty(k)) p.push('"' + k + '":' + j(o[k])); }
        return "{" + p.join(",") + "}";
    }
    function maskModeName(mm) {
        if (mm === MaskMode.NONE) return "NONE";
        if (mm === MaskMode.ADD) return "ADD";
        if (mm === MaskMode.SUBTRACT) return "SUBTRACT";
        if (mm === MaskMode.INTERSECT) return "INTERSECT";
        if (mm === MaskMode.LIGHTEN) return "LIGHTEN";
        if (mm === MaskMode.DARKEN) return "DARKEN";
        if (mm === MaskMode.DIFFERENCE) return "DIFFERENCE";
        return "?";
    }
    function masksOf(layer) {
        var out = [];
        var parade = layer.property("ADBE Mask Parade");
        if (!parade) return out;
        for (var i = 1; i <= parade.numProperties; i++) {
            var m = parade.property(i);
            var verts = null;
            try { verts = m.property("ADBE Mask Shape").value.vertices; } catch (e) {}
            var vv = [];
            if (verts) for (var v = 0; v < verts.length; v++) vv.push([verts[v][0], verts[v][1]]);
            var expansion = null;
            try { expansion = m.property("ADBE Mask Offset").value; } catch (e2) {}
            out.push({ name: m.name, mode: maskModeName(m.maskMode), inverted: m.inverted, expansion: expansion, vertices: vv });
        }
        return out;
    }
    function info(comp, name) {
        if (!comp) return { error: "no comp" };
        var l = findLayerByName(comp, name);
        if (!l) return { error: "layer not found: " + name };
        var src = l.source;
        return {
            name: l.name,
            position: l.property("Position").value,
            anchor: l.property("Anchor Point").value,
            scale: l.property("Scale").value,
            inPoint: l.inPoint, outPoint: l.outPoint, startTime: l.startTime,
            sourceW: src ? src.width : null, sourceH: src ? src.height : null,
            masks: masksOf(l)
        };
    }
    var osnova = getOsnova();
    var podlozhka = getPodlozhka();
    var result = {
        osnovaFound: !!osnova,
        podlozhkaLayers: podlozhka ? podlozhka.numLayers : null,
        ref_novosti_tekst_v_OSNOVA: info(osnova, "новости текст"),
        podlozhka_layer_v_OSNOVA: info(osnova, "подложка"),
        plates: {}
    };
    var names = ["подложка валюта", "шапка гороскоп", "подложка гороскоп",
        "шапка др", "подложка др", "шапка курс валют", "новости основа 3",
        "подложка под новости", "новости основа 5"];
    for (var n = 0; n < names.length; n++) result.plates[names[n]] = info(podlozhka, names[n]);

    var outFile = new File(getProjectRootFolder() + "/preview/slot_diag.json");
    var dir = outFile.parent;
    if (!dir.exists) dir.create();
    outFile.encoding = "UTF-8";
    outFile.open("w");
    outFile.write(j(result));
    outFile.close();
    return "OK: " + outFile.fsName;
}

function testNewsToBirthdayHeaderTransition() {
    var osnova = getOsnova();
    var podlozhka = getPodlozhka();
    if (!osnova) return "ERROR: comp not found: основа";
    if (!podlozhka) return "ERROR: comp not found: подложка";

    var newsTextLayer = findLayerByName(osnova, "новости текст");
    var birthdayHeaderLayer = findLayerByName(osnova, "шапка др текст");
    var newsPlateLayer = findLayerByName(podlozhka, "новости основа 5");
    var birthdayPlateLayer = findLayerByName(podlozhka, "шапка др");

    if (!newsTextLayer) return "ERROR: layer not found: новости текст (в основа)";
    if (!birthdayHeaderLayer) return "ERROR: layer not found: шапка др текст (в основа)";
    if (!newsPlateLayer) return "ERROR: layer not found: новости основа 5 (в подложка)";
    if (!birthdayPlateLayer) return "ERROR: layer not found: шапка др (в подложка)";

    var startTime = 59;
    var slotHeight = 89;
    var slotWidth = 761;

    app.beginUndoGroup("Включайся!: тест перехода новости->именины");
    try {
        var newOut = startTime + PUSH_DURATION;
        if (newsTextLayer.outPoint < newOut) newsTextLayer.outPoint = newOut;
        if (newsPlateLayer.outPoint < newOut) newsPlateLayer.outPoint = newOut;

        // Прямоугольник слота — из руч. маски плашек (см. resolveSlotRect).
        var slotRect = resolveSlotRect([newsPlateLayer, birthdayPlateLayer]);

        ensureSlotMask(newsPlateLayer, slotRect);
        ensureSlotMask(birthdayPlateLayer, slotRect);

        pushTransitionGroup(
            [newsTextLayer, newsPlateLayer],
            [birthdayHeaderLayer, birthdayPlateLayer],
            slotHeight, startTime, PUSH_DURATION
        );
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "OK: переход настроен на " + startTime + "-" + newOut + "с";
}

// Откатывает переходы на ВСЕХ слоях, задействованных в переходах:
// Position-keyframes + раздвинутый outPoint у блоков (BLOCK_TRANSITIONS),
// keyframes у пунктов новостей/гороскопа и у валюты. ПЕРЕПИСАН 2026-08-25
// (был полностью мёртвый код — захардкожен под структуру на 126с,
// "Шапка новости текст"/CNY-слои/маску "AutoPogoda_slot", ничего из
// этого в текущем проекте не существует) — теперь всё читается из
// ЖИВОЙ `BLOCK_TRANSITIONS` и актуальных констант количества пунктов, а
// не из снимка на конкретную дату. OSNOVA_HOME/PODLOZHKA_HOME — две
// геометрические константы, общие для ВСЕХ текстовых обёрток/плашек по
// конструкции проекта (проверено живьём), не привязаны к структуре блоков.
function resetAllTransitions() {
    var osnova = getOsnova();
    var podlozhka = getPodlozhka();
    if (!osnova) return "ERROR: comp not found: ОСНОВА";
    if (!podlozhka) return "ERROR: comp not found: подложка";

    var OSNOVA_HOME = [1438.27835083008, 959.466720581055];
    var PODLOZHKA_HOME = [960, 540];

    var results = [];
    app.beginUndoGroup("Включайся!: сброс всех переходов");
    try {
        var doneOsnova = {}, donePodlozhka = {};
        var TR = getBlockTransitions();

        // Уходящие (outText/outPlate) — сбрасываем Position + возвращаем
        // outPoint к нативной границе блока, убирая раздвижку под анимацию.
        // Граница = inPoint входящего слоя этого же стыка (раньше был
        // зашитый tr.startTime).
        for (var t = 0; t < TR.length; t++) {
            var tr = TR[t];
            var trInText = findLayerByName(osnova, tr.inText);
            var trInPlate = findLayerByName(podlozhka, tr.inPlate);

            var outTextLayer = findLayerByName(osnova, tr.outText);
            if (outTextLayer && !doneOsnova[tr.outText]) {
                clearKeyframes(outTextLayer.property("Position"));
                outTextLayer.property("Position").setValue(OSNOVA_HOME);
                if (trInText) outTextLayer.outPoint = trInText.inPoint;
                results.push(tr.outText + ": OK");
                doneOsnova[tr.outText] = true;
            } else if (!outTextLayer) { results.push(tr.outText + ": слой не найден"); }

            var outPlateLayer = findLayerByName(podlozhka, tr.outPlate);
            if (outPlateLayer && !donePodlozhka[tr.outPlate]) {
                clearKeyframes(outPlateLayer.property("Position"));
                outPlateLayer.property("Position").setValue(PODLOZHKA_HOME);
                if (trInPlate) outPlateLayer.outPoint = trInPlate.inPoint;
                removeNamedMask(outPlateLayer, "AutoPogoda_slot");
                results.push(tr.outPlate + ": OK");
                donePodlozhka[tr.outPlate] = true;
            } else if (!outPlateLayer) { results.push(tr.outPlate + ": слой не найден"); }
        }

        // Входящие (inText/inPlate) — только Position (outPoint у них не
        // раздвигался переходом, границу задаёт следующая строка таблицы
        // как СВОЙ outText) — покрывает и "loop-seam"-слой в последней
        // строке, у которого нет своей собственной "outText"-роли вообще.
        for (var t2 = 0; t2 < TR.length; t2++) {
            var tr2 = TR[t2];
            var inTextLayer = findLayerByName(osnova, tr2.inText);
            if (inTextLayer && !doneOsnova[tr2.inText]) {
                clearKeyframes(inTextLayer.property("Position"));
                inTextLayer.property("Position").setValue(OSNOVA_HOME);
                results.push(tr2.inText + ": OK (вход)");
                doneOsnova[tr2.inText] = true;
            }
            var inPlateLayer = findLayerByName(podlozhka, tr2.inPlate);
            if (inPlateLayer && !donePodlozhka[tr2.inPlate]) {
                clearKeyframes(inPlateLayer.property("Position"));
                inPlateLayer.property("Position").setValue(PODLOZHKA_HOME);
                removeNamedMask(inPlateLayer, "AutoPogoda_slot");
                results.push(tr2.inPlate + ": OK (вход)");
                donePodlozhka[tr2.inPlate] = true;
            }
        }

        // Пункты новостей/гороскопа — только чистим keyframes; позицию НЕ
        // трогаем (её ставит applyNewsItems/applyHoroscopeItems при
        // следующей загрузке контента, не сам переход).
        resetItemLinesDynamic(findCompByName("новости текст"), "новость ", NEWS_ITEM_COUNT, false, results);
        resetItemLinesDynamic(findCompByName("гороскоп текст"), "гороскоп ", HOROSCOPE_ITEM_COUNT, true, results);

        // Валюта — актуальные имена (RUB/EUR/USD, юань заменён на евро
        // 2026-08-25, старый CNY больше не существует в проекте).
        var valutaComp = findCompByName("валюта");
        if (valutaComp) {
            var currencyLayerNames = ["RUB 100 ", " rate_RUB", "EUR", "rate_EUR", "USD", "rate_USD"];
            for (var cv = 0; cv < currencyLayerNames.length; cv++) {
                var cvLayer = findLayerByNameLoose(valutaComp, currencyLayerNames[cv]);
                if (cvLayer) { clearKeyframes(cvLayer.property("Position")); results.push(currencyLayerNames[cv] + ": OK"); }
                else { results.push(currencyLayerNames[cv] + ": слой не найден"); }
            }
        } else { results.push("валюта: комп не найден"); }
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "OK: сброшено — " + results.join(" | ");
}

// Хелпер для resetAllTransitions (динамический — не хардкод): чистит
// Position-keyframes у "prefix N"/"prefix N _2" для всех itemCount
// пунктов. Позицию НЕ трогаем — актуальное значение всегда ставит
// applyNewsItems/applyHoroscopeItems, не сам переход.
function resetItemLinesDynamic(comp, prefix, itemCount, looseNames, results) {
    if (!comp) { results.push(prefix + "*: комп не найден"); return; }
    for (var i = 1; i <= itemCount; i++) {
        var name = prefix + i;
        var line1 = looseNames ? (findLayerByNameLoose(comp, name) || findLayerByNameCI(comp, name)) : findLayerByName(comp, name);
        if (!line1) { results.push(name + ": слой не найден"); continue; }
        clearKeyframes(line1.property("Position"));

        var line2 = findLayerByName(comp, name + " _2");
        if (line2) clearKeyframes(line2.property("Position"));
        results.push(name + ": OK");
    }
}

// Удаляет маску с данным именем с слоя, если она есть (безопасно, если
// её нет вообще — просто ничего не делает).
function removeNamedMask(layer, maskName) {
    var masks = layer.property("ADBE Mask Parade");
    if (!masks) return;
    for (var i = masks.numProperties; i >= 1; i--) {
        if (masks.property(i).name === maskName) {
            masks.property(i).remove();
        }
    }
}

// ============================================================
// ПЕРЕХОДЫ МЕЖДУ САМИМИ ПУНКТАМИ (новость N -> новость N+1, аналогично
// именины) — подложка тут одна и та же всё время, меняется только текст.
// Условие: 2-строчная новость не должна ехать единым блоком — нижняя
// строка едет с отставанием (LINE_LAG) и "подтягивается". Технически
// возможно только если каждая строка — свой слой, поэтому рядом с
// существующим "новость N" (строка 1) заводим "новость N _2" (строка 2).
// ============================================================
var LINE_LAG = 0.1; // сек — на столько строка 2 стартует и финиширует позже строки 1

// Дублирует line1Layer под именем line2Name, если такого слоя ещё нет
// (идемпотентно — можно жать повторно).
function ensureLine2Layer(comp, line1Layer, line2Name) {
    var existing = findLayerByName(comp, line2Name);
    if (existing) return existing;
    var dup = line1Layer.duplicate();
    dup.name = line2Name;
    return dup;
}

// Левое выравнивание абзаца (по образцу "новость 1"/"гороскоп 1",
// выровненных пользователем вручную 2026-08-25).
function setLeftJustify(layer) {
    var textProp = layer.property("Source Text");
    var doc = textProp.value;
    doc.justification = ParagraphJustification.LEFT_JUSTIFY;
    textProp.setValue(doc);
}

// Раскладывает результат prepareNewsText() на 1 или 2 слоя. Левое
// выравнивание (2026-08-25): anchor ВСЕГДА [0,0] (X И Y — статично, без
// какой-либо динамической центровки по рендеру), X ВСЕГДА = baseX. Для
// 1-строчного случая Y = baseY (эталон "новость 1"/"гороскоп 1"). Для
// 2-строчного случая Y НЕ вычисляется формулой (±leading/2 — это было
// гадание, см. правку 2026-08-25) — вместо этого используются upperY/
// lowerY, СНЯТЫЕ ЖИВЬЁМ с эталонных слоёв-образцов, которые пользователь
// сам расставил ("новость 1_верхняя"/"_нижняя", "гороскоп 1_верохний"/
// "_нижний" — см. applyNewsItems/applyHoroscopeItems).
// РАЗМЕР ШРИФТА ВСЕГДА ФИКСИРОВАН (2026-08-25, прямое указание
// пользователя): раньше был shrink-guard, уменьшавший fontSize, если
// текст не помещался в плашку — убрано намеренно ("сохраняем размер
// текста всегда одинаковый... не наша проблема, пусть редактор пришлёт
// новость короче"). Если текст не влезает/выпирает — это ожидаемо,
// ничего не подгоняем.
// Обобщённый "движок" раскладки (2026-08-28) — вынесен из
// applyTwoLineLayout, чтобы разбиение текста на строки (у новостей/
// гороскопа — по словам через prepareNewsText, у именин — по запятым/
// именам) не было зашито внутри самой раскладки. Принимает УЖЕ готовый
// массив строк (`lines`, 1 или 2 элемента) и опции — читает
// X/Y/anchor/fontSize для 1- и 2-строчного случая РАЗДЕЛЬНО, потому что
// у "именины"/"именины верх"/"именины низ" anchor НЕ [0,0] (в отличие от
// новостей/гороскопа, где он живьём всегда [0,0]), а после того как
// пользователь один раз подвинул композиции, X у "гороскоп 1" разошёлся
// с X у "гороскоп 1_верохний"/"_нижний" — раньше это было зашито как
// один и тот же baseX на оба случая, из-за чего 2-строчные пункты слегка
// не совпадали по горизонтали с эталоном.
// opts: {oneLineX, oneLineY, twoLineX, upperY, lowerY, oneLineFontSize,
//        twoLineFontSize, oneLineAnchor, upperAnchor, lowerAnchor}
// Анкоры не переданы -> fallback [0,0] (ничего не меняет для новостей/
// гороскопа, у них он и так [0,0]). twoLineX не передан -> = oneLineX.
function applyLinesLayoutCore(line1Layer, line2Layer, lines, opts) {
    // Снять keyframes с Position ДО того, как ниже вызовется .setValue() —
    // если пункт уже прошёл через "Применить переходы", его Position
    // анимирован (push-keyframes), и setValue на анимированном свойстве
    // либо no-op, либо пишет значение не туда — независимо от того, что
    // мы посчитаем ниже, текст физически не встанет на место, пока слой
    // остаётся keyframed. line2Layer тоже может унаследовать эти keyframes
    // (ensureLine2Layer дублирует line1Layer целиком, включая анимацию).
    clearKeyframes(line1Layer.property("Position"));
    if (line2Layer) clearKeyframes(line2Layer.property("Position"));

    // Размер шрифта (2026-08-27) — ВСЕГДА живьём от эталонных слоёв,
    // переданных вызывающей функцией, а не глобальная константа —
    // пользователь может в любой момент поправить эталон в AE, и это
    // должно подхватываться без правок кода.
    var oneLineFS = opts.oneLineFontSize || TEXT_FONT_SIZE;
    var twoLineFS = opts.twoLineFontSize || TEXT_FONT_SIZE;
    var oneAnc = opts.oneLineAnchor || [0, 0];
    var upAnc = opts.upperAnchor || [0, 0];
    var lowAnc = opts.lowerAnchor || [0, 0];
    var twoLineX = (opts.twoLineX !== undefined && opts.twoLineX !== null) ? opts.twoLineX : opts.oneLineX;

    function setLineText(layer, text, fs, ld) {
        var textProp = layer.property("Source Text");
        var doc = textProp.value;
        doc.text = text;
        doc.fontSize = fs;
        doc.autoLeading = false;
        doc.leading = ld;
        textProp.setValue(doc);
    }

    if (lines.length <= 1) {
        var oneLineLeading = oneLineFS * 1.15;
        setLineText(line1Layer, lines[0] || "", oneLineFS, oneLineLeading);
        setLeftJustify(line1Layer);
        line1Layer.property("Anchor Point").setValue(oneAnc);
        line1Layer.property("Position").setValue([opts.oneLineX, opts.oneLineY]);
        line1Layer.enabled = true;
        if (line2Layer) {
            setLineText(line2Layer, "", oneLineFS, oneLineLeading);
            line2Layer.enabled = false;
        }
        return;
    }

    var twoLineLeading = twoLineFS * 1.15;
    line1Layer.enabled = true;
    if (line2Layer) line2Layer.enabled = true;
    setLineText(line1Layer, lines[0], twoLineFS, twoLineLeading);
    setLineText(line2Layer, lines[1], twoLineFS, twoLineLeading);

    // upperY/lowerY — снятые живьём координаты эталонных 2-строчных
    // слоёв-образцов (не формула) — fallback на ±leading/2 только если
    // эталон не передали/не нашли.
    var line1Y = (opts.upperY !== undefined && opts.upperY !== null) ? opts.upperY : (opts.oneLineY - twoLineLeading / 2);
    var line2Y = (opts.lowerY !== undefined && opts.lowerY !== null) ? opts.lowerY : (opts.oneLineY + twoLineLeading / 2);

    setLeftJustify(line1Layer);
    line1Layer.property("Anchor Point").setValue(upAnc);
    line1Layer.property("Position").setValue([twoLineX, line1Y]);

    setLeftJustify(line2Layer);
    line2Layer.property("Anchor Point").setValue(lowAnc);
    line2Layer.property("Position").setValue([twoLineX, line2Y]);
}

// Обёртка обратной совместимости (2026-08-28) — старая сигнатура,
// используется только неиспользуемым/тестовым кодом (applyBirthdayItems,
// testItemToItemTransition — ни один не вызывается панелью, проверено по
// main.js), чтобы их не трогать. Новые вызовы (applyNewsItems/
// applyHoroscopeItems/applyBirthdayNames) идут напрямую через
// applyLinesLayoutCore — им нужны anchor и отдельный twoLineX, которых
// в этой обёртке нет (fallback [0,0]/baseX, как было раньше).
function applyTwoLineLayout(line1Layer, line2Layer, raw, mode, baseX, baseY, upperY, lowerY, oneLineFontSize, twoLineFontSize) {
    var prepared = prepareNewsText(raw, mode);
    var lines = prepared.text.split("\r");
    applyLinesLayoutCore(line1Layer, line2Layer, lines, {
        oneLineX: baseX, oneLineY: baseY, twoLineX: baseX,
        upperY: upperY, lowerY: lowerY,
        oneLineFontSize: oneLineFontSize, twoLineFontSize: twoLineFontSize
    });
}

// ПРОТОТИП: переход новость1->новость2 с отстающей строкой 2. Тестовые
// тексты — заведомо 2-строчные (уже проверенные ранее по ширине), чтобы
// отставание было видно на глаз.
function testItemToItemTransition() {
    var newsComp = findCompByName("новости текст");
    if (!newsComp) return "ERROR: comp not found: новости текст";

    var item1Line1 = findLayerByName(newsComp, "новость 1");
    var item2Line1 = findLayerByName(newsComp, "новость 2");
    if (!item1Line1) return "ERROR: layer not found: новость 1";
    if (!item2Line1) return "ERROR: layer not found: новость 2";

    app.beginUndoGroup("Включайся!: тест перехода новость1->новость2");
    try {
        var item1Line2 = ensureLine2Layer(newsComp, item1Line1, "новость 1 _2");
        var item2Line2 = ensureLine2Layer(newsComp, item2Line1, "новость 2 _2");

        var maxTextWidth = newsComp.width - 60;
        var maxTextHeight = newsComp.height - 10;
        var targetCenterX = newsComp.width / 2;
        var targetCenterY = newsComp.height / 2;

        applyTwoLineLayout(item1Line1, item1Line2,
            "Археологи обнаружили остатки древнего поселения при раскопках возле Полоцка.",
            "auto", targetCenterX, targetCenterY, maxTextWidth, maxTextHeight);
        applyTwoLineLayout(item2Line1, item2Line2,
            "Открылась запись на курсы английского.",
            "auto", targetCenterX, targetCenterY, maxTextWidth, maxTextHeight);

        var startTime = item1Line1.outPoint; // реальная граница слотов, не выдумана
        var slotHeight = 89;
        // Уход — синхронно (обе строки за PUSH_DURATION, без отставания),
        // иначе к моменту появления следующей новости прошлая строка 2
        // ещё не успевает уехать и налезает на новую. Отставание —
        // только на ПОЯВЛЕНИИ (строка 2 входящей новости).
        var newOut = startTime + PUSH_DURATION;

        item1Line1.outPoint = newOut;
        item1Line2.outPoint = newOut;

        clearKeyframes(item1Line1.property("Position"));
        clearKeyframes(item2Line1.property("Position"));
        clearKeyframes(item1Line2.property("Position"));
        clearKeyframes(item2Line2.property("Position"));

        var home1L1 = item1Line1.property("Position").value;
        var home1L2 = item1Line2.property("Position").value;
        var home2L1 = item2Line1.property("Position").value;
        var home2L2 = item2Line2.property("Position").value;

        addPushOutKeyframes(item1Line1, home1L1, slotHeight, startTime, PUSH_DURATION);
        addPushInKeyframes(item2Line1, home2L1, slotHeight, startTime, PUSH_DURATION);

        if (item1Line2.enabled) {
            addPushOutKeyframes(item1Line2, home1L2, slotHeight, startTime, PUSH_DURATION);
        }
        if (item2Line2.enabled) {
            addPushInKeyframes(item2Line2, home2L2, slotHeight, startTime + LINE_LAG, PUSH_DURATION);
        }

        app.endUndoGroup();
        return "OK: старт=" + startTime + "с, окно строки1=" + PUSH_DURATION + "с, лаг строки2=" + LINE_LAG + "с";
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
}

// Строит push-переходы item->item+1 для ВСЕХ пар подряд в одной
// композиции (новости или именины) — уход синхронный (обе строки вместе,
// иначе следующая налезает на ещё не уехавшую строку 2), заход строки 2
// с отставанием LINE_LAG. Рассчитано на то, что applyNewsItems/
// applyBirthdayItems уже отработали (line2.enabled отражает реальное
// 1/2-строчное состояние текущего контента).
function applyAllItemTransitions(compName, itemPrefix, itemCount) {
    var comp = findCompByName(compName);
    if (!comp) return "ERROR: comp not found: " + compName;

    var slotHeight = 89;
    var results = [];
    app.beginUndoGroup("Включайся!: переходы между пунктами (" + compName + ")");
    try {
        var items = [];
        for (var i = 1; i <= itemCount; i++) {
            var name = itemPrefix + i;
            var line1 = findLayerByName(comp, name);
            if (!line1) { results.push(name + ": слой не найден"); continue; }
            var line2 = ensureLine2Layer(comp, line1, name + " _2");
            items.push({ line1: line1, line2: line2 });
        }
        if (items.length < 2) {
            app.endUndoGroup();
            return "ERROR: недостаточно слоёв: " + results.join(" | ");
        }

        // Чистим Position каждому участвующему слою один раз заранее
        // (каждый слой встречается максимум в 2 переходах — как outgoing
        // и потом как incoming) и снимаем "домашние" значения один раз,
        // до того как начнём копить кейфреймы (см. applyAllBlockTransitions
        // — та же схема, тот же повод).
        for (var c = 0; c < items.length; c++) {
            clearKeyframes(items[c].line1.property("Position"));
            clearKeyframes(items[c].line2.property("Position"));
        }
        var home1 = [], home2 = [];
        for (var h = 0; h < items.length; h++) {
            home1.push(items[h].line1.property("Position").value);
            home2.push(items[h].line2.property("Position").value);
        }

        for (var t = 0; t < items.length - 1; t++) {
            var outItem = items[t], inItem = items[t + 1];
            var startTime = outItem.line1.outPoint; // реальная граница пунктов
            var newOut = startTime + PUSH_DURATION;
            outItem.line1.outPoint = newOut;
            if (outItem.line2.enabled) outItem.line2.outPoint = newOut;

            addPushOutKeyframes(outItem.line1, home1[t], slotHeight, startTime, PUSH_DURATION);
            addPushInKeyframes(inItem.line1, home1[t + 1], slotHeight, startTime, PUSH_DURATION);

            if (outItem.line2.enabled) {
                addPushOutKeyframes(outItem.line2, home2[t], slotHeight, startTime, PUSH_DURATION);
            }
            if (inItem.line2.enabled) {
                addPushInKeyframes(inItem.line2, home2[t + 1], slotHeight, startTime + LINE_LAG, PUSH_DURATION);
            }
            results.push(itemPrefix + (t + 1) + "->" + itemPrefix + (t + 2) + ": OK");
        }

        // Последний пункт блока НИКОГДА не был "уходящим" в цикле выше (не
        // в кого выталкивать дальше ВНУТРИ блока) — но ему всё равно нужен
        // тот же "хвост" +PUSH_DURATION, чтобы дожить до конца ГРАНИЧНОГО
        // перехода на следующий блок (BLOCK_TRANSITIONS/
        // applyAllBlockTransitions), где именно этот слой продолжает
        // выталкиваться дальше. Без этого текст последнего пункта
        // обрывается раньше конца анимации перехода — именно это
        // пользователь увидел живьём на "новость 10"/"новость 10_2"
        // (2026-08-25): "новость 9" была продлена (+0.7), "новость 10" — нет.
        var lastItem = items[items.length - 1];
        var lastNewOut = lastItem.line1.outPoint + PUSH_DURATION;
        lastItem.line1.outPoint = lastNewOut;
        if (lastItem.line2.enabled) lastItem.line2.outPoint = lastNewOut;
        results.push(itemPrefix + items.length + ": хвост +" + PUSH_DURATION + "с (для перехода на след. блок)");
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "OK: " + results.join(" | ");
}

// ============================================================
// ВАЛЮТА — внутри блока нет отдельных "пунктов" (все 3 валюты видны
// одновременно), но код (RUB 100/EUR/USD) и значение (rate_RUB/
// rate_EUR/rate_USD) — уже отдельные слои (юань заменён на евро
// 2026-08-25). При появлении блока (после
// того, как сама плашка "валюта" уже полностью доехала своим блочным
// push'ем, см. BLOCK_TRANSITIONS) код и значение въезжают тоже
// вытеснением, с отставанием: сначала код, потом значение — тот же
// приём, что и со строками новостей/гороскопа (addPushInKeyframes).
//
// Была версия с Opacity (диагностика показала, что дело не в механизме
// анимации, а в том, что keyframes ставились не в то время — см.
// localOffset ниже) — раз причина найдена и исправлена, вернули обычный
// push (вытеснение), как и было задумано изначально.
// ============================================================
var CURRENCY_VALUE_LAG = 0.25; // сек — значение курса отстаёт от кода валюты

function applyCurrencyRevealOffset() {
    var osnova = getOsnova();
    var comp = findCompByName("валюта");
    if (!comp) return "ERROR: comp not found: валюта";
    if (!osnova) return "ERROR: comp not found: ОСНОВА";

    var valutaLayerInOsnova = findLayerByName(osnova, "валюта");
    if (!valutaLayerInOsnova) return "ERROR: слой 'валюта' не найден в ОСНОВА";

    // КРИТИЧНО: keyframes внутри compа "валюта" ставятся в ЕГО СОБСТВЕННОМ
    // локальном времени, а не в абсолютном времени ОСНОВА — эти два
    // времени совпадают 1:1 ТОЛЬКО если layer.startTime у слоя "валюта"
    // (в ОСНОВА) равен 0. Если слой когда-то перетаскивали по таймлайну
    // целиком (а не только подрезали края) — напр. при ручном сдвиге
    // всего проекта на -9с после сокращения блока "др" — startTime мог
    // сместиться, и локальное время внутри compа разъезжается с
    // абсолютным (было обнаружено именно так: 89с в ОСНОВА показывали
    // 98с внутри "валюта" — расхождение ровно 9с). Пересчитываем через
    // реальный startTime, а не считаем локальное время равным абсолютному.
    var localOffset = valutaLayerInOsnova.startTime;

    var codeNames = ["RUB 100 ", "EUR", "USD"];
    var valueNames = [" rate_RUB", "rate_EUR", "rate_USD"];
    var slotHeight = 89;
    // Начало блока «валюта» (АБСОЛЮТНОЕ время ОСНОВА) = inPoint слоя «валюта»
    // (2026-08-31: раньше искали строку в BLOCK_TRANSITIONS и брали её
    // зашитый startTime; теперь таблица динамическая и без startTime).
    // Инвариант к сдвигу блока: blockStartAbs - localOffset (= локальное
    // время в compе «валюта») не меняется, т.к. startTime и inPoint слоя
    // «валюта» двигаются вместе.
    var blockStartAbs = valutaLayerInOsnova.inPoint;
    var startTime = blockStartAbs - localOffset;
    var results = ["localOffset=" + localOffset.toFixed(2)];

    app.beginUndoGroup("Включайся!: раскрытие валюты (код/значение с отставанием)");
    try {
        function pushGroupIn(names, lag) {
            for (var i = 0; i < names.length; i++) {
                var layer = findLayerByNameLoose(comp, names[i]);
                if (!layer) { results.push(names[i] + ": слой не найден"); continue; }
                clearKeyframes(layer.property("Position"));
                var home = layer.property("Position").value;
                addPushInKeyframes(layer, home, slotHeight, startTime + lag, PUSH_DURATION);
                results.push(names[i] + ": OK");
            }
        }
        pushGroupIn(codeNames, 0);
        pushGroupIn(valueNames, CURRENCY_VALUE_LAG);
    } catch (e) {
        app.endUndoGroup();
        return "ERROR: " + e.toString();
    }
    app.endUndoGroup();
    return "OK: " + results.join(" | ");
}

// Один клик — переходы между пунктами новостей, именин, и раскрытие
// валюты, все сразу.
function applyAllItemAndCurrencyTransitions() {
    var r1 = applyAllItemTransitions("новости текст", "новость ", NEWS_ITEM_COUNT);
    var r2 = applyAllItemTransitions("гороскоп текст", "гороскоп ", HOROSCOPE_ITEM_COUNT);
    var r3 = applyCurrencyRevealOffset();
    return "НОВОСТИ: " + r1 + " || ГОРОСКОП: " + r2 + " || ВАЛЮТА: " + r3;
}

// Единая кнопка "Применить переходы" (2026-08-25) — раньше в панели было
// 2 отдельные кнопки (переходы блоков + переходы пунктов/валюты),
// объединяем в один клик.
function applyAllTransitionsCombined() {
    var r1 = applyAllBlockTransitions();
    var r2 = applyAllItemAndCurrencyTransitions();
    return "БЛОКИ: " + r1 + " || ПУНКТЫ/ВАЛЮТА: " + r2;
}

// ============================================================
// РЕСТРУКТУРИЗАЦИЯ ПОСЛЕДОВАТЕЛЬНОСТИ (2026-08-25) — одноразовая
// перестройка ОСНОВА под новый порядок блоков:
//   новость1(хвост 0-6) → новости 2-10 (6-78) → шапка именины (78-80) →
//   именины 1-2 (80-96) → шапка валюта (96-98) → валюта (98-106) →
//   шапка гороскоп (106-108) → гороскоп 1-12 (108-204) →
//   новость1(голова 204-206) → луп на 0.
// Вызывается ОДИН РАЗ из отдельного standalone-скрипта
// (E:\включайся\Graph\restructure_project.jsx, через #include),
// НЕ кнопка панели — разовое структурное изменение, не ежедневное
// действие. Каждый шаг — свой undo-group, чтобы при сбое можно было
// откатывать Ctrl+Z по шагам, а не всё разом.
//
// ЯВНО НЕ входит в этот шаг (по прямой просьбе пользователя): настройка
// push-переходов/анимаций для новых границ блоков — это отдельная
// следующая задача, BLOCK_TRANSITIONS/applyAllBlockTransitions тут не
// трогаются (после этой перестройки их startTime уже не совпадают с
// новыми границами — ожидаемо, будет пересобрано в следующем шаге).
// ============================================================
function restructureToNewSequence() {
    var NEW_TOTAL_DURATION = 206;
    var report = [];

    var osnova = findCompByName("ОСНОВА");
    if (!osnova) return "ERROR: comp not found: ОСНОВА";
    var podlozhka = findNonEmptyCompByName("подложка");
    if (!podlozhka) return "ERROR: comp not found: подложка";

    // --- Шаг A: длительность 206с — все композиции проекта (comp.duration
    // расширять безопасно всегда, никакой контент этим не двигается) +
    // "сквозные" (не поблочные) слои основы (день/неделя/анимашка/погода/
    // город/подложка), у них сейчас outPoint=126, без продления погаснут
    // после 126с. Заодно — обёртка ОСНОВА внутри MASTER, если найдётся
    // (сама MASTER и её маска, которая пользователю нужна лично, — не
    // трогаем вообще, только outPoint слоя-ссылки на ОСНОВА). ---
    app.beginUndoGroup("Реструктуризация: шаг A — длительность 206с");
    try {
        if (osnova.duration < NEW_TOTAL_DURATION) osnova.duration = NEW_TOTAL_DURATION;
        for (var pi = 1; pi <= app.project.numItems; pi++) {
            var pItem = app.project.item(pi);
            if (pItem instanceof CompItem && pItem.duration < NEW_TOTAL_DURATION) {
                pItem.duration = NEW_TOTAL_DURATION;
            }
        }
        var throughNames = ["день месяц", "неделя", "анимашка", "погода", "город", "подложка"];
        for (var ti = 0; ti < throughNames.length; ti++) {
            var tl = findLayerByName(osnova, throughNames[ti]);
            if (tl && tl.outPoint < NEW_TOTAL_DURATION) tl.outPoint = NEW_TOTAL_DURATION;
        }
        var masterComp = findCompByName("MASTER");
        if (masterComp) {
            var osnovaInMaster = findLayerByName(masterComp, "ОСНОВА");
            if (osnovaInMaster && osnovaInMaster.outPoint < NEW_TOTAL_DURATION) osnovaInMaster.outPoint = NEW_TOTAL_DURATION;
        }
        report.push("A: длительность продлена до " + NEW_TOTAL_DURATION + "с (все композиции + сквозные слои)");
    } catch (eA) {
        app.endUndoGroup();
        return "ERROR (шаг A): " + eA.toString();
    }
    app.endUndoGroup();

    // --- Шаг B: убрать заголовок новостей — новости в новой схеме
    // начинаются сразу с контента, отдельного блока-шапки нет. ---
    app.beginUndoGroup("Реструктуризация: шаг B — убрать заголовок новостей");
    try {
        var newsHeaderLayer = findLayerByName(osnova, "Шапка новости текст");
        if (newsHeaderLayer) newsHeaderLayer.enabled = false;
        var newsHeaderPlate = findLayerByName(podlozhka, "шапка новости");
        if (newsHeaderPlate) newsHeaderPlate.enabled = false;
        report.push("B: заголовок новостей отключён");
    } catch (eB) {
        app.endUndoGroup();
        return report.join(" | ") + " || ERROR (шаг B): " + eB.toString();
    }
    app.endUndoGroup();

    // --- Шаг C: новые окна существующих блоков (именины/валюта). "новости
    // текст" и её плашка "новости основа 5" держат ВЕСЬ блок новостей
    // целиком (включая расщеплённую "новость 1" — хвост у начала, голова у
    // конца композиции), поэтому их окно — 0..206 целиком, а не только
    // 0..78 (иначе голова на 204-206 не отрендерится вообще). Остальные —
    // точно под свой блок. ---
    app.beginUndoGroup("Реструктуризация: шаг C — новые окна блоков (именины/валюта)");
    try {
        var newsTextLayer = findLayerByName(osnova, "новости текст");
        if (newsTextLayer) setLayerTimingSafe(newsTextLayer, 0, NEW_TOTAL_DURATION);
        setLayerTimingSafe(findOrThrow(osnova, "шапка др текст"), 78, 80);
        setLayerTimingSafe(findOrThrow(osnova, "др текст"), 80, 96);
        setLayerTimingSafe(findOrThrow(osnova, "шапка валюта текст"), 96, 98);
        setLayerTimingSafe(findOrThrow(osnova, "валюта"), 98, 106);

        var newsPlate = findLayerByName(podlozhka, "новости основа 5");
        if (newsPlate) setLayerTimingSafe(newsPlate, 0, NEW_TOTAL_DURATION);
        setLayerTimingSafe(findOrThrow(podlozhka, "шапка др"), 78, 80);
        setLayerTimingSafe(findOrThrow(podlozhka, "новости основа 3"), 80, 96);
        setLayerTimingSafe(findOrThrow(podlozhka, "шапка курс валют"), 96, 98);
        setLayerTimingSafe(findOrThrow(podlozhka, "новости основа 4"), 98, 106);
        report.push("C: окна блоков пересчитаны (именины 78-96, валюта 96-106)");
    } catch (eC) {
        app.endUndoGroup();
        return report.join(" | ") + " || ERROR (шаг C): " + eC.toString();
    }
    app.endUndoGroup();

    // --- Шаг D: "новость 1" — расщепление на хвост (0-6, в начале
    // композиции) и голову (204-206, в конце) — 2 отдельных слоя с
    // одинаковым текстом (см. applyNewsItems — синхронизация текста уже
    // добавлена туда), без анимации перехода между ними. Новости 2-10 —
    // сдвигаются на новую сетку (6 + (i-2)*8 .. 6 + (i-1)*8). ---
    app.beginUndoGroup("Реструктуризация: шаг D — новость 1 (хвост/голова) + сдвиг новостей");
    try {
        var newsTextComp = findCompByName("новости текст");
        if (!newsTextComp) throw new Error("comp not found: новости текст");

        var n1 = findOrThrow(newsTextComp, "новость 1");
        setLayerTimingSafe(n1, 0, NEWS_TAIL_DUR);

        var n1head = findLayerByName(newsTextComp, "новость 1_head");
        if (!n1head) {
            n1head = n1.duplicate();
            n1head.name = "новость 1_head";
        }
        setLayerTimingSafe(n1head, NEW_TOTAL_DURATION - NEWS_HEAD_DUR, NEW_TOTAL_DURATION);

        for (var ni = 2; ni <= NEWS_ITEM_COUNT; ni++) {
            var li = findLayerByName(newsTextComp, "новость " + ni);
            if (!li) { report.push("D: слой 'новость " + ni + "' не найден"); continue; }
            var inT = NEWS_TAIL_DUR + (ni - 2) * NEWS_ITEM_DUR;
            var outT = NEWS_TAIL_DUR + (ni - 1) * NEWS_ITEM_DUR;
            setLayerTimingSafe(li, inT, outT);
        }
        report.push("D: новость 1 расщеплена (0-" + NEWS_TAIL_DUR + " / " +
            (NEW_TOTAL_DURATION - NEWS_HEAD_DUR) + "-" + NEW_TOTAL_DURATION +
            "), новости 2-10 сдвинуты на 8с/шт");
    } catch (eD) {
        app.endUndoGroup();
        return report.join(" | ") + " || ERROR (шаг D): " + eD.toString();
    }
    app.endUndoGroup();

    // --- Шаг E: именины 10 → 2. Оставляем "Др 1"/"Др 2", остальные
    // удаляем (вместе с их "_2"-партнёрами по 2-строчной раскладке). ---
    app.beginUndoGroup("Реструктуризация: шаг E — именины 10 → 2");
    try {
        var bdayComp = findCompByName("др текст");
        if (!bdayComp) throw new Error("comp not found: др текст");

        setLayerTimingSafe(findOrThrow(bdayComp, "Др 1"), 80, 88);
        setLayerTimingSafe(findOrThrow(bdayComp, "Др 2"), 88, 96);
        for (var di = 3; di <= 10; di++) {
            removeLayersByPrefix(bdayComp, "Др " + di);
        }
        report.push("E: именины сокращены до 2 (80-88 / 88-96), Др3-10 удалены");
    } catch (eE) {
        app.endUndoGroup();
        return report.join(" | ") + " || ERROR (шаг E): " + eE.toString();
    }
    app.endUndoGroup();

    // --- Шаг F: новый блок "гороскоп" — шапка (106-108, "ГОРОСКОП",
    // клон стиля "ИМЕНИНЫ") + 12 контентных слоёв (108-204, клон стиля
    // "Др N") + слои на уровне ОСНОВА (поз/масштаб как у "др текст"/"шапка
    // др текст") + плашки-фон в "подложка" (дубликаты уже существующих). ---
    app.beginUndoGroup("Реструктуризация: шаг F — новый блок «гороскоп»");
    try {
        var drTextComp = findCompByName("др текст");
        var shapkaDrComp = findCompByName("шапка др текст");
        var drTextLayerInOsnova = findOrThrow(osnova, "др текст");
        var shapkaDrLayerInOsnova = findOrThrow(osnova, "шапка др текст");
        if (!drTextComp) throw new Error("comp not found: др текст");
        if (!shapkaDrComp) throw new Error("comp not found: шапка др текст");

        var HOROSCOPE_CONTENT_START = 108;
        var HOROSCOPE_CONTENT_END = HOROSCOPE_CONTENT_START + HOROSCOPE_ITEM_COUNT * HOROSCOPE_ITEM_DUR; // 204
        var SHAPKA_GOROSKOP_START = HOROSCOPE_CONTENT_START - HOROSCOPE_HEADER_DUR; // 106

        // --- содержимое: 12 слоёв-клонов стиля "Др N" ---
        var goroskopComp = ensureSlotComp("гороскоп текст", drTextComp.width, drTextComp.height, NEW_TOTAL_DURATION);
        if (!findLayerByName(goroskopComp, "Гороскоп 1")) {
            var exemplarDr = findOrThrow(drTextComp, "Др 1");
            var copiedExemplar = exemplarDr.copyToComp(goroskopComp);
            copiedExemplar.name = "exemplar_гороскоп";
            var placeholderItems = [];
            for (var pi2 = 0; pi2 < HOROSCOPE_ITEM_COUNT; pi2++) placeholderItems.push(null);
            var buildRes = buildSequentialLayersByDuplication(
                goroskopComp, placeholderItems, HOROSCOPE_ITEM_DUR,
                HOROSCOPE_CONTENT_START, "Гороскоп ", "Гороскоп"
            );
            if (!buildRes.ok) throw new Error("buildSequentialLayersByDuplication (гороскоп): " + buildRes.message);
        }

        // --- шапка: клон стиля "ИМЕНИНЫ" -> текст "ГОРОСКОП" ---
        var shapkaGoroskopComp = ensureSlotComp("шапка гороскоп текст", shapkaDrComp.width, shapkaDrComp.height, NEW_TOTAL_DURATION);
        var goroskopCaption = findFirstTextLayerIn(shapkaGoroskopComp);
        if (!goroskopCaption) {
            var exemplarShapka = findFirstTextLayerIn(shapkaDrComp);
            if (!exemplarShapka) throw new Error("эталонный текстовый слой не найден в 'шапка др текст'");
            goroskopCaption = exemplarShapka.copyToComp(shapkaGoroskopComp);
            goroskopCaption.name = "ГОРОСКОП";
            var textProp = goroskopCaption.property("Source Text");
            var doc = textProp.value;
            doc.text = "ГОРОСКОП";
            textProp.setValue(doc);
            var rect = goroskopCaption.sourceRectAtTime(0, false);
            goroskopCaption.property("Anchor Point").setValue([rect.left + rect.width / 2, rect.top + rect.height / 2]);
        }

        // --- слои на уровне ОСНОВА (та же поз/якорь/масштаб, что у
        // "др текст"/"шапка др текст") ---
        var goroskopLayer = ensureLayerLikeReference(osnova, goroskopComp, drTextLayerInOsnova);
        var shapkaGoroskopLayer = ensureLayerLikeReference(osnova, shapkaGoroskopComp, shapkaDrLayerInOsnova);
        setLayerTimingSafe(goroskopLayer, HOROSCOPE_CONTENT_START, HOROSCOPE_CONTENT_END);
        setLayerTimingSafe(shapkaGoroskopLayer, SHAPKA_GOROSKOP_START, HOROSCOPE_CONTENT_START);

        // --- плашки-фон в "подложка" — дубликаты уже существующих ---
        var shapkaDrPlate = findOrThrow(podlozhka, "шапка др");
        var contentPlateRef = findOrThrow(podlozhka, "новости основа 3");

        var shapkaGoroskopPlate = findLayerByName(podlozhka, "шапка гороскоп");
        if (!shapkaGoroskopPlate) {
            shapkaGoroskopPlate = shapkaDrPlate.duplicate();
            shapkaGoroskopPlate.name = "шапка гороскоп";
        }
        setLayerTimingSafe(shapkaGoroskopPlate, SHAPKA_GOROSKOP_START, HOROSCOPE_CONTENT_START);

        var goroskopContentPlate = findLayerByName(podlozhka, "гороскоп основа");
        if (!goroskopContentPlate) {
            goroskopContentPlate = contentPlateRef.duplicate();
            goroskopContentPlate.name = "гороскоп основа";
        }
        setLayerTimingSafe(goroskopContentPlate, HOROSCOPE_CONTENT_START, HOROSCOPE_CONTENT_END);

        report.push("F: блок «гороскоп» создан (" + SHAPKA_GOROSKOP_START + "-" + HOROSCOPE_CONTENT_START +
            " шапка, " + HOROSCOPE_CONTENT_START + "-" + HOROSCOPE_CONTENT_END + " контент x12)");
    } catch (eF) {
        app.endUndoGroup();
        return report.join(" | ") + " || ERROR (шаг F): " + eF.toString();
    }
    app.endUndoGroup();

    // --- Шаг H: погода под новый хронометраж. Чистим старые "_rK"-повторы
    // (посчитаны под старый цикл 20.52с/126с — с новым WEATHER_CITY_BOUNDS
    // (45с/206с) они не соответствуют новой раскладке и будут визуально
    // дублироваться поверх новых), затем переставляем 6 базовых слоёв
    // "город" (источник истины тайминга) на новые границы. "погода"/
    // "анимашка" (текст/иконка + repeats) пересоберутся автоматически при
    // следующем нажатии "Обновить погоду" в панели — эта функция уже
    // читает WEATHER_CITY_BOUNDS и osnova.duration, трогать её не нужно. ---
    app.beginUndoGroup("Реструктуризация: шаг H — погода под новый хронометраж (7.5с/город)");
    try {
        var cityComp = findOrThrow2(findCompByName("город"), "город");
        var tempComp = findOrThrow2(findCompByName("погода"), "погода");
        var iconComp = findOrThrow2(findCompByName("анимашка"), "анимашка");

        var repeatRe = /_r\d+$/;
        removeLayersMatchingRegex(cityComp, repeatRe);
        removeLayersMatchingRegex(tempComp, repeatRe);
        removeLayersMatchingRegex(iconComp, repeatRe);

        var wcb = weatherCityBounds();
        for (var wi = 0; wi < WEATHER_CITY_NAMES.length; wi++) {
            var cLayer = findLayerByNameLoose(cityComp, WEATHER_CITY_NAMES[wi]);
            if (!cLayer) { report.push("H: слой города не найден: " + WEATHER_CITY_NAMES[wi]); continue; }
            setLayerTimingSafe(cLayer, wcb[wi], wcb[wi + 1]);
        }
        report.push("H: погода пересчитана под 7.5с/город (45с цикл) — нажми «Обновить погоду» в панели, чтобы досчитать погода/анимашка и повторы под 206с");
    } catch (eH) {
        app.endUndoGroup();
        return report.join(" | ") + " || ERROR (шаг H): " + eH.toString();
    }
    app.endUndoGroup();

    // --- Шаг I: маркеры — безусловно чистим все старые, ставим новые по
    // границам блоков. ---
    app.beginUndoGroup("Реструктуризация: шаг I — маркеры");
    try {
        var mp = osnova.markerProperty;
        while (mp.numKeys > 0) mp.removeKey(1);

        var markers = [];
        markers.push([0, "Новость 1 (хвост)"]);
        for (var mni = 2; mni <= NEWS_ITEM_COUNT; mni++) {
            markers.push([NEWS_TAIL_DUR + (mni - 2) * NEWS_ITEM_DUR, "Новость " + mni]);
        }
        markers.push([78, "Шапка Именины"]);
        markers.push([80, "Именины 1"]);
        markers.push([88, "Именины 2"]);
        markers.push([96, "Шапка Валюта"]);
        markers.push([98, "Валюта"]);
        markers.push([106, "Шапка Гороскоп"]);
        for (var mhi = 1; mhi <= HOROSCOPE_ITEM_COUNT; mhi++) {
            markers.push([108 + (mhi - 1) * HOROSCOPE_ITEM_DUR, "Гороскоп " + mhi]);
        }
        markers.push([NEW_TOTAL_DURATION - NEWS_HEAD_DUR, "Новость 1 (голова)"]);

        for (var mi = 0; mi < markers.length; mi++) {
            mp.setValueAtTime(markers[mi][0], new MarkerValue(markers[mi][1]));
        }
        report.push("I: маркеры пересозданы (" + markers.length + " шт.)");
    } catch (eI) {
        app.endUndoGroup();
        return report.join(" | ") + " || ERROR (шаг I): " + eI.toString();
    }
    app.endUndoGroup();

    return "OK: " + report.join(" | ");
}

// Мелкий хелпер только для шага H — findCompByName уже мог вернуть null,
// а findOrThrow ожидает готовый comp (не имя) для единообразия сообщения.
function findOrThrow2(compOrNull, name) {
    if (!compOrNull) throw new Error("comp not found: " + name);
    return compOrNull;
}
