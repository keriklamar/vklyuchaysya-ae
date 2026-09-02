// ============================================================
// build_template.jsx (v7)
// Запускать через File → Scripts → Run Script File...
//
// АРХИТЕКТУРА v7:
// - SHAPES_BASE — отдельная композиция с 4 подложками, координаты
//   которых взяты 1-в-1 из реального layer_geometry.json пользователя
//   (position - anchorPoint + sourceRect). Зафиксированы НАВСЕГДА,
//   никогда не двигаются и не зависят от текста/иконок.
// - Сегмент "bg_deg" (92px, между +20 и новостью) — это на самом
//   деле место под ИКОНКУ погоды (в оригинале там был иконочный
//   шрифт, символ "0"), а не под текст градуса.
// - Контент (город/температура/иконка/новость) кладётся ПОВЕРХ
//   SHAPES_BASE отдельным слоем — сам он подложек не содержит.
// ============================================================

var FPS = 50;
var CYCLE_SEC = 200;
var W = 1920, H = 1080;
var FADE_SEC = 0.4;

var ICON_NAMES = [
    "icon_clear", "icon_cloudy", "icon_overcast", "icon_rain",
    "icon_storm", "icon_snow", "icon_fog", "icon_wind"
];
var CITY_PLACEHOLDERS = ["Минск", "Брест", "Витебск", "Гомель", "Гродно", "Могилев"];

var SCRIPT_FILE = new File($.fileName);
var ICONS_FOLDER = SCRIPT_FILE.parent.fsName + "/icons/";

// Точные прямоугольники подложек (обновлено по layer_geometry.json v2)
var SHAPES = [
    { name: "bg_city", x: 380.05, y: 941.55, w: 297, h: 91, color: [0.98, 0.98, 1.0] },
    { name: "bg_temp", x: 677.08, y: 941.55, w: 146, h: 91, color: [0.25, 0.62, 0.93] },
    { name: "bg_icon", x: 811.77, y: 941.55, w: 102, h: 91, color: [0.20, 0.55, 0.88] },
    { name: "bg_news", x: 916.13, y: 942.19, w: 769, h: 89, color: [0.90, 0.91, 0.94] }
];

// Целевые ЦЕНТРЫ элементов (из layer_geometry.json — там anchorPoint
// совпадает с центром содержимого нест-композиций, т.е. position = центр)
var ICON_POS = [862.68, 990.43];
var TEMP_TEXT_POS = [745.84, 987.97];
var CITY_TEXT_POS = [526.75, 988.34];
var NEWS_TEXT_POS = [1296.97, 988.08];

// Центрирует текстовый слой на targetPos независимо от длины текста —
// anchor point вычисляется из реального bounding box (sourceRectAtTime).
function centerTextLayer(layer, targetPos) {
    var rect = layer.sourceRectAtTime(0, false);
    layer.property("Anchor Point").setValue([rect.left + rect.width / 2, rect.top + rect.height / 2]);
    layer.property("Position").setValue(targetPos);
}

function removeExistingComp(name) {
    for (var i = app.project.numItems; i >= 1; i--) {
        var item = app.project.item(i);
        if (item instanceof CompItem && item.name === name) item.remove();
    }
}

function importIcons() {
    var map = {};
    for (var i = 0; i < ICON_NAMES.length; i++) {
        var name = ICON_NAMES[i];
        var f = new File(ICONS_FOLDER + name + ".svg");
        if (!f.exists) { alert("Не найден файл иконки: " + f.fsName); continue; }
        map[name] = app.project.importFile(new ImportOptions(f));
    }
    return map;
}

// --- SHAPES_BASE: подложки, зафиксированы навсегда --------------

function buildShapesBase() {
    removeExistingComp("SHAPES_BASE");
    var comp = app.project.items.addComp("SHAPES_BASE", W, H, 1, CYCLE_SEC, FPS);
    for (var i = 0; i < SHAPES.length; i++) {
        var s = SHAPES[i];
        var solid = comp.layers.addSolid(s.color, s.name, s.w, s.h, 1, CYCLE_SEC);
        solid.name = s.name;
        solid.property("Anchor Point").setValue([s.w / 2, s.h / 2]);
        solid.property("Position").setValue([s.x + s.w / 2, s.y + s.h / 2]);
    }
    return comp;
}

// --- ПОГОДА: только контент, без подложек ------------------------

