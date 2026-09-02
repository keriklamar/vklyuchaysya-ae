// ============================================================
// place_markers.jsx — РАЗОВЫЙ скрипт разметки маркеров.
//
// На таймлайнах композиций «ОСНОВА» и «ОСНОВА без др»:
//   1) сносит ВСЕ существующие маркеры;
//   2) ставит по маркеру на старт каждой новости («Новость 1».. «Новость 6»)
//      и каждого пункта гороскопа («Гороскоп 1».. «Гороскоп 12»).
// Времена берутся из реальной раскладки: слой-инстанс блока на ОСНОВА
// (его startTime) + inPoint пункта внутри исходной композиции
// («новости текст» / «гороскоп текст»).
//
// Дополнительно: пишет в лог список футажа проекта (для проверки, что
// ничего не ссылается на папку Graph\1 перед её удалением) и в конце
// сохраняет проект (app.project.save()).
//
// Запуск: File → Scripts → Run Script File...
// Лог: C:\Users\<user>\Documents\ae-mcp-bridge\frames\markers_report.txt
// ============================================================
(function () {
    var LOG_PATH = Folder.myDocuments.fsName + "/ae-mcp-bridge/frames/markers_report.txt";
    var log = [];
    function L(s) { log.push(s); }
    function flush() {
        try {
            var dir = new File(LOG_PATH).parent;
            if (!dir.exists) dir.create();
            var f = new File(LOG_PATH);
            f.encoding = "UTF-8";
            f.open("w");
            f.write(log.join("\n"));
            f.close();
        } catch (e) { /* лог не критичен */ }
    }

    function findCompByName(name) {
        var best = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === name) {
                if (!best || it.numLayers > best.numLayers) best = it;
            }
        }
        return best;
    }

    // Слой-инстанс блока на таймлайне ОСНОВА, чей источник — композиция
    // srcName. Если их несколько (напр. «новости текст первая новость» —
    // тоже инстанс «новости текст») — берём с самым длинным окном
    // (основной блок, а не 2-секундная голова петли).
    function findBlockInstance(osnova, srcName) {
        var best = null, bestLen = -1;
        for (var i = 1; i <= osnova.numLayers; i++) {
            var l = osnova.layer(i);
            if (l.source && (l.source instanceof CompItem) && l.source.name === srcName) {
                var len = l.outPoint - l.inPoint;
                if (len > bestLen) { bestLen = len; best = l; }
            }
        }
        return best;
    }

    // Пункты внутри исходной композиции: слои строго «<word> <число>»
    // (исключаем «новость 1_эталон» / «_верхняя» / «_нижняя» и фон).
    function collectItems(srcComp, re) {
        var items = [];
        for (var i = 1; i <= srcComp.numLayers; i++) {
            var l = srcComp.layer(i);
            var m = re.exec(l.name);
            if (!m) continue;
            items.push({ n: parseInt(m[1], 10), inPoint: l.inPoint, name: l.name });
        }
        items.sort(function (a, b) { return a.inPoint - b.inPoint; });
        return items;
    }

    // Возвращает массив [{ t, label }] для одного блока.
    function blockMarkers(osnova, srcName, itemRe, labelPrefix) {
        var inst = findBlockInstance(osnova, srcName);
        if (!inst) { L("    !!! в «" + osnova.name + "» нет слоя-инстанса «" + srcName + "»"); return []; }
        var srcComp = inst.source;
        var items = collectItems(srcComp, itemRe);
        if (!items.length) { L("    !!! в «" + srcName + "» не найдено пунктов по маске " + itemRe); return []; }
        L("    инстанс «" + inst.name + "»: start " + inst.startTime.toFixed(3) +
          ", in " + inst.inPoint.toFixed(3) + ", out " + inst.outPoint.toFixed(3) +
          "  | пунктов в источнике: " + items.length);
        var out = [];
        for (var k = 0; k < items.length; k++) {
            var t = items[k].inPoint + inst.startTime;
            if (t < inst.inPoint) t = inst.inPoint;   // голова первого пункта подрезана инстансом
            if (t >= inst.outPoint - 0.001) { L("    (пропуск " + labelPrefix + " " + items[k].n + " — за пределами окна блока)"); continue; }
            out.push({ t: t, label: labelPrefix + " " + items[k].n });
        }
        return out;
    }

    function placeOn(osnova) {
        L("=== " + osnova.name + " (id " + osnova.id + ", " + osnova.duration.toFixed(2) + "с) ===");
        var mp = osnova.markerProperty;
        var removed = 0;
        while (mp.numKeys > 0) { mp.removeKey(1); removed++; }
        L("  снято старых маркеров: " + removed);

        var markers = [];
        L("  Новости:");
        markers = markers.concat(blockMarkers(osnova, "новости текст", /^новость\s+(\d+)$/i, "Новость"));
        L("  Гороскоп:");
        markers = markers.concat(blockMarkers(osnova, "гороскоп текст", /^гороскоп\s+(\d+)$/i, "Гороскоп"));

        markers.sort(function (a, b) { return a.t - b.t; });
        for (var i = 0; i < markers.length; i++) {
            mp.setValueAtTime(markers[i].t, new MarkerValue(markers[i].label));
        }
        L("  поставлено маркеров: " + markers.length);
        for (var j = 0; j < markers.length; j++) {
            L("    " + markers[j].t.toFixed(3) + "с  →  " + markers[j].label);
        }
        return markers.length;
    }

    function dumpFootage() {
        L("");
        L("=== ФУТАЖ ПРОЕКТА (проверка ссылок перед чисткой Graph\\1) ===");
        var any = false;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (!(it instanceof FootageItem)) continue;
            var src = it.mainSource;
            var path = "";
            try { if (it.file) path = it.file.fsName; } catch (e) {}
            if (src instanceof SolidSource) continue;
            any = true;
            L("  " + it.name + "  |  missing=" + it.footageMissing + "  |  " + (path || "(нет файла)"));
        }
        if (!any) L("  (файлового футажа нет)");
    }

    // --- запуск ---
    L("=== place_markers.jsx :: " + new Date().toString() + " ===");
    var total = 0;
    var names = ["ОСНОВА", "ОСНОВА без др"];
    app.beginUndoGroup("Разметка маркеров (новости + гороскоп)");
    try {
        for (var i = 0; i < names.length; i++) {
            var c = findCompByName(names[i]);
            if (!c) { L("=== " + names[i] + " — НЕТ такой композиции, пропуск ==="); continue; }
            total += placeOn(c);
        }
        dumpFootage();
        app.endUndoGroup();
    } catch (e) {
        L("!!! ФАТАЛЬНО: " + e.toString() + (e.line ? (" (line " + e.line + ")") : ""));
        flush();
        app.endUndoGroup();
        alert("ОШИБКА: " + e.toString() + "\nЛог: " + LOG_PATH);
        return;
    }

    // --- сохранить проект ---
    var saved = false;
    try {
        if (app.project.file) { app.project.save(); saved = true; L(""); L("проект сохранён: " + app.project.file.fsName); }
        else { L(""); L("!!! проект без файла — сохрани вручную (File → Save)"); }
    } catch (eS) { L(""); L("!!! save() не сработал: " + eS.toString()); }

    flush();
    alert("Готово.\n\nМаркеров поставлено всего: " + total +
          "\nПроект " + (saved ? "сохранён" : "НЕ сохранён — сохрани вручную") +
          "\n\nЛог: " + LOG_PATH);
})();
