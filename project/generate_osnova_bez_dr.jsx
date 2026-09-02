// ============================================================
// generate_osnova_bez_dr.jsx — РАЗОВЫЙ генератор (v2, с логом).
// Создаёт «ОСНОВА без др» + «подложка без др»: полные копии текущих
// «ОСНОВА» / «подложка» без блока «др» (ни текста, ни плашки),
// со сдвигом валюты/гороскопа/хвоста влево и укорочением компа.
//
// Запуск: File → Scripts → Run Script File...
// ПЕРЕД: в панели «Включайся!» нажать «Сбросить переходы».
//
// Подробный лог: C:\Users\<user>\Documents\ae-mcp-bridge\frames\gen_report.txt
// ============================================================
(function () {
    var DR_HEADER_TEXT = "шапка др текст";
    var DR_CONTENT_TEXT = "др текст";
    var DR_HEADER_PLATE = "шапка др";
    var DR_CONTENT_PLATE = "подложка др";
    var VAL_HEADER = "курсы валют текст";

    var LOG_PATH = Folder.myDocuments.fsName + "/ae-mcp-bridge/frames/gen_report.txt";
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
    function step(name, fn) {
        try { fn(); L("OK  " + name); }
        catch (e) { L("!!! FAIL " + name + " -> " + e.toString() + (e.line ? (" (line " + e.line + ")") : "")); }
        flush();
    }

    function findCompByName(name, wantNonEmpty) {
        var best = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === name) {
                if (!wantNonEmpty) return it;
                if (!best || it.numLayers > best.numLayers) best = it;
            }
        }
        return best;
    }
    function layerNames(comp) {
        var a = [];
        for (var i = 1; i <= comp.numLayers; i++) a.push(comp.layer(i).name);
        return a.join(" | ");
    }
    function findLayer(comp, name) {
        for (var i = 1; i <= comp.numLayers; i++) if (comp.layer(i).name === name) return comp.layer(i);
        return null;
    }
    function removeLayerByName(comp, name) {
        var n = 0;
        for (var i = comp.numLayers; i >= 1; i--) if (comp.layer(i).name === name) { comp.layer(i).remove(); n++; }
        return n;
    }
    function firstPosKeyedLayer(comp) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var p = comp.layer(i).property("Position");
            if (p && p.numKeys > 0) return comp.layer(i).name + " (" + p.numKeys + " кл.)";
        }
        return null;
    }
    // Сдвигает влево на delta все слои с inPoint >= threshold. Сохраняет
    // (inPoint - startTime) => источник-контент не «съезжает».
    function shiftAfter(comp, threshold, delta) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var l = comp.layer(i);
            if (l.inPoint >= threshold - 0.01) {
                var oi = l.inPoint, oo = l.outPoint, os = l.startTime;
                try {
                    l.startTime = os - delta;
                    L("    сдвиг " + l.name + ": in " + oi.toFixed(2) + "->" + l.inPoint.toFixed(2) +
                      ", out " + oo.toFixed(2) + "->" + l.outPoint.toFixed(2) +
                      ", start " + os.toFixed(2) + "->" + l.startTime.toFixed(2));
                } catch (e) {
                    L("    !!! сдвиг " + l.name + " FAIL -> " + e.toString());
                }
            }
        }
    }

    L("=== generate_osnova_bez_dr v2 :: " + new Date().toString() + " ===");

    var osnova = findCompByName("ОСНОВА", false);
    if (!osnova) { L("НЕТ «ОСНОВА»"); flush(); alert("Нет композиции «ОСНОВА». Лог: " + LOG_PATH); return; }
    var podl = findCompByName("подложка", true);
    if (!podl) { L("НЕТ непустой «подложка»"); flush(); alert("Нет непустой «подложка». Лог: " + LOG_PATH); return; }
    L("ОСНОВА: " + osnova.numLayers + " сл, " + osnova.duration.toFixed(2) + "с  [" + layerNames(osnova) + "]");
    L("подложка(id): " + podl.numLayers + " сл, " + podl.duration.toFixed(2) + "с  [" + layerNames(podl) + "]");

    if (findCompByName("ОСНОВА без др", false) || findCompByName("подложка без др", false)) {
        L("Дубли уже существуют — выход.");
        flush();
        alert("«ОСНОВА без др» / «подложка без др» уже есть. Удали вручную и запусти снова.\nЛог: " + LOG_PATH);
        return;
    }

    var drH = findLayer(osnova, DR_HEADER_TEXT);
    var drVal = findLayer(osnova, VAL_HEADER);
    if (!drH) { L("НЕТ слоя «" + DR_HEADER_TEXT + "»"); flush(); alert("В «ОСНОВА» нет «" + DR_HEADER_TEXT + "». Лог: " + LOG_PATH); return; }
    if (!drVal) { L("НЕТ слоя «" + VAL_HEADER + "»"); flush(); alert("В «ОСНОВА» нет «" + VAL_HEADER + "». Лог: " + LOG_PATH); return; }

    var keyed = firstPosKeyedLayer(osnova) || firstPosKeyedLayer(podl);
    if (keyed) {
        L("Есть Position-ключи: " + keyed);
        flush();
        alert("Сначала нажми «Сбросить переходы» в панели «Включайся!».\nНайдено: " + keyed + "\nЛог: " + LOG_PATH);
        return;
    }

    var DRLEN = drVal.inPoint - drH.inPoint;
    var DR_END = drVal.inPoint;
    L("DRLEN = " + DRLEN.toFixed(4) + "с (drVal.in " + drVal.inPoint.toFixed(3) + " - drH.in " + drH.inPoint.toFixed(3) + ")");
    L("DR_END (порог сдвига) = " + DR_END.toFixed(4));
    if (DRLEN <= 0) { L("DRLEN <= 0 — выход"); flush(); alert("Странная длина блока др: " + DRLEN + "\nЛог: " + LOG_PATH); return; }

    var newOsnovaDur = osnova.duration - DRLEN;
    var newPodlDur = podl.duration - DRLEN;
    L("новые длительности: ОСНОВА " + newOsnovaDur.toFixed(3) + ", подложка " + newPodlDur.toFixed(3));

    var podlNew = null, oNew = null;
    app.beginUndoGroup("Создать «ОСНОВА без др»");
    try {
        // --- подложка без др ---
        step("1. подложка.duplicate()", function () {
            podlNew = podl.duplicate();
            podlNew.name = "подложка без др";
            L("    podlNew: " + podlNew.numLayers + " сл  [" + layerNames(podlNew) + "]");
        });
        step("2. удалить плашки др", function () {
            var a = removeLayerByName(podlNew, DR_HEADER_PLATE);
            var b = removeLayerByName(podlNew, DR_CONTENT_PLATE);
            L("    удалено: " + DR_HEADER_PLATE + " x" + a + ", " + DR_CONTENT_PLATE + " x" + b + "  -> " + podlNew.numLayers + " сл");
        });
        step("3. сдвиг слоёв подложки после DR_END", function () {
            shiftAfter(podlNew, DR_END, DRLEN);
            L("    после сдвига: " + podlNew.numLayers + " сл");
        });
        step("4. podlNew.duration", function () {
            var was = podlNew.numLayers;
            podlNew.duration = newPodlDur;
            L("    duration -> " + podlNew.duration.toFixed(3) + " ; слоёв " + was + " -> " + podlNew.numLayers);
        });

        // --- ОСНОВА без др ---
        step("5. ОСНОВА.duplicate()", function () {
            oNew = osnova.duplicate();
            oNew.name = "ОСНОВА без др";
            L("    oNew: " + oNew.numLayers + " сл  [" + layerNames(oNew) + "]");
        });
        step("6. подменить источник слоя «подложка»", function () {
            var pl = findLayer(oNew, "подложка");
            if (!pl) throw new Error("в копии ОСНОВА нет слоя «подложка»");
            pl.replaceSource(podlNew, false);
            L("    источник «подложка» -> " + pl.source.name);
        });
        step("7. удалить слои др-текста", function () {
            var a = removeLayerByName(oNew, DR_HEADER_TEXT);
            var b = removeLayerByName(oNew, DR_CONTENT_TEXT);
            L("    удалено: " + DR_HEADER_TEXT + " x" + a + ", " + DR_CONTENT_TEXT + " x" + b + "  -> " + oNew.numLayers + " сл  [" + layerNames(oNew) + "]");
        });
        step("8. сдвиг слоёв ОСНОВА после DR_END", function () {
            shiftAfter(oNew, DR_END, DRLEN);
            L("    после сдвига: " + oNew.numLayers + " сл");
        });
        step("9. oNew.duration", function () {
            var was = oNew.numLayers;
            oNew.duration = newOsnovaDur;
            L("    duration -> " + oNew.duration.toFixed(3) + " ; слоёв " + was + " -> " + oNew.numLayers + "  [" + layerNames(oNew) + "]");
        });

        L("--- ИТОГ ---");
        if (oNew) L("ОСНОВА без др: " + oNew.numLayers + " сл, " + oNew.duration.toFixed(2) + "с  [" + layerNames(oNew) + "]");
        if (podlNew) L("подложка без др: " + podlNew.numLayers + " сл, " + podlNew.duration.toFixed(2) + "с  [" + layerNames(podlNew) + "]");
        flush();

        app.endUndoGroup();
        alert("Готово (см. лог для деталей).\n\n" +
              "• ОСНОВА без др: " + (oNew ? oNew.numLayers : "?") + " сл, " + (oNew ? oNew.duration.toFixed(2) : "?") + "с\n" +
              "• подложка без др: " + (podlNew ? podlNew.numLayers : "?") + " сл, " + (podlNew ? podlNew.duration.toFixed(2) : "?") + "с\n\n" +
              "Лог: " + LOG_PATH);
    } catch (e) {
        L("!!! ФАТАЛЬНО: " + e.toString() + (e.line ? (" (line " + e.line + ")") : ""));
        flush();
        app.endUndoGroup();
        alert("ОШИБКА: " + e.toString() + "\nЛог: " + LOG_PATH + "\n\nОткати Ctrl+Z.");
    }
})();