function createWeatherCard(index, iconFootage) {
    var duration = CYCLE_SEC / 6;
    var name = "Card_Weather_0" + index;
    removeExistingComp(name);
    var comp = app.project.items.addComp(name, W, H, 1, duration, FPS);

    for (var i = 0; i < ICON_NAMES.length; i++) {
        var iconName = ICON_NAMES[i];
        if (!iconFootage[iconName]) continue;
        var layer = comp.layers.add(iconFootage[iconName]);
        layer.name = iconName;
        layer.property("Anchor Point").setValue([100, 100]); // центр viewBox 200x200
        layer.property("Position").setValue(ICON_POS);
        layer.property("Scale").setValue([40, 40, 100]);
        layer.enabled = (i === 0);
    }

    var cityLayer = comp.layers.addText(CITY_PLACEHOLDERS[index - 1]);
    cityLayer.name = "txt_city";
    var cityDoc = cityLayer.property("Source Text").value;
    cityDoc.fontSize = 32;
    cityDoc.fillColor = [0.13, 0.35, 0.78];
    cityDoc.font = "ArialMT";
    cityLayer.property("Source Text").setValue(cityDoc);
    centerTextLayer(cityLayer, CITY_TEXT_POS);

    var tempLayer = comp.layers.addText("+20°");
    tempLayer.name = "txt_temp";
    var tempDoc = tempLayer.property("Source Text").value;
    tempDoc.fontSize = 40;
    tempDoc.fillColor = [1, 1, 1];
    tempDoc.font = "ArialMT";
    tempLayer.property("Source Text").setValue(tempDoc);
    centerTextLayer(tempLayer, TEMP_TEXT_POS);

    return comp;
}

function buildWeatherLane(cardComps, cardDuration) {
    removeExistingComp("LANE_WEATHER");
    var laneComp = app.project.items.addComp("LANE_WEATHER", W, H, 1, CYCLE_SEC, FPS);
    var startTime = 0;
    for (var i = 0; i < cardComps.length; i++) {
        var layer = laneComp.layers.add(cardComps[i]);
        layer.startTime = startTime;
        layer.inPoint = startTime;
        layer.outPoint = startTime + cardDuration;

        var opacity = layer.property("Opacity");
        if (i === 0) {
            opacity.setValue(100);
        } else {
            opacity.setValueAtTime(startTime, 0);
            opacity.setValueAtTime(startTime + FADE_SEC, 100);
        }
        opacity.setValueAtTime(startTime + cardDuration - FADE_SEC, 100);
        opacity.setValueAtTime(startTime + cardDuration, 0);

        startTime += cardDuration;
    }
    return laneComp;
}

// --- НОВОСТИ: только текст, без подложки -------------------------

function buildNewsLane(placeholderNews) {
    for (var c = 1; c <= 10; c++) {
        removeExistingComp("Card_News_" + (c < 10 ? "0" + c : c));
    }
    removeExistingComp("LANE_NEWS");

    var laneComp = app.project.items.addComp("LANE_NEWS", W, H, 1, CYCLE_SEC, FPS);

    var newsLayer = laneComp.layers.addText(placeholderNews[0] || "Новость");
    newsLayer.name = "txt_news";
    var newsDoc = newsLayer.property("Source Text").value;
    newsDoc.fontSize = 30;
    newsDoc.fillColor = [0.05, 0.06, 0.1];
    newsDoc.font = "ArialMT";
    newsDoc.justification = ParagraphJustification.CENTER_JUSTIFY;
    newsLayer.property("Source Text").setValue(newsDoc);
    centerTextLayer(newsLayer, NEWS_TEXT_POS);

    var sourceTextProp = newsLayer.property("Source Text");
    for (var i = 0; i < 10; i++) {
        var doc = sourceTextProp.value;
        doc.text = placeholderNews[i] || ("Новость " + (i + 1));
        sourceTextProp.setValueAtTime(i * 20, doc);
    }

    var opacity = newsLayer.property("Opacity");
    opacity.setValue(100);
    for (var j = 1; j < 10; j++) {
        var t = j * 20;
        opacity.setValueAtTime(t - FADE_SEC, 100);
        opacity.setValueAtTime(t, 0);
        opacity.setValueAtTime(t + FADE_SEC, 100);
    }
    opacity.setValueAtTime(200 - FADE_SEC, 100);

    return laneComp;
}

function main() {
    app.beginUndoGroup("AutoPogoda: сборка шаблона (v7)");

    var shapesBase = buildShapesBase();
    var iconFootage = importIcons();

    var weatherComps = [];
    for (var w = 1; w <= 6; w++) weatherComps.push(createWeatherCard(w, iconFootage));
    var laneWeather = buildWeatherLane(weatherComps, CYCLE_SEC / 6);

    var placeholderNews = [
        "Новость 1", "Новость 2", "Новость 3", "Новость 4", "Новость 5",
        "Новость 6", "Новость 7", "Новость 8", "Новость 9", "Новость 10"
    ];
    var laneNews = buildNewsLane(placeholderNews);

    removeExistingComp("MASTER");
    var master = app.project.items.addComp("MASTER", W, H, 1, CYCLE_SEC, FPS);
    master.layers.add(shapesBase); // подложки первыми — останутся самым нижним слоем
    master.layers.add(laneWeather);
    master.layers.add(laneNews);

    app.endUndoGroup();

    alert("Готово (v7)!\n- SHAPES_BASE зафиксирована навсегда, отдельно от контента\n" +
          "- Погода/новости — только текст и иконка поверх\n" +
          "- Координаты 1-в-1 из твоего layer_geometry.json");
}

main();
